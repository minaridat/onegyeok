#ifndef ONEGYEOK_JSONLITE_H
#define ONEGYEOK_JSONLITE_H

#include <stddef.h>

/* Deliberately not a general JSON parser: the CONNECT payload is a small, flat,
 * known schema produced by the Node side, so we scan for `"key":` and parse just the
 * value that follows. Good enough for this fixed contract; see docs/기술스택/03_RDP_기술스택.md. */

typedef struct {
	char* host;
	int port;
	char* username;
	char* password;
	char* domain; /* NULL if absent/empty */
	int width;
	int height;
	int colorDepth;
	char* security; /* "tls" | "nla" | "rdp" */
	int ignoreCertificate; /* 0/1 */
} ConnectParams;

/* Parses payload (NOT necessarily NUL-terminated; exactly `len` bytes) into *out.
 * Returns 0 on success (all required fields present), -1 on malformed/missing-required-field. */
int jsonlite_parse_connect(const char* payload, size_t len, ConnectParams* out);

void connect_params_free(ConnectParams* p);

/* Builds `{"width":W,"height":H}` into buf (size buf_size incl. NUL). Returns strlen or -1 if
 * it wouldn't fit. */
int jsonlite_build_connected(char* buf, size_t buf_size, int width, int height);

/* Builds `{"state":"...","message":"..."}` (message omitted if NULL) into buf. */
int jsonlite_build_status(char* buf, size_t buf_size, const char* state, const char* message);

#endif
