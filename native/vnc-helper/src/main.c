/* onegyeok-vnc-helper — links libvncclient directly, speaks the framed stdio protocol
 * documented in docs/기술스택/04_VNC_기술스택.md to the Electron main process. One
 * process = one VNC session; it exits when the session ends. */

#include "compat.h"
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <rfb/rfbclient.h>

#include "framing.h"
#include "jsonlite.h"

/* Node -> helper */
#define MSG_CONNECT 0x01
#define MSG_DISCONNECT 0x02
#define MSG_MOUSE 0x03
#define MSG_KEY 0x04
#define MSG_RESIZE 0x06
/* helper -> Node */
#define MSG_CONNECTED 0x81
#define MSG_FRAME 0x82
#define MSG_STATUS 0x83
#define MSG_LOG 0x84

static volatile int g_shutdown = 0;
static ConnectParams g_params;

/* ---- thread-safe input event queue (connection thread drains it between
 * WaitForMessage()/HandleRFBServerMessage() calls — SendPointerEvent/SendKeyEvent's
 * thread-safety isn't documented by libvncclient, so per the same conservative judgment
 * call the RDP helper made, we don't call them from the stdin-reader thread directly). ---- */
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
static uint32_t rd_u32(const uint8_t* p) {
	return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

/* ---- libvncclient logging: must never touch stdout (that's our binary framing channel).
 * Route both rfbClientLog/rfbClientErr to stderr explicitly rather than trusting the
 * library's compiled-in default. ---- */
static void log_to_stderr(const char* format, ...) {
	va_list ap;
	va_start(ap, format);
	vfprintf(stderr, format, ap);
	va_end(ap);
}

/* ---- libvncclient callbacks ---- */

static char* my_get_password(rfbClient* client) {
	(void)client;
	return strdup(g_params.password ? g_params.password : "");
}

static rfbBool my_malloc_framebuffer(rfbClient* client) {
	uint64_t bytes = (uint64_t)client->width * client->height * (client->format.bitsPerPixel / 8);
	client->frameBuffer = malloc((size_t)bytes);
	return client->frameBuffer != NULL;
}

static void my_got_frame_buffer_update(rfbClient* client, int x, int y, int w, int h) {
	if (w <= 0 || h <= 0) return;
	int bpp = client->format.bitsPerPixel / 8;
	int stride = client->width * bpp;
	size_t pixel_bytes = (size_t)w * h * 4; /* we always ship 4 bytes/pixel on the wire */
	uint8_t* out = malloc(8 + pixel_bytes);
	out[0] = (uint8_t)(x & 0xFF); out[1] = (uint8_t)((x >> 8) & 0xFF);
	out[2] = (uint8_t)(y & 0xFF); out[3] = (uint8_t)((y >> 8) & 0xFF);
	out[4] = (uint8_t)(w & 0xFF); out[5] = (uint8_t)((w >> 8) & 0xFF);
	out[6] = (uint8_t)(h & 0xFF); out[7] = (uint8_t)((h >> 8) & 0xFF);
	for (int row = 0; row < h; row++) {
		const uint8_t* src = client->frameBuffer + (size_t)(y + row) * stride + (size_t)x * bpp;
		uint8_t* dst = out + 8 + (size_t)row * w * 4;
		memcpy(dst, src, (size_t)w * 4);
		/* Force alpha to opaque — our requested format has no meaningful alpha channel
		 * (same situation RDP's BGRA32 frames are in; see design doc note). */
		for (int col = 0; col < w; col++) dst[col * 4 + 3] = 0xFF;
	}
	frame_write(STDOUT_FILENO, MSG_FRAME, out, (uint32_t)(8 + pixel_bytes));
	free(out);
}

static void dispatch_input(rfbClient* client, QueueItem* items) {
	while (items) {
		QueueItem* next = items->next;
		switch (items->type) {
			case MSG_MOUSE: {
				uint16_t x = rd_u16(items->payload);
				uint16_t y = rd_u16(items->payload + 2);
				uint8_t buttonMask = items->payload[4];
				SendPointerEvent(client, x, y, buttonMask);
				break;
			}
			case MSG_KEY: {
				uint32_t keysym = rd_u32(items->payload);
				uint8_t down = items->payload[4];
				SendKeyEvent(client, keysym, down ? TRUE : FALSE);
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

	/* 8 bits/sample, 3 samples/pixel, 4 bytes/pixel -> 32bpp client-side framebuffer. */
	rfbClient* client = rfbGetClient(8, 3, 4);
	if (!client) { send_status("error", "rfbGetClient failed"); exit(1); }

	/* Explicit RGBA32 byte order in memory (little-endian host, which both macOS/arm64 and
	 * Windows/x86_64 are): redShift=0,greenShift=8,blueShift=16 means byte0=R,byte1=G,
	 * byte2=B,byte3=unused — verified empirically in test/test_e2e.py, not just assumed. */
	client->format.bitsPerPixel = 32;
	client->format.depth = 24;
	client->format.bigEndian = FALSE;
	client->format.trueColour = TRUE;
	client->format.redMax = 255;
	client->format.greenMax = 255;
	client->format.blueMax = 255;
	client->format.redShift = 0;
	client->format.greenShift = 8;
	client->format.blueShift = 16;
	client->appData.requestedDepth = 24;
	client->appData.compressLevel = 0;
	client->appData.qualityLevel = 9;

	client->GetPassword = my_get_password;
	client->MallocFrameBuffer = my_malloc_framebuffer;
	client->GotFrameBufferUpdate = my_got_frame_buffer_update;
	client->serverHost = strdup(g_params.host);
	client->serverPort = g_params.port;

	if (!ConnectToRFBServer(client, g_params.host, g_params.port)) {
		send_status("error", "ConnectToRFBServer failed");
		rfbClientCleanup(client);
		exit(1);
	}
	if (!InitialiseRFBConnection(client)) {
		send_status("error", "InitialiseRFBConnection failed (handshake/auth)");
		rfbClientCleanup(client);
		exit(1);
	}

	/* client->width/height (the "convenience" top-level fields) were observed empirically to
	 * still read 0 immediately after InitialiseRFBConnection returns on this library build,
	 * even though the server's ServerInit message (desktop name, pixel format) was clearly
	 * already parsed by that point. client->si.framebufferWidth/Height is the raw ServerInit
	 * field and is reliable — use it instead, and also explicitly request the first full-frame
	 * update (SendFramebufferUpdateRequest), since nothing else triggers it automatically. */
	int fbWidth = client->si.framebufferWidth;
	int fbHeight = client->si.framebufferHeight;
	/* The library validates incoming FramebufferUpdate rectangles against client->width/height
	 * BEFORE ever calling MallocFrameBuffer (confirmed empirically: with these left at their
	 * post-InitialiseRFBConnection value of 0, the very first real update was rejected as
	 * "Rect too large" and the connection was dropped, without MallocFrameBuffer ever firing).
	 * We own setting these from the authoritative si.* fields — but doing so ALSO suppresses
	 * the library's own "size changed since last allocation, call MallocFrameBuffer" detection
	 * (it compares the incoming size against client->width/height, which we've now already set
	 * to match — so it thinks nothing changed). Confirmed empirically via a SIGSEGV: frameBuffer
	 * was still NULL inside GotFrameBufferUpdate. We must therefore call MallocFrameBuffer
	 * ourselves too, since we've taken over both halves of what the library would normally do
	 * as one atomic step. */
	client->width = fbWidth;
	client->height = fbHeight;
	if (!client->MallocFrameBuffer(client)) {
		send_status("error", "MallocFrameBuffer failed");
		rfbClientCleanup(client);
		exit(1);
	}

	char buf[128];
	int n = jsonlite_build_connected(buf, sizeof(buf), fbWidth, fbHeight);
	if (n > 0) frame_write(STDOUT_FILENO, MSG_CONNECTED, (const uint8_t*)buf, (uint32_t)n);
	send_status("connected", NULL);

	SendFramebufferUpdateRequest(client, 0, 0, fbWidth, fbHeight, FALSE);

	while (!g_shutdown) {
		int rc = WaitForMessage(client, 20000 /* usec */);
		if (rc < 0) break; /* socket error */
		if (rc > 0) {
			if (!HandleRFBServerMessage(client)) break; /* peer closed / protocol error */
		}

		QueueItem* items = queue_drain();
		if (items) dispatch_input(client, items);
	}

	send_status("disconnected", NULL);
	rfbClientCleanup(client);
	/* One helper process = one session: once it's over, there is nothing left for this
	 * process to do — same lifecycle contract as the RDP helper (Node is expected to tear
	 * the process down via DISCONNECT or a signal once it observes this STATUS, but we don't
	 * linger either way). */
	exit(0);
	return NULL;
}

int main(void) {
	compat_set_binary_stdio();
	rfbClientLog = log_to_stderr;
	rfbClientErr = log_to_stderr;

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
				if (f.payload_len > 0) queue_push(f.type, f.payload, (uint8_t)f.payload_len);
				free(f.payload);
				break;
			case MSG_RESIZE:
				/* Known v1 gap (documented in docs/기술스택/04_VNC_기술스택.md): VNC has no
				 * client-driven resize concept — the server decides resolution. */
				frame_write(STDOUT_FILENO, MSG_LOG, (const uint8_t*)"RESIZE not applicable to VNC", 28);
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
