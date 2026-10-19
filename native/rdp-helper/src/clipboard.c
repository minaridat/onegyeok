/* 클립보드 공유(cliprdr 채널) — 텍스트만 주고받는다.
 *  - 로컬 → 원격: Node가 로컬 클립보드가 바뀔 때마다 MSG_CLIPBOARD(UTF-8)로 보내 주면 저장해 두고, 서버에 "텍스트 있음"
 *    (Format List)을 알린다. 서버에서 붙여넣을 때 서버가 데이터를 요청하면(Format Data Request) 그때 UTF-16으로 보낸다.
 *  - 원격 → 로컬: 서버가 Format List를 보내면 곧바로 텍스트를 요청하고, 받은 데이터를 MSG_CLIPBOARD_REMOTE(UTF-8)로 Node에 넘긴다.
 * 파일 복사·붙여넣기(파일 클립보드)는 다루지 않는다 — 파일은 드라이브 공유(rdpdr/drive)로 옮긴다.
 *
 * 콜백과 clip_poll()은 RDP 이벤트 루프를 도는 연결 스레드에서 불리고, clip_set_local_text()만 stdin 스레드에서 불린다. */

#include "compat.h"
#include <stdlib.h>
#include <string.h>

#include <winpr/wtypes.h>
#include <winpr/string.h>
#include <winpr/user.h>
#include <freerdp/channels/cliprdr.h>
#include <freerdp/client/cliprdr.h>

#include "clipboard.h"
#include "framing.h"

#define MSG_CLIPBOARD_REMOTE 0x86 /* helper -> Node: 원격 클립보드 텍스트(UTF-8) */

static CliprdrClientContext* g_clip = NULL;
static int g_ready = 0; /* 서버가 Monitor Ready를 보낸 뒤에만 Format List를 보낼 수 있다 */

static pthread_mutex_t g_clip_mutex = PTHREAD_MUTEX_INITIALIZER;
static char* g_local_text = NULL; /* 로컬 클립보드 텍스트(UTF-8), g_clip_mutex로 보호 */
static size_t g_local_len = 0;
static int g_local_dirty = 0; /* 서버에 새 Format List를 알려야 함 */

static UINT send_format_list(void) {
	pthread_mutex_lock(&g_clip_mutex);
	int has_text = g_local_text != NULL && g_local_len > 0;
	g_local_dirty = 0;
	pthread_mutex_unlock(&g_clip_mutex);

	CLIPRDR_FORMAT format = { CF_UNICODETEXT, NULL };
	CLIPRDR_FORMAT_LIST list;
	memset(&list, 0, sizeof(list));
	list.common.msgType = CB_FORMAT_LIST;
	list.numFormats = has_text ? 1 : 0;
	list.formats = has_text ? &format : NULL;
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
	general.generalFlags = CB_USE_LONG_FORMAT_NAMES;
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

	for (UINT32 i = 0; i < list->numFormats; i++) {
		if (list->formats[i].formatId == CF_UNICODETEXT) {
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

static UINT on_server_format_data_response(CliprdrClientContext* context, const CLIPRDR_FORMAT_DATA_RESPONSE* resp) {
	(void)context;
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
}

void clip_detach(void) {
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
