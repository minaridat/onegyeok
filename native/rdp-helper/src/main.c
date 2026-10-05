/* onegyeok-rdp-helper — links libfreerdp directly (no guacd), speaks the framed
 * stdio protocol documented in docs/기술스택/03_RDP_기술스택.md to the Electron main
 * process. One process = one RDP session; it exits when the session ends. */

#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include <winpr/wtypes.h>
#include <winpr/synch.h>
#include <freerdp/freerdp.h>
#include <freerdp/settings.h>
#include <freerdp/update.h>
#include <freerdp/input.h>
#include <freerdp/scancode.h>
#include <freerdp/gdi/gdi.h>
#include <freerdp/codec/color.h>

#include "framing.h"
#include "jsonlite.h"

/* Node -> helper */
#define MSG_CONNECT 0x01
#define MSG_DISCONNECT 0x02
#define MSG_MOUSE 0x03
#define MSG_KEY 0x04
#define MSG_UNICODE_KEY 0x05
#define MSG_RESIZE 0x06
/* helper -> Node */
#define MSG_CONNECTED 0x81
#define MSG_FRAME 0x82
#define MSG_STATUS 0x83
#define MSG_LOG 0x84

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
	free(out);

	/* Full re-snapshot (simple, correct; perf headroom exists — see design doc note that a
	 * single bounding-box diff is intentionally the v1 scope, not an optimized multi-rect one). */
	for (UINT32 y = 0; y < h; y++) {
		memcpy(g_snapshot + (size_t)y * w * 4, gdi->primary_buffer + (size_t)y * stride, (size_t)w * 4);
	}
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
	return TRUE;
}

static BOOL my_post_connect(freerdp* instance) {
	if (!gdi_init(instance, PIXEL_FORMAT_BGRA32)) return FALSE;
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

	freerdp* instance = freerdp_new();
	if (!instance) { send_status("error", "freerdp_new failed"); exit(1); }

	instance->PreConnect = my_pre_connect;
	instance->PostConnect = my_post_connect;
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

	while (!g_shutdown) {
		if (!freerdp_check_event_handles(instance->context)) break;

		QueueItem* items = queue_drain();
		if (items) dispatch_input(instance->context->input, items);

		maybe_emit_frame(instance->context->gdi);

		Sleep(20);
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
			case MSG_RESIZE:
				/* Known v1 gap (documented in docs/기술스택/03_RDP_기술스택.md): live
				 * resize is not yet implemented. */
				frame_write(STDOUT_FILENO, MSG_LOG, (const uint8_t*)"RESIZE not yet supported", 24);
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
