/* onegyeok-rdp-helper — links libfreerdp directly (no guacd), speaks the framed
 * stdio protocol documented in docs/기술스택/03_RDP_기술스택.md to the Electron main
 * process. One process = one RDP session; it exits when the session ends. */

#include "compat.h"
#ifdef _WIN32
#include <timeapi.h> /* timeBeginPeriod (winmm) */
#endif
#include <time.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <winpr/wtypes.h>
#include <winpr/synch.h>
#include <freerdp/freerdp.h>
#include <freerdp/settings.h>
#include <freerdp/update.h>
#include <freerdp/input.h>
#include <freerdp/scancode.h>
#include <freerdp/gdi/gdi.h>
#include <freerdp/codec/color.h>
#include <freerdp/event.h>
#include <freerdp/codecs.h>
#include <freerdp/client/cmdline.h>
#include <freerdp/client/disp.h>
#include <freerdp/addin.h>
#include <freerdp/client/channels.h>
#include <freerdp/channels/disp.h>
#include <freerdp/client/cliprdr.h>
#include <freerdp/channels/cliprdr.h>
#include <winpr/string.h>

#include "framing.h"
#include "jsonlite.h"

/* Node -> helper */
#define MSG_CONNECT 0x01
#define MSG_DISCONNECT 0x02
#define MSG_MOUSE 0x03
#define MSG_KEY 0x04
#define MSG_UNICODE_KEY 0x05
#define MSG_RESIZE 0x06
#define MSG_CLIP_SET 0x07 /* Node -> helper: 로컬 클립보드 텍스트(UTF-8) — 원격 붙여넣기용으로 알린다 */
/* helper -> Node */
#define MSG_CONNECTED 0x81
#define MSG_FRAME 0x82
#define MSG_STATUS 0x83
#define MSG_LOG 0x84
#define MSG_CLIP_DATA 0x86 /* helper -> Node: 원격에서 복사한 텍스트(UTF-8) — 로컬 클립보드에 넣는다 */
#define MSG_DESKTOP_RESIZED 0x85 /* helper -> Node: {"width":W,"height":H} — 서버가 해상도를 바꿨다 */

static volatile int g_shutdown = 0;
static ConnectParams g_params;

/* ---- thread-safe input event queue (connection thread drains it between
 * freerdp_check_event_handles() calls, per the doc's guidance not to call
 * freerdp_input_send_* from a thread other than the one running the RDP event loop). ---- */
typedef struct QueueItem {
	uint8_t type;
	uint8_t payload[8];
	uint8_t payload_len;
	struct QueueItem* next;
} QueueItem;

static pthread_mutex_t g_queue_mutex = PTHREAD_MUTEX_INITIALIZER;
static QueueItem* g_queue_head = NULL;
static QueueItem* g_queue_tail = NULL;

static void queue_push(uint8_t type, const uint8_t* payload, uint8_t payload_len) {
	QueueItem* item = malloc(sizeof(QueueItem));
	item->type = type;
	item->payload_len = payload_len > 8 ? 8 : payload_len;
	memcpy(item->payload, payload, item->payload_len);
	item->next = NULL;
	pthread_mutex_lock(&g_queue_mutex);
	if (g_queue_tail) g_queue_tail->next = item; else g_queue_head = item;
	g_queue_tail = item;
	pthread_mutex_unlock(&g_queue_mutex);
}

static QueueItem* queue_drain(void) {
	pthread_mutex_lock(&g_queue_mutex);
	QueueItem* head = g_queue_head;
	g_queue_head = g_queue_tail = NULL;
	pthread_mutex_unlock(&g_queue_mutex);
	return head;
}

static void send_status(const char* state, const char* message) {
	char buf[512];
	int n = jsonlite_build_status(buf, sizeof(buf), state, message);
	if (n > 0) frame_write(STDOUT_FILENO, MSG_STATUS, (const uint8_t*)buf, (uint32_t)n);
}

static uint16_t rd_u16(const uint8_t* p) { return (uint16_t)(p[0] | (p[1] << 8)); }

/* ---- GDI frame diffing: FreeRDP's built-in software renderer (enabled via gdi_init in
 * PostConnect) does all protocol/codec decoding into gdi->primary_buffer for us. We just
 * poll it on a tick and ship the changed bounding rect — see design doc rationale: we do
 * NOT want to reimplement RDP bitmap codecs ourselves. ---- */
static volatile int g_frames_emitted = 0; /* 첫 화면 프레임을 보낸 뒤(=연결이 완전히 활성화된 뒤)에만 해상도 변경을 요청한다 */
static BYTE* g_snapshot = NULL;
static UINT32 g_snap_w = 0, g_snap_h = 0;

static void maybe_emit_frame(rdpGdi* gdi) {
	if (!gdi || !gdi->primary_buffer) return;
	UINT32 w = (UINT32)gdi->width, h = (UINT32)gdi->height, stride = gdi->stride;
	if (w == 0 || h == 0) return;

	if (!g_snapshot || g_snap_w != w || g_snap_h != h) {
		free(g_snapshot);
		g_snapshot = calloc((size_t)w * h, 4); /* all-zero baseline forces a full first frame */
		g_snap_w = w;
		g_snap_h = h;
	}

	int min_y = -1, max_y = -1;
	for (UINT32 y = 0; y < h; y++) {
		const BYTE* src_row = gdi->primary_buffer + (size_t)y * stride;
		const BYTE* snap_row = g_snapshot + (size_t)y * w * 4;
		if (memcmp(src_row, snap_row, (size_t)w * 4) != 0) {
			if (min_y < 0) min_y = (int)y;
			max_y = (int)y;
		}
	}
	if (min_y < 0) return; /* nothing changed since last tick */

	int min_x = (int)w, max_x = -1;
	for (int y = min_y; y <= max_y; y++) {
		const BYTE* src_row = gdi->primary_buffer + (size_t)y * stride;
		const BYTE* snap_row = g_snapshot + (size_t)y * w * 4;
		for (UINT32 x = 0; x < w; x++) {
			if (memcmp(src_row + (size_t)x * 4, snap_row + (size_t)x * 4, 4) != 0) {
				if ((int)x < min_x) min_x = (int)x;
				if ((int)x > max_x) max_x = (int)x;
			}
		}
	}

	int rw = max_x - min_x + 1;
	int rh = max_y - min_y + 1;
	size_t pixel_bytes = (size_t)rw * rh * 4;
	uint8_t* out = malloc(8 + pixel_bytes);
	out[0] = (uint8_t)(min_x & 0xFF); out[1] = (uint8_t)((min_x >> 8) & 0xFF);
	out[2] = (uint8_t)(min_y & 0xFF); out[3] = (uint8_t)((min_y >> 8) & 0xFF);
	out[4] = (uint8_t)(rw & 0xFF); out[5] = (uint8_t)((rw >> 8) & 0xFF);
	out[6] = (uint8_t)(rh & 0xFF); out[7] = (uint8_t)((rh >> 8) & 0xFF);
	for (int y = 0; y < rh; y++) {
		const BYTE* src_row = gdi->primary_buffer + (size_t)(min_y + y) * stride + (size_t)min_x * 4;
		memcpy(out + 8 + (size_t)y * rw * 4, src_row, (size_t)rw * 4);
	}
	frame_write(STDOUT_FILENO, MSG_FRAME, out, (uint32_t)(8 + pixel_bytes));
	g_frames_emitted = 1;
	free(out);

	/* Full re-snapshot (simple, correct; perf headroom exists — see design doc note that a
	 * single bounding-box diff is intentionally the v1 scope, not an optimized multi-rect one). */
	for (UINT32 y = 0; y < h; y++) {
		memcpy(g_snapshot + (size_t)y * w * 4, gdi->primary_buffer + (size_t)y * stride, (size_t)w * 4);
	}
}

/* ---- 동적 해상도(화면 크기 조절): RDP "disp"(DisplayControl) 채널로 서버에 모니터 레이아웃을 보내면 서버가
 * 해상도를 바꾸고 DesktopResize 콜백이 온다. Node의 RESIZE 메시지는 stdin 스레드에서 오므로 값만 저장해 두고,
 * 실제 전송은 RDP 이벤트 루프를 도는 연결 스레드에서 한다(FreeRDP 객체는 그 스레드에서만 만진다). ---- */
static DispClientContext* g_disp = NULL;
static UINT32 g_pending_w = 0, g_pending_h = 0; /* g_queue_mutex로 보호 */
static BOOL (*g_prev_desktop_resize)(rdpContext*) = NULL;
/* 해상도가 바뀐 직후 서버에 "화면 전체를 다시 보내달라"(Refresh Rect)고 요청할 시각(ms, 0이면 없음). 일부 서버(xrdp 등)는 키운 해상도의
 * 새 영역을 스스로 다시 그려주지 않아 오른쪽/아래가 비어 보이기 때문에, 연결이 안정된 뒤 두 번(+400ms, +1500ms) 요청한다. */
static uint64_t g_refresh_at[2] = {0, 0};
static void log_msg(const char* fmt, ...);

static uint64_t now_ms(void) {
#ifdef _WIN32
	return (uint64_t)GetTickCount64();
#else
	struct timespec ts;
	clock_gettime(CLOCK_MONOTONIC, &ts);
	return (uint64_t)ts.tv_sec * 1000u + (uint64_t)(ts.tv_nsec / 1000000);
#endif
}

static void send_due_refresh(rdpContext* context) {
	if (!context || !context->gdi || !context->update || !context->update->RefreshRect) return;
	uint64_t now = now_ms();
	for (int i = 0; i < 2; i++) {
		if (g_refresh_at[i] && now >= g_refresh_at[i]) {
			g_refresh_at[i] = 0;
			RECTANGLE_16 rect;
			rect.left = 0;
			rect.top = 0;
			rect.right = (UINT16)context->gdi->width;
			rect.bottom = (UINT16)context->gdi->height;
			context->update->RefreshRect(context, 1, &rect);
		}
	}
}

static void log_msg(const char* fmt, ...) {
	char buf[200];
	va_list ap;
	va_start(ap, fmt);
	int n = vsnprintf(buf, sizeof(buf), fmt, ap);
	va_end(ap);
	/* 진단 로그는 stderr로 — Electron 메인이 헬퍼 stderr를 그대로 콘솔에 남긴다(MSG_LOG는 브리지에서 아직 안 쓴다). */
	if (n > 0) fprintf(stderr, "[onegyeok-rdp-helper] %s\n", buf);
}

/* ---- 클립보드(텍스트) 공유: cliprdr 채널. 로컬→원격은 "형식 목록"만 먼저 알리고 원격이 붙여넣을 때 데이터를 요청하면 응답하는
 * 지연 전송 방식이고, 원격→로컬은 원격이 형식 목록을 알리면 바로 유니코드 텍스트를 요청해 Node로 넘긴다.
 * 콜백은 모두 RDP 이벤트 루프를 도는 연결 스레드에서 불리므로, 다른 스레드(stdin)가 넘겨준 로컬 텍스트만 뮤텍스로 보호한다. ---- */
#define CLIP_CF_UNICODETEXT 13u
static CliprdrClientContext* g_cliprdr = NULL;
static volatile int g_clip_ready = 0; /* MonitorReady 이후 */
static uint8_t* g_local_clip = NULL; /* UTF-16LE + NUL 종결(원격 전송 형식) — g_queue_mutex로 보호 */
static uint32_t g_local_clip_len = 0;
static volatile int g_local_clip_dirty = 0;

static UINT clip_send_format_list(void) {
	if (!g_cliprdr || !g_cliprdr->ClientFormatList) return CHANNEL_RC_OK;
	CLIPRDR_FORMAT fmt;
	CLIPRDR_FORMAT_LIST list;
	memset(&fmt, 0, sizeof(fmt));
	memset(&list, 0, sizeof(list));
	pthread_mutex_lock(&g_queue_mutex);
	int have = g_local_clip && g_local_clip_len > 2;
	pthread_mutex_unlock(&g_queue_mutex);
	fmt.formatId = CLIP_CF_UNICODETEXT;
	fmt.formatName = NULL;
	list.common.msgType = CB_FORMAT_LIST;
	log_msg("clip: announce format list (%s)", have ? "text" : "empty");
	list.numFormats = have ? 1 : 0;
	list.formats = have ? &fmt : NULL;
	return g_cliprdr->ClientFormatList(g_cliprdr, &list);
}

static UINT clip_monitor_ready(CliprdrClientContext* ctx, const CLIPRDR_MONITOR_READY* ready) {
	(void)ready;
	CLIPRDR_GENERAL_CAPABILITY_SET general;
	CLIPRDR_CAPABILITIES caps;
	memset(&general, 0, sizeof(general));
	memset(&caps, 0, sizeof(caps));
	general.capabilitySetType = CB_CAPSTYPE_GENERAL;
	general.capabilitySetLength = CB_CAPSTYPE_GENERAL_LEN;
	general.version = CB_CAPS_VERSION_2;
	general.generalFlags = CB_USE_LONG_FORMAT_NAMES; /* 파일 전송(스트림 파일 클립)은 쓰지 않는다 — 텍스트만 */
	caps.cCapabilitiesSets = 1;
	caps.capabilitySets = (CLIPRDR_CAPABILITY_SET*)&general;
	UINT rc = ctx->ClientCapabilities(ctx, &caps);
	if (rc != CHANNEL_RC_OK) return rc;
	g_clip_ready = 1;
	return clip_send_format_list();
}

static UINT clip_server_capabilities(CliprdrClientContext* ctx, const CLIPRDR_CAPABILITIES* caps) {
	(void)ctx; (void)caps;
	return CHANNEL_RC_OK;
}

static UINT clip_server_format_list(CliprdrClientContext* ctx, const CLIPRDR_FORMAT_LIST* list) {
	CLIPRDR_FORMAT_LIST_RESPONSE resp;
	memset(&resp, 0, sizeof(resp));
	resp.common.msgType = CB_FORMAT_LIST_RESPONSE;
	resp.common.msgFlags = CB_RESPONSE_OK;
	UINT rc = ctx->ClientFormatListResponse(ctx, &resp);
	if (rc != CHANNEL_RC_OK) return rc;
	for (UINT32 i = 0; list && i < list->numFormats; i++) {
		if (list->formats[i].formatId == CLIP_CF_UNICODETEXT) {
			CLIPRDR_FORMAT_DATA_REQUEST req;
			memset(&req, 0, sizeof(req));
			req.common.msgType = CB_FORMAT_DATA_REQUEST;
			req.requestedFormatId = CLIP_CF_UNICODETEXT;
			ctx->lastRequestedFormatId = CLIP_CF_UNICODETEXT;
			return ctx->ClientFormatDataRequest(ctx, &req);
		}
	}
	return CHANNEL_RC_OK; /* 텍스트가 아니면(이미지·파일 등) 무시 */
}

static UINT clip_server_format_list_response(CliprdrClientContext* ctx, const CLIPRDR_FORMAT_LIST_RESPONSE* resp) {
	(void)ctx; (void)resp;
	return CHANNEL_RC_OK;
}

static UINT clip_server_format_data_request(CliprdrClientContext* ctx, const CLIPRDR_FORMAT_DATA_REQUEST* req) {
	CLIPRDR_FORMAT_DATA_RESPONSE resp;
	memset(&resp, 0, sizeof(resp));
	resp.common.msgType = CB_FORMAT_DATA_RESPONSE;
	uint8_t* copy = NULL;
	uint32_t len = 0;
	if (req->requestedFormatId == CLIP_CF_UNICODETEXT) {
		pthread_mutex_lock(&g_queue_mutex);
		if (g_local_clip && g_local_clip_len > 0) {
			copy = malloc(g_local_clip_len);
			if (copy) { memcpy(copy, g_local_clip, g_local_clip_len); len = g_local_clip_len; }
		}
		pthread_mutex_unlock(&g_queue_mutex);
	}
	if (copy) {
		resp.common.msgFlags = CB_RESPONSE_OK;
		resp.common.dataLen = len;
		resp.requestedFormatData = copy;
	} else {
		resp.common.msgFlags = CB_RESPONSE_FAIL;
	}
	log_msg("clip: server requested format %u -> %s (%u bytes)", (unsigned)req->requestedFormatId, copy ? "ok" : "fail", (unsigned)len);
	UINT rc = ctx->ClientFormatDataResponse(ctx, &resp);
	free(copy);
	return rc;
}

static UINT clip_server_format_data_response(CliprdrClientContext* ctx, const CLIPRDR_FORMAT_DATA_RESPONSE* resp) {
	(void)ctx;
	if (!(resp->common.msgFlags & CB_RESPONSE_OK) || !resp->requestedFormatData || resp->common.dataLen < 2) return CHANNEL_RC_OK;
	size_t units = resp->common.dataLen / 2;
	const WCHAR* w = (const WCHAR*)resp->requestedFormatData;
	while (units > 0 && w[units - 1] == 0) units--; /* 끝의 NUL 제거 */
	if (units == 0) return CHANNEL_RC_OK;
	size_t out_len = 0;
	char* utf8 = ConvertWCharNToUtf8Alloc(w, units, &out_len);
	if (utf8) {
		frame_write(STDOUT_FILENO, MSG_CLIP_DATA, (const uint8_t*)utf8, (uint32_t)out_len);
		free(utf8);
	}
	return CHANNEL_RC_OK;
}

/* Node가 보낸 UTF-8 텍스트를 UTF-16(+NUL)로 바꿔 저장하고 "바뀌었다"는 표시만 해 둔다(stdin 스레드). */
static void clip_set_local(const uint8_t* utf8, uint32_t len) {
	size_t wlen = 0;
	WCHAR* w = len ? ConvertUtf8NToWCharAlloc((const char*)utf8, len, &wlen) : NULL;
	uint8_t* bytes = NULL;
	uint32_t blen = 0;
	if (w) {
		blen = (uint32_t)((wlen + 1) * 2);
		bytes = calloc(1, blen);
		if (bytes) memcpy(bytes, w, wlen * 2); else blen = 0;
		free(w);
	}
	pthread_mutex_lock(&g_queue_mutex);
	free(g_local_clip);
	g_local_clip = bytes;
	g_local_clip_len = blen;
	g_local_clip_dirty = 1;
	pthread_mutex_unlock(&g_queue_mutex);
}

static void clip_send_if_dirty(void) {
	if (!g_clip_ready || !g_local_clip_dirty) return;
	g_local_clip_dirty = 0;
	clip_send_format_list();
}

static void on_channel_connected_clip(const ChannelConnectedEventArgs* e) {
	if (!e || !e->name || strcmp(e->name, "cliprdr") != 0) return;
	g_cliprdr = (CliprdrClientContext*)e->pInterface;
	g_cliprdr->MonitorReady = clip_monitor_ready;
	g_cliprdr->ServerCapabilities = clip_server_capabilities;
	g_cliprdr->ServerFormatList = clip_server_format_list;
	g_cliprdr->ServerFormatListResponse = clip_server_format_list_response;
	g_cliprdr->ServerFormatDataRequest = clip_server_format_data_request;
	g_cliprdr->ServerFormatDataResponse = clip_server_format_data_response;
}

static void on_channel_disconnected_clip(const ChannelDisconnectedEventArgs* e) {
	if (e && e->name && strcmp(e->name, "cliprdr") == 0) { g_cliprdr = NULL; g_clip_ready = 0; }
}

static void on_channel_connected(void* ctx, const ChannelConnectedEventArgs* e) {
	(void)ctx;
	if (e && e->name) log_msg("channel connected: %s", e->name);
	on_channel_connected_clip(e);
	if (e && e->name && strcmp(e->name, DISP_DVC_CHANNEL_NAME) == 0) g_disp = (DispClientContext*)e->pInterface;
}

static void on_channel_disconnected(void* ctx, const ChannelDisconnectedEventArgs* e) {
	(void)ctx;
	on_channel_disconnected_clip(e);
	if (e && e->name && strcmp(e->name, DISP_DVC_CHANNEL_NAME) == 0) g_disp = NULL;
}

static BOOL my_desktop_resize(rdpContext* context) {
	UINT32 w = freerdp_settings_get_uint32(context->settings, FreeRDP_DesktopWidth);
	UINT32 h = freerdp_settings_get_uint32(context->settings, FreeRDP_DesktopHeight);
	/* gdi_init()은 DesktopResize 핸들러를 등록해주지 않는다 — 우리가 직접 gdi 버퍼를 새 크기로 다시 만들어야 한다.
	 * 안 하면 서버는 새 해상도로 그리는데 클라이언트 버퍼는 옛 크기 그대로라 새로 생긴 영역이 영원히 비어 보인다. */
	if (g_prev_desktop_resize && !g_prev_desktop_resize(context)) return FALSE;
	if (!gdi_resize(context->gdi, w, h)) return FALSE;
	/* gdi_resize는 비트맵 디코더(planar 등)의 최대 폭/높이를 새 크기로 바꿔주지 않는다 — 안 하면 해상도가 커졌을 때
	 * "planar->maxWidth < nSrcWidth"로 디코딩이 실패하고 연결이 끊긴다. */
	if (context->codecs) {
		freerdp_client_codecs_reset(context->codecs,
		    FREERDP_CODEC_INTERLEAVED | FREERDP_CODEC_PLANAR | FREERDP_CODEC_NSCODEC | FREERDP_CODEC_REMOTEFX |
		    FREERDP_CODEC_CLEARCODEC | FREERDP_CODEC_PROGRESSIVE, w, h);
	}
	log_msg("desktop resized to %ux%u", (unsigned)w, (unsigned)h);
	g_refresh_at[0] = now_ms() + 400;
	g_refresh_at[1] = now_ms() + 1500;
	char buf[64];
	int n = jsonlite_build_connected(buf, sizeof(buf), (int)w, (int)h);
	if (n > 0) frame_write(STDOUT_FILENO, MSG_DESKTOP_RESIZED, (const uint8_t*)buf, (uint32_t)n);
	return TRUE;
}

static void send_pending_resize(void) {
	if (!g_disp || !g_disp->SendMonitorLayout || !g_frames_emitted) return; /* 아직이면 대기 값은 그대로 두고 다음 틱에 재시도 */
	pthread_mutex_lock(&g_queue_mutex);
	UINT32 w = g_pending_w, h = g_pending_h;
	g_pending_w = g_pending_h = 0;
	pthread_mutex_unlock(&g_queue_mutex);
	if (!w || !h) return;
	if (w < DISPLAY_CONTROL_MIN_MONITOR_WIDTH) w = DISPLAY_CONTROL_MIN_MONITOR_WIDTH;
	if (h < DISPLAY_CONTROL_MIN_MONITOR_HEIGHT) h = DISPLAY_CONTROL_MIN_MONITOR_HEIGHT;
	if (w > DISPLAY_CONTROL_MAX_MONITOR_WIDTH) w = DISPLAY_CONTROL_MAX_MONITOR_WIDTH;
	if (h > DISPLAY_CONTROL_MAX_MONITOR_HEIGHT) h = DISPLAY_CONTROL_MAX_MONITOR_HEIGHT;
	w &= ~1u; /* 프로토콜상 너비는 짝수여야 한다 */
	DISPLAY_CONTROL_MONITOR_LAYOUT layout;
	memset(&layout, 0, sizeof(layout));
	layout.Flags = DISPLAY_CONTROL_MONITOR_PRIMARY;
	layout.Width = w;
	layout.Height = h;
	layout.DesktopScaleFactor = 100;
	layout.DeviceScaleFactor = 100;
	UINT rc = g_disp->SendMonitorLayout(g_disp, 1, &layout);
	log_msg("disp SendMonitorLayout %ux%u rc=%u", (unsigned)w, (unsigned)h, (unsigned)rc);
}

/* ---- FreeRDP callbacks ---- */

static BOOL my_pre_connect(freerdp* instance) {
	rdpSettings* settings = instance->context->settings;
	freerdp_settings_set_string(settings, FreeRDP_ServerHostname, g_params.host);
	freerdp_settings_set_uint32(settings, FreeRDP_ServerPort, (UINT32)g_params.port);
	freerdp_settings_set_string(settings, FreeRDP_Username, g_params.username);
	freerdp_settings_set_string(settings, FreeRDP_Password, g_params.password);
	if (g_params.domain && g_params.domain[0]) {
		freerdp_settings_set_string(settings, FreeRDP_Domain, g_params.domain);
	}
	freerdp_settings_set_uint32(settings, FreeRDP_DesktopWidth, (UINT32)g_params.width);
	freerdp_settings_set_uint32(settings, FreeRDP_DesktopHeight, (UINT32)g_params.height);
	freerdp_settings_set_uint32(settings, FreeRDP_ColorDepth, (UINT32)g_params.colorDepth);
	freerdp_settings_set_bool(settings, FreeRDP_IgnoreCertificate, g_params.ignoreCertificate ? TRUE : FALSE);

	BOOL tls = FALSE, nla = FALSE, rdp = FALSE;
	if (strcmp(g_params.security, "nla") == 0) nla = TRUE;
	else if (strcmp(g_params.security, "rdp") == 0) rdp = TRUE;
	else tls = TRUE; /* default, matches the probe's validated TLS-only fixture path */
	freerdp_settings_set_bool(settings, FreeRDP_TlsSecurity, tls);
	freerdp_settings_set_bool(settings, FreeRDP_NlaSecurity, nla);
	freerdp_settings_set_bool(settings, FreeRDP_RdpSecurity, rdp);

	/* 동적 해상도: drdynvc + disp 채널을 켜고 채널 연결 이벤트를 구독한다. */
	freerdp_settings_set_bool(settings, FreeRDP_SupportDynamicChannels, TRUE);
	freerdp_settings_set_bool(settings, FreeRDP_SupportDisplayControl, TRUE);
	freerdp_settings_set_bool(settings, FreeRDP_DynamicResolutionUpdate, TRUE);
	/* 아래 RDP8 기능들은 켜져 있으면 FreeRDP가 rdpdr(장치 리디렉션) 채널을 강제로 요구하는데, 이 헬퍼는 해당 채널을
	 * 빌드에 넣지 않았으므로 끈다 — 안 끄면 freerdp_client_load_addins가 rdpdr 로드 실패로 접속 자체가 막힌다. */
	freerdp_settings_set_bool(settings, FreeRDP_NetworkAutoDetect, FALSE);
	freerdp_settings_set_bool(settings, FreeRDP_SupportHeartbeatPdu, FALSE);
	freerdp_settings_set_bool(settings, FreeRDP_SupportMultitransport, FALSE);
	freerdp_settings_set_bool(settings, FreeRDP_AudioPlayback, FALSE);
	freerdp_settings_set_bool(settings, FreeRDP_AudioCapture, FALSE);
	freerdp_settings_set_bool(settings, FreeRDP_RedirectClipboard, g_params.clipboard ? TRUE : FALSE);
	/* 로컬 폴더 마운트: rdpdr(장치 리디렉션) 채널에 "drive" 장치를 하나 등록한다. 서버에는 "<이름> on <PC이름>" 드라이브로 보인다. */
	if (g_params.driveName && g_params.driveName[0] && g_params.drivePath && g_params.drivePath[0]) {
		const char* drive_args[] = { "drive", g_params.driveName, g_params.drivePath };
		if (!freerdp_client_add_device_channel(settings, 3, drive_args)) log_msg("drive redirection setup failed");
	} else {
		freerdp_settings_set_bool(settings, FreeRDP_DeviceRedirection, FALSE);
	}
	freerdp_settings_set_bool(settings, FreeRDP_SupportGraphicsPipeline, FALSE);
	PubSub_SubscribeChannelConnected(instance->context->pubSub, on_channel_connected);
	PubSub_SubscribeChannelDisconnected(instance->context->pubSub, on_channel_disconnected);
	/* 채널 로드는 여기서 하지 않는다 — FreeRDP가 PreConnect 직후 채널 객체를 새로 만들어 바꿔치기(utils_reload_channels)하므로
	 * PreConnect에서 로드한 채널은 버려진다. 아래 my_load_channels(instance->LoadChannels)에서 로드한다. */
	return TRUE;
}

/* FreeRDP가 (PreConnect 이후) 채널 객체를 재생성한 직후 호출한다 — 정적/동적 채널(drdynvc, disp)은 반드시 여기서 로드해야 한다. */
static BOOL my_load_channels(freerdp* instance) {
	BOOL ok = freerdp_client_load_addins(instance->context->channels, instance->context->settings);
	if (!ok) log_msg("load_channels failed");
	return ok;
}

static BOOL my_post_connect(freerdp* instance) {
	if (!gdi_init(instance, PIXEL_FORMAT_BGRA32)) return FALSE;
	g_prev_desktop_resize = instance->context->update->DesktopResize;
	instance->context->update->DesktopResize = my_desktop_resize;
	UINT32 w = freerdp_settings_get_uint32(instance->context->settings, FreeRDP_DesktopWidth);
	UINT32 h = freerdp_settings_get_uint32(instance->context->settings, FreeRDP_DesktopHeight);
	char buf[128];
	int n = jsonlite_build_connected(buf, sizeof(buf), (int)w, (int)h);
	if (n > 0) frame_write(STDOUT_FILENO, MSG_CONNECTED, (const uint8_t*)buf, (uint32_t)n);
	send_status("connected", NULL);
	return TRUE;
}

static void my_post_disconnect(freerdp* instance) {
	gdi_free(instance);
}

static BOOL my_authenticate_ex(freerdp* instance, char** username, char** password,
                                char** domain, rdp_auth_reason reason) {
	(void)instance;
	(void)reason;
	free(*username);
	free(*password);
	free(*domain);
	*username = strdup(g_params.username);
	*password = strdup(g_params.password);
	*domain = (g_params.domain && g_params.domain[0]) ? strdup(g_params.domain) : NULL;
	return TRUE;
}

static void dispatch_input(rdpInput* input, QueueItem* items) {
	while (items) {
		QueueItem* next = items->next;
		switch (items->type) {
			case MSG_MOUSE: {
				uint16_t x = rd_u16(items->payload);
				uint16_t y = rd_u16(items->payload + 2);
				uint16_t flags = rd_u16(items->payload + 4);
				freerdp_input_send_mouse_event(input, flags, x, y);
				break;
			}
			case MSG_KEY: {
				uint16_t scancode = rd_u16(items->payload);
				uint16_t flags = rd_u16(items->payload + 2);
				BOOL down = !(flags & KBD_FLAGS_RELEASE);
				BOOL extended = (flags & KBD_FLAGS_EXTENDED) != 0;
				UINT32 rdp_scancode = MAKE_RDP_SCANCODE((BYTE)(scancode & 0xFF), extended);
				freerdp_input_send_keyboard_event_ex(input, down, FALSE, rdp_scancode);
				break;
			}
			case MSG_UNICODE_KEY: {
				uint16_t code = rd_u16(items->payload);
				uint8_t flags = items->payload[2];
				freerdp_input_send_unicode_keyboard_event(input, flags ? KBD_FLAGS_RELEASE : 0, code);
				break;
			}
			default:
				break;
		}
		free(items);
		items = next;
	}
}

static void* run_connection(void* arg) {
	(void)arg;
	send_status("connecting", NULL);

	/* 정적으로 링크된 채널(drdynvc/disp) 진입점을 FreeRDP가 찾을 수 있게 제공자를 등록한다 — freerdp_client_context_new()가 해주던
	 * 일인데 이 헬퍼는 그 헬퍼를 쓰지 않고 freerdp_new()를 직접 쓰므로 여기서 한다. */
	freerdp_register_addin_provider(freerdp_channels_load_static_addin_entry, 0);

	freerdp* instance = freerdp_new();
	if (!instance) { send_status("error", "freerdp_new failed"); exit(1); }

	instance->PreConnect = my_pre_connect;
	instance->PostConnect = my_post_connect;
	instance->LoadChannels = my_load_channels;
	instance->PostDisconnect = my_post_disconnect;
	instance->AuthenticateEx = my_authenticate_ex;

	if (!freerdp_context_new(instance)) {
		send_status("error", "freerdp_context_new failed");
		freerdp_free(instance);
		exit(1);
	}

	if (!freerdp_connect(instance)) {
		const char* err = freerdp_get_last_error_string(freerdp_get_last_error(instance->context));
		send_status("error", err);
		freerdp_context_free(instance);
		freerdp_free(instance);
		exit(1);
	}

	/* 고정 Sleep으로 돌면 그 사이 소켓을 읽지 않아 수신 버퍼가 차고 서버가 보내기를 멈춘다 — 창을 끌 때처럼 화면 데이터가
	 * 많으면 처리량이 "버퍼 크기 / 대기 시간"에 묶여 화면이 수 초씩 밀렸다(실제 Windows Server에서 끌기를 멈춘 뒤 3~4초).
	 * FreeRDP 클라이언트들처럼 이벤트 핸들(소켓 등)을 기다려 데이터가 오면 바로 처리한다. 입력 큐는 이벤트가 없으므로
	 * 최대 대기 시간(5ms)으로 확인하고, 화면 비교·전송은 비용이 크니 16ms에 한 번만 한다. */
	uint64_t last_emit = 0;
	while (!g_shutdown) {
		HANDLE handles[MAXIMUM_WAIT_OBJECTS] = { 0 };
		DWORD nhandles = freerdp_get_event_handles(instance->context, handles, (DWORD)(sizeof(handles) / sizeof(handles[0])));
		if (nhandles == 0) { log_msg("freerdp_get_event_handles failed"); break; }
		WaitForMultipleObjects(nhandles, handles, FALSE, 5);
		if (!freerdp_check_event_handles(instance->context)) break;

		QueueItem* items = queue_drain();
		if (items) dispatch_input(instance->context->input, items);
		send_pending_resize();
		clip_send_if_dirty();
		send_due_refresh(instance->context);

		uint64_t now = now_ms();
		if (now - last_emit >= 16) {
			maybe_emit_frame(instance->context->gdi);
			last_emit = now;
		}
	}

	send_status("disconnected", NULL);
	freerdp_disconnect(instance);
	freerdp_context_free(instance);
	freerdp_free(instance);
	/* One helper process = one session: once it's over, there is nothing left for this
	 * process to do (see design doc's note on why main()'s stdin-read loop doesn't need to
	 * separately detect this — Node is expected to tear the process down either via an
	 * explicit DISCONNECT or a signal once it observes this STATUS). */
	exit(0);
	return NULL;
}

int main(void) {
	compat_set_binary_stdio();
#ifdef _WIN32
	/* libfreerdp는 Winsock 초기화를 호출자에게 맡긴다 — 없으면 127.0.0.1도 "DNS host name was not found"로 실패한다. */
	WSADATA wsa_data;
	if (WSAStartup(MAKEWORD(2, 2), &wsa_data) != 0) {
		log_msg("WSAStartup failed");
		return 1;
	}
	/* Windows 기본 타이머 해상도는 15.6ms라 연결 루프의 Sleep(20)이 실제로는 약 31ms가 된다(화면 갱신·입력 처리 주기가
	 * macOS의 1.5배). 이 프로세스 동안만 1ms로 올린다 — 프로세스가 끝나면 OS가 자동으로 되돌린다. */
	timeBeginPeriod(1);
#endif
	pthread_t conn_thread;
	int conn_started = 0;

	for (;;) {
		Frame f;
		int rc = frame_read(STDIN_FILENO, &f);
		if (rc <= 0) break; /* EOF or error on stdin: nothing more to do */

		switch (f.type) {
			case MSG_CONNECT: {
				if (conn_started) { free(f.payload); break; } /* one session per process */
				if (jsonlite_parse_connect((const char*)f.payload, f.payload_len, &g_params) != 0) {
					send_status("error", "malformed CONNECT payload");
					free(f.payload);
					break;
				}
				pthread_create(&conn_thread, NULL, run_connection, NULL);
				conn_started = 1;
				break;
			}
			case MSG_DISCONNECT:
				g_shutdown = 1;
				free(f.payload);
				goto shutdown;
			case MSG_MOUSE:
			case MSG_KEY:
			case MSG_UNICODE_KEY:
				if (f.payload_len > 0) queue_push(f.type, f.payload, (uint8_t)f.payload_len);
				free(f.payload);
				break;
			case MSG_CLIP_SET:
				clip_set_local(f.payload, f.payload_len);
				free(f.payload);
				break;
			case MSG_RESIZE:
				if (f.payload_len >= 4) {
					pthread_mutex_lock(&g_queue_mutex);
					g_pending_w = rd_u16(f.payload);
					g_pending_h = rd_u16(f.payload + 2);
					pthread_mutex_unlock(&g_queue_mutex);
				}
				free(f.payload);
				break;
			default:
				free(f.payload);
				break;
		}
	}

shutdown:
	if (conn_started) pthread_join(conn_thread, NULL);
	return 0;
}
