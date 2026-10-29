/* 클립보드 공유(cliprdr 채널) — 텍스트만 주고받는다.
 *  - 로컬 → 원격: Node가 로컬 클립보드가 바뀔 때마다 MSG_CLIPBOARD(UTF-8)로 보내 주면 저장해 두고, 서버에 "텍스트 있음"
 *    (Format List)을 알린다. 서버에서 붙여넣을 때 서버가 데이터를 요청하면(Format Data Request) 그때 UTF-16으로 보낸다.
 *  - 원격 → 로컬: 서버가 Format List를 보내면 곧바로 텍스트를 요청하고, 받은 데이터를 MSG_CLIPBOARD_REMOTE(UTF-8)로 Node에 넘긴다.
 * 파일 복사·붙여넣기(FileGroupDescriptorW + FileContents):
 *  - 로컬 → 원격: Node가 MSG_CLIP_FILES로 (폴더 포함) 파일 목록을 보내 주면 서버에 FileGroupDescriptorW를 알리고, 서버가 붙여넣을 때
 *    보내는 FileContents 요청(크기/구간)에 이 헬퍼가 로컬 파일을 직접 읽어 답한다.
 *  - 원격 → 로컬: 서버가 FileGroupDescriptorW를 알리면 목록을 받아 Node에 넘기고(MSG_REMOTE_FILES_BEGIN), 파일 내용을 구간별로
 *    요청해 MSG_REMOTE_FILE_CHUNK로 흘려 보낸다(끝나면 MSG_REMOTE_FILES_END). Node가 임시 폴더에 쓰고 로컬 클립보드에 올린다.
 *    총 크기·개수 상한(FILES_MAX_BYTES / FILES_MAX_COUNT)을 넘으면 받지 않는다.
 *
 * 콜백과 clip_poll()은 RDP 이벤트 루프를 도는 연결 스레드에서 불리고, clip_set_local_text()만 stdin 스레드에서 불린다. */

#include "compat.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <winpr/wtypes.h>
#include <winpr/string.h>
#include <winpr/user.h>
#include <winpr/shell.h>
#include <freerdp/channels/cliprdr.h>
#include <freerdp/client/cliprdr.h>

#include "clipboard.h"
#include "framing.h"

#define MSG_CLIPBOARD_REMOTE 0x86 /* helper -> Node: 원격 클립보드 텍스트(UTF-8) */
#define MSG_REMOTE_FILES_BEGIN 0x87 /* helper -> Node: 줄마다 "d\t크기\t상대경로\n" (d=1 폴더) */
#define MSG_REMOTE_FILE_CHUNK 0x88 /* helper -> Node: [u32 LE 항목 번호][파일 내용 조각] */
#define MSG_REMOTE_FILES_END 0x89 /* helper -> Node: [u8 결과] 1=완료 0=실패 2=상한 초과 */

#define FILE_GROUP_NAME "FileGroupDescriptorW"
#define FILE_GROUP_FORMAT_ID 0xC0F1 /* 우리가 서버에 알릴 때 쓰는 등록 형식 번호 */
#define FILES_MAX_BYTES (5ULL * 1024 * 1024 * 1024)
#define FILES_MAX_COUNT 2000
#define FILES_CHUNK 262144
#define DESC_SIZE 592 /* sizeof(FILEDESCRIPTORW) */
#define ATTR_DIRECTORY 0x10
#define ATTR_NORMAL 0x80

#ifdef _WIN32
static FILE* fopen_utf8(const char* p) {
	WCHAR* w = ConvertUtf8ToWCharAlloc(p, NULL);
	FILE* f = w ? _wfopen(w, L"rb") : NULL;
	free(w);
	return f;
}
#define fseek64 _fseeki64
#else
static FILE* fopen_utf8(const char* p) { return fopen(p, "rb"); }
#define fseek64 fseeko
#endif

/* 목록은 FILEDESCRIPTORW 배열 그대로 오가므로 구조체 크기가 프로토콜 크기(592)와 같아야 한다 — 다르면 컴파일을 멈춘다 */
typedef char filedescriptorw_size_check[(sizeof(FILEDESCRIPTORW) == DESC_SIZE) ? 1 : -1];

typedef struct {
	char* abs;       /* 로컬 절대 경로 */
	WCHAR name[260]; /* 상대 경로(\ 구분, UTF-16) */
	uint64_t size;
	int dir;
} LocalFile;

static CliprdrClientContext* g_clip = NULL;
static int g_ready = 0; /* 서버가 Monitor Ready를 보낸 뒤에만 Format List를 보낼 수 있다 */

static pthread_mutex_t g_clip_mutex = PTHREAD_MUTEX_INITIALIZER;
static char* g_local_text = NULL; /* 로컬 클립보드 텍스트(UTF-8), g_clip_mutex로 보호 */
static size_t g_local_len = 0;
static int g_local_dirty = 0; /* 서버에 새 Format List를 알려야 함 */
static LocalFile* g_files = NULL; /* 로컬 → 원격 파일 목록, g_clip_mutex로 보호 */
static uint32_t g_nfiles = 0;
static FILE* g_open_fp = NULL; /* 연결 스레드에서만 접근 — 마지막으로 읽은 파일 핸들 */
static uint32_t g_open_idx = 0xFFFFFFFFu;

/* 원격 → 로컬 */
static uint32_t g_srv_file_fmt = 0; /* 서버가 알린 FileGroupDescriptorW 형식 번호(0=없음) */
static uint32_t g_pending_fmt = 0;  /* 마지막으로 데이터를 요청한 형식 */
static struct {
	int active;
	uint32_t count;
	uint64_t* sizes;
	uint8_t* dirs;
	uint32_t cur;      /* 지금 받는 항목 */
	uint64_t offset;   /* 그 항목에서 받은 바이트 */
	uint32_t stream;   /* 요청 번호 */
} g_dl;

static void dl_reset(void) {
	free(g_dl.sizes);
	free(g_dl.dirs);
	memset(&g_dl, 0, sizeof(g_dl));
}

static char* dup_n(const char* s, size_t n) {
	char* r = malloc(n + 1);
	if (!r) return NULL;
	memcpy(r, s, n);
	r[n] = 0;
	return r;
}

static char* dup_str(const char* s) {
	return dup_n(s, strlen(s));
}

static void files_clear_locked(void) {
	for (uint32_t i = 0; i < g_nfiles; i++) free(g_files[i].abs);
	free(g_files);
	g_files = NULL;
	g_nfiles = 0;
}

static UINT send_format_list(void) {
	pthread_mutex_lock(&g_clip_mutex);
	int has_text = g_local_text != NULL && g_local_len > 0;
	g_local_dirty = 0;
	pthread_mutex_unlock(&g_clip_mutex);

	pthread_mutex_lock(&g_clip_mutex);
	int has_files = g_nfiles > 0;
	pthread_mutex_unlock(&g_clip_mutex);

	CLIPRDR_FORMAT formats[2];
	UINT32 n = 0;
	memset(formats, 0, sizeof(formats));
	if (has_files) {
		formats[n].formatId = FILE_GROUP_FORMAT_ID;
		formats[n].formatName = (char*)FILE_GROUP_NAME;
		n++;
	} else if (has_text) {
		formats[n].formatId = CF_UNICODETEXT;
		n++;
	}
	CLIPRDR_FORMAT_LIST list;
	memset(&list, 0, sizeof(list));
	list.common.msgType = CB_FORMAT_LIST;
	list.numFormats = n;
	list.formats = n ? formats : NULL;
	return g_clip->ClientFormatList(g_clip, &list);
}

static UINT on_monitor_ready(CliprdrClientContext* context, const CLIPRDR_MONITOR_READY* ready) {
	(void)ready;
	CLIPRDR_GENERAL_CAPABILITY_SET general;
	CLIPRDR_CAPABILITIES caps;
	memset(&general, 0, sizeof(general));
	memset(&caps, 0, sizeof(caps));
	general.capabilitySetType = CB_CAPSTYPE_GENERAL;
	general.capabilitySetLength = 12;
	general.version = CB_CAPS_VERSION_2;
	general.generalFlags = CB_USE_LONG_FORMAT_NAMES | CB_STREAM_FILECLIP_ENABLED | CB_FILECLIP_NO_FILE_PATHS;
	caps.cCapabilitiesSets = 1;
	caps.capabilitySets = (CLIPRDR_CAPABILITY_SET*)&general;
	UINT rc = context->ClientCapabilities(context, &caps);
	if (rc != CHANNEL_RC_OK) return rc;
	g_ready = 1;
	return send_format_list();
}

static UINT on_server_capabilities(CliprdrClientContext* context, const CLIPRDR_CAPABILITIES* caps) {
	(void)context;
	(void)caps;
	return CHANNEL_RC_OK;
}

static UINT on_server_format_list(CliprdrClientContext* context, const CLIPRDR_FORMAT_LIST* list) {
	CLIPRDR_FORMAT_LIST_RESPONSE resp;
	memset(&resp, 0, sizeof(resp));
	resp.common.msgType = CB_FORMAT_LIST_RESPONSE;
	resp.common.msgFlags = CB_RESPONSE_OK;
	UINT rc = context->ClientFormatListResponse(context, &resp);
	if (rc != CHANNEL_RC_OK) return rc;

	dl_reset(); /* 새 복사가 시작되면 진행 중이던 받기는 버린다 */
	g_srv_file_fmt = 0;
	for (UINT32 i = 0; i < list->numFormats; i++) {
		const char* nm = list->formats[i].formatName;
		if (nm && strcmp(nm, FILE_GROUP_NAME) == 0) g_srv_file_fmt = list->formats[i].formatId;
	}
	if (g_srv_file_fmt) {
		fprintf(stderr, "[clip] server offers files (format %u)\n", g_srv_file_fmt);
		CLIPRDR_FORMAT_DATA_REQUEST freq;
		memset(&freq, 0, sizeof(freq));
		freq.common.msgType = CB_FORMAT_DATA_REQUEST;
		freq.requestedFormatId = g_srv_file_fmt;
		g_pending_fmt = g_srv_file_fmt;
		return context->ClientFormatDataRequest(context, &freq);
	}
	for (UINT32 i = 0; i < list->numFormats; i++) {
		if (list->formats[i].formatId == CF_UNICODETEXT) {
			g_pending_fmt = CF_UNICODETEXT;
			CLIPRDR_FORMAT_DATA_REQUEST req;
			memset(&req, 0, sizeof(req));
			req.common.msgType = CB_FORMAT_DATA_REQUEST;
			req.requestedFormatId = CF_UNICODETEXT;
			return context->ClientFormatDataRequest(context, &req);
		}
	}
	return CHANNEL_RC_OK;
}

static UINT on_server_format_list_response(CliprdrClientContext* context, const CLIPRDR_FORMAT_LIST_RESPONSE* resp) {
	(void)context;
	(void)resp;
	return CHANNEL_RC_OK;
}

static UINT on_server_format_data_request(CliprdrClientContext* context, const CLIPRDR_FORMAT_DATA_REQUEST* req) {
	CLIPRDR_FORMAT_DATA_RESPONSE resp;
	memset(&resp, 0, sizeof(resp));
	resp.common.msgType = CB_FORMAT_DATA_RESPONSE;
	resp.common.msgFlags = CB_RESPONSE_FAIL;

	if (req->requestedFormatId == FILE_GROUP_FORMAT_ID) {
		fprintf(stderr, "[clip] server requested file list\n");
		pthread_mutex_lock(&g_clip_mutex);
		uint32_t n = g_nfiles;
		uint8_t* buf = n ? calloc(1, 4 + (size_t)n * DESC_SIZE) : NULL;
		if (buf) {
			memcpy(buf, &n, 4);
			for (uint32_t i = 0; i < n; i++) {
				FILEDESCRIPTORW d;
				memset(&d, 0, sizeof(d));
				d.dwFlags = FD_ATTRIBUTES | FD_FILESIZE | FD_PROGRESSUI;
				d.dwFileAttributes = g_files[i].dir ? ATTR_DIRECTORY : ATTR_NORMAL;
				d.nFileSizeHigh = (DWORD)(g_files[i].size >> 32);
				d.nFileSizeLow = (DWORD)(g_files[i].size & 0xFFFFFFFFu);
				memcpy(d.cFileName, g_files[i].name, sizeof(d.cFileName));
				memcpy(buf + 4 + (size_t)i * DESC_SIZE, &d, DESC_SIZE);
			}
		}
		pthread_mutex_unlock(&g_clip_mutex);
		if (buf) {
			resp.common.msgFlags = CB_RESPONSE_OK;
			resp.common.dataLen = (UINT32)(4 + (size_t)n * DESC_SIZE);
			resp.requestedFormatData = buf;
		}
		UINT rc = context->ClientFormatDataResponse(context, &resp);
		free(buf);
		return rc;
	}

	WCHAR* wide = NULL;
	size_t wlen = 0;
	if (req->requestedFormatId == CF_UNICODETEXT) {
		pthread_mutex_lock(&g_clip_mutex);
		if (g_local_text && g_local_len > 0) wide = ConvertUtf8NToWCharAlloc(g_local_text, g_local_len, &wlen);
		pthread_mutex_unlock(&g_clip_mutex);
	}
	if (wide) {
		resp.common.msgFlags = CB_RESPONSE_OK;
		resp.common.dataLen = (UINT32)((wlen + 1) * sizeof(WCHAR)); /* NUL 종료 문자 포함 */
		resp.requestedFormatData = (const BYTE*)wide;
	}
	UINT rc = context->ClientFormatDataResponse(context, &resp);
	free(wide);
	return rc;
}

static void dl_end(uint8_t result) {
	frame_write(STDOUT_FILENO, MSG_REMOTE_FILES_END, &result, 1);
	dl_reset();
}

/* 다음 구간(또는 다음 파일)을 요청한다. 더 받을 게 없으면 끝을 알린다. */
static UINT dl_next(CliprdrClientContext* context) {
	while (g_dl.cur < g_dl.count && (g_dl.dirs[g_dl.cur] || g_dl.offset >= g_dl.sizes[g_dl.cur])) {
		g_dl.cur++;
		g_dl.offset = 0;
	}
	if (g_dl.cur >= g_dl.count) {
		dl_end(1);
		return CHANNEL_RC_OK;
	}
	uint64_t left = g_dl.sizes[g_dl.cur] - g_dl.offset;
	CLIPRDR_FILE_CONTENTS_REQUEST rq;
	memset(&rq, 0, sizeof(rq));
	rq.common.msgType = CB_FILECONTENTS_REQUEST;
	rq.streamId = ++g_dl.stream;
	rq.listIndex = g_dl.cur;
	rq.dwFlags = FILECONTENTS_RANGE;
	rq.nPositionLow = (UINT32)(g_dl.offset & 0xFFFFFFFFu);
	rq.nPositionHigh = (UINT32)(g_dl.offset >> 32);
	rq.cbRequested = (UINT32)(left > FILES_CHUNK ? FILES_CHUNK : left);
	rq.haveClipDataId = FALSE;
	return context->ClientFileContentsRequest(context, &rq);
}

static UINT handle_remote_file_list(CliprdrClientContext* context, const CLIPRDR_FORMAT_DATA_RESPONSE* resp) {
	if (resp->common.msgFlags != CB_RESPONSE_OK || !resp->requestedFormatData || resp->common.dataLen < 4) return CHANNEL_RC_OK;
	const uint8_t* data = (const uint8_t*)resp->requestedFormatData;
	uint32_t count;
	memcpy(&count, data, 4);
	fprintf(stderr, "[clip] remote files: %u\n", count);
	if (count == 0 || count > FILES_MAX_COUNT || (uint64_t)resp->common.dataLen < 4 + (uint64_t)count * DESC_SIZE) {
		if (count > FILES_MAX_COUNT) dl_end(2);
		return CHANNEL_RC_OK;
	}
	dl_reset();
	g_dl.sizes = calloc(count, sizeof(uint64_t));
	g_dl.dirs = calloc(count, 1);
	if (!g_dl.sizes || !g_dl.dirs) { dl_reset(); return CHANNEL_RC_OK; }
	g_dl.count = count;

	size_t cap = 4096, used = 0;
	char* lines = malloc(cap);
	uint64_t total = 0;
	int ok = lines != NULL;
	for (uint32_t i = 0; ok && i < count; i++) {
		FILEDESCRIPTORW d;
		memcpy(&d, data + 4 + (size_t)i * DESC_SIZE, DESC_SIZE);
		d.cFileName[259] = 0;
		int is_dir = (d.dwFileAttributes & ATTR_DIRECTORY) != 0;
		uint64_t size = ((uint64_t)d.nFileSizeHigh << 32) | d.nFileSizeLow;
		if (!is_dir && !(d.dwFlags & FD_FILESIZE)) { ok = 0; break; } /* 크기를 모르면 받지 않는다 */
		g_dl.dirs[i] = (uint8_t)is_dir;
		g_dl.sizes[i] = is_dir ? 0 : size;
		total += g_dl.sizes[i];
		if (total > FILES_MAX_BYTES) { ok = 0; break; }
		/* 원격이 보낸 이름에 탭·줄바꿈 같은 제어 문자가 있으면 Node로 넘기는 줄 형식("d\t크기\t경로\n")이 깨져 가짜 항목이 끼고
		 * 항목 번호와 내용이 어긋날 수 있다 — 그런 목록은 받지 않는다. */
		int bad = 0;
		for (size_t k = 0; k < 260 && d.cFileName[k]; k++) if (d.cFileName[k] < 0x20) { bad = 1; break; }
		if (bad) { ok = 0; break; }
		size_t nlen = 0;
		char* name = ConvertWCharToUtf8Alloc(d.cFileName, &nlen);
		if (!name) { ok = 0; break; }
		size_t need = nlen + 64;
		if (used + need > cap) {
			while (used + need > cap) cap *= 2;
			char* grown = realloc(lines, cap);
			if (!grown) { free(name); ok = 0; break; }
			lines = grown;
		}
		used += (size_t)snprintf(lines + used, cap - used, "%d\t%llu\t%s\n", is_dir, (unsigned long long)g_dl.sizes[i], name);
		free(name);
	}
	if (!ok) {
		free(lines);
		dl_end(total > FILES_MAX_BYTES ? 2 : 0);
		return CHANNEL_RC_OK;
	}
	frame_write(STDOUT_FILENO, MSG_REMOTE_FILES_BEGIN, (const uint8_t*)lines, (uint32_t)used);
	free(lines);
	g_dl.active = 1;
	return dl_next(context);
}

static UINT on_server_file_contents_response(CliprdrClientContext* context, const CLIPRDR_FILE_CONTENTS_RESPONSE* resp) {
	if (!g_dl.active || resp->streamId != g_dl.stream) return CHANNEL_RC_OK;
	if (resp->common.msgFlags != CB_RESPONSE_OK || !resp->requestedData || resp->cbRequested == 0) {
		dl_end(0);
		return CHANNEL_RC_OK;
	}
	uint64_t left = g_dl.sizes[g_dl.cur] - g_dl.offset;
	uint32_t n = resp->cbRequested;
	if (n > left) n = (uint32_t)left;
	uint8_t* buf = malloc(4 + (size_t)n);
	if (!buf) { dl_end(0); return CHANNEL_RC_OK; }
	memcpy(buf, &g_dl.cur, 4);
	memcpy(buf + 4, resp->requestedData, n);
	frame_write(STDOUT_FILENO, MSG_REMOTE_FILE_CHUNK, buf, 4 + n);
	free(buf);
	g_dl.offset += n;
	return dl_next(context);
}

/* 서버가 우리(로컬) 파일의 크기/구간을 요청 — 로컬 파일을 직접 읽어 답한다 */
static UINT on_server_file_contents_request(CliprdrClientContext* context, const CLIPRDR_FILE_CONTENTS_REQUEST* rq) {
	CLIPRDR_FILE_CONTENTS_RESPONSE out;
	memset(&out, 0, sizeof(out));
	out.common.msgType = CB_FILECONTENTS_RESPONSE;
	out.common.msgFlags = CB_RESPONSE_FAIL;
	out.streamId = rq->streamId;

	char* path = NULL;
	uint64_t fsize = 0;
	int is_dir = 0;
	pthread_mutex_lock(&g_clip_mutex);
	if (rq->listIndex < g_nfiles) {
		path = g_files[rq->listIndex].abs ? dup_str(g_files[rq->listIndex].abs) : NULL;
		fsize = g_files[rq->listIndex].size;
		is_dir = g_files[rq->listIndex].dir;
	}
	pthread_mutex_unlock(&g_clip_mutex);

	uint8_t* buf = NULL;
	if (path && !is_dir) {
		if (rq->dwFlags & FILECONTENTS_SIZE) {
			buf = malloc(8);
			if (buf) {
				memcpy(buf, &fsize, 8);
				out.cbRequested = 8;
				out.requestedData = buf;
				out.common.msgFlags = CB_RESPONSE_OK;
			}
		} else if (rq->dwFlags & FILECONTENTS_RANGE) {
			uint64_t pos = ((uint64_t)rq->nPositionHigh << 32) | rq->nPositionLow;
			uint64_t want = rq->cbRequested;
			if (pos > fsize) pos = fsize;
			if (want > fsize - pos) want = fsize - pos;
			if (g_open_idx != rq->listIndex || !g_open_fp) {
				if (g_open_fp) fclose(g_open_fp);
				g_open_fp = fopen_utf8(path);
				g_open_idx = rq->listIndex;
			}
			buf = malloc(want ? (size_t)want : 1);
			if (buf && g_open_fp && fseek64(g_open_fp, (long long)pos, SEEK_SET) == 0) {
				size_t got = want ? fread(buf, 1, (size_t)want, g_open_fp) : 0;
				if (got == (size_t)want) {
					out.cbRequested = (UINT32)got;
					out.requestedData = buf;
					out.common.msgFlags = CB_RESPONSE_OK;
				}
			}
		}
	}
	UINT rc = context->ClientFileContentsResponse(context, &out);
	free(buf);
	free(path);
	return rc;
}

static UINT on_server_format_data_response(CliprdrClientContext* context, const CLIPRDR_FORMAT_DATA_RESPONSE* resp) {
	if (g_pending_fmt == g_srv_file_fmt && g_srv_file_fmt != 0) {
		g_pending_fmt = 0;
		return handle_remote_file_list(context, resp);
	}
	if (resp->common.msgFlags != CB_RESPONSE_OK || !resp->requestedFormatData) return CHANNEL_RC_OK;
	size_t wlen = resp->common.dataLen / sizeof(WCHAR);
	const WCHAR* wide = (const WCHAR*)resp->requestedFormatData;
	while (wlen > 0 && wide[wlen - 1] == 0) wlen--; /* 끝의 NUL 제거 */
	size_t ulen = 0;
	char* utf8 = wlen ? ConvertWCharNToUtf8Alloc(wide, wlen, &ulen) : NULL;
	if (utf8) {
		frame_write(STDOUT_FILENO, MSG_CLIPBOARD_REMOTE, (const uint8_t*)utf8, (uint32_t)ulen);
		free(utf8);
	}
	return CHANNEL_RC_OK;
}

void clip_attach(CliprdrClientContext* context) {
	g_clip = context;
	g_ready = 0;
	context->MonitorReady = on_monitor_ready;
	context->ServerCapabilities = on_server_capabilities;
	context->ServerFormatList = on_server_format_list;
	context->ServerFormatListResponse = on_server_format_list_response;
	context->ServerFormatDataRequest = on_server_format_data_request;
	context->ServerFormatDataResponse = on_server_format_data_response;
	context->ServerFileContentsRequest = on_server_file_contents_request;
	context->ServerFileContentsResponse = on_server_file_contents_response;
}

void clip_detach(void) {
	dl_reset();
	if (g_open_fp) { fclose(g_open_fp); g_open_fp = NULL; }
	g_open_idx = 0xFFFFFFFFu;
	g_clip = NULL;
	g_ready = 0;
}

void clip_set_local_text(const uint8_t* utf8, uint32_t len) {
	char* copy = NULL;
	if (len > 0) {
		copy = malloc(len);
		if (!copy) return;
		memcpy(copy, utf8, len);
	}
	pthread_mutex_lock(&g_clip_mutex);
	free(g_local_text);
	g_local_text = copy;
	g_local_len = copy ? len : 0;
	g_local_dirty = 1;
	pthread_mutex_unlock(&g_clip_mutex);
}

void clip_poll(void) {
	if (!g_clip || !g_ready) return;
	pthread_mutex_lock(&g_clip_mutex);
	int dirty = g_local_dirty;
	pthread_mutex_unlock(&g_clip_mutex);
	if (dirty) send_format_list();
}

/* payload: 줄마다 "d\t크기\t상대경로(/ 구분)\t절대경로\n". 비어 있으면 파일 목록을 지운다. */
void clip_set_local_files(const uint8_t* data, uint32_t len) {
	LocalFile* arr = NULL;
	uint32_t n = 0, cap = 0;
	const char* p = (const char*)data;
	const char* end = p + len;
	while (p < end && n < FILES_MAX_COUNT) {
		const char* nl = memchr(p, '\n', (size_t)(end - p));
		if (!nl) break;
		char* line = dup_n(p, (size_t)(nl - p));
		p = nl + 1;
		if (!line) break;
		char* t1 = strchr(line, '\t');
		char* t2 = t1 ? strchr(t1 + 1, '\t') : NULL;
		char* t3 = t2 ? strchr(t2 + 1, '\t') : NULL;
		if (!t3) { free(line); continue; }
		*t1 = *t2 = *t3 = 0;
		LocalFile f;
		memset(&f, 0, sizeof(f));
		f.dir = line[0] == '1';
		f.size = (uint64_t)strtoull(t1 + 1, NULL, 10);
		for (char* c = t2 + 1; *c; c++) if (*c == '/') *c = '\\';
		size_t wl = 0;
		WCHAR* w = ConvertUtf8ToWCharAlloc(t2 + 1, &wl);
		if (!w || wl == 0 || wl > 259) { free(w); free(line); continue; }
		memcpy(f.name, w, wl * sizeof(WCHAR));
		free(w);
		f.abs = dup_str(t3 + 1);
		free(line);
		if (!f.abs) break;
		if (n == cap) {
			cap = cap ? cap * 2 : 64;
			LocalFile* grown = realloc(arr, cap * sizeof(LocalFile));
			if (!grown) { free(f.abs); break; }
			arr = grown;
		}
		arr[n++] = f;
	}
	fprintf(stderr, "[clip] local files: %u\n", n);
	pthread_mutex_lock(&g_clip_mutex);
	files_clear_locked();
	g_files = arr;
	g_nfiles = n;
	g_local_dirty = 1;
	pthread_mutex_unlock(&g_clip_mutex);
}
