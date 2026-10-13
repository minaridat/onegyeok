#include "jsonlite.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const char* skip_ws(const char* p, const char* end) {
	while (p < end && (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r')) p++;
	return p;
}

/* Finds `"key"` followed (after optional whitespace) by `:`, requiring the quote
 * delimiters so we don't match the key name appearing inside some other value. Returns a
 * pointer to the first byte of the value (after the colon and any whitespace), or NULL. */
static const char* find_key(const char* buf, const char* end, const char* key) {
	size_t keylen = strlen(key);
	const char* p = buf;
	while (p + keylen + 2 <= end) {
		if (p[0] == '"' && memcmp(p + 1, key, keylen) == 0 && p[1 + keylen] == '"') {
			const char* v = skip_ws(p + 2 + keylen, end);
			if (v < end && *v == ':') return skip_ws(v + 1, end);
		}
		p++;
	}
	return NULL;
}

/* Parses a JSON string literal starting at *pp (which must point at the opening '"').
 * Advances *pp past the closing '"'. Returns a malloc'd, unescaped, NUL-terminated string,
 * or NULL on malformed input. Supports \" \\ \/ \n \r \t \b \f and \uXXXX (BMP only). */
static char* parse_json_string(const char** pp, const char* end) {
	const char* p = *pp;
	if (p >= end || *p != '"') return NULL;
	p++;
	char* buf = malloc((size_t)(end - p) + 1);
	if (!buf) return NULL;
	size_t out = 0;
	while (p < end && *p != '"') {
		if (*p == '\\' && p + 1 < end) {
			p++;
			switch (*p) {
				case '"': buf[out++] = '"'; break;
				case '\\': buf[out++] = '\\'; break;
				case '/': buf[out++] = '/'; break;
				case 'n': buf[out++] = '\n'; break;
				case 'r': buf[out++] = '\r'; break;
				case 't': buf[out++] = '\t'; break;
				case 'b': buf[out++] = '\b'; break;
				case 'f': buf[out++] = '\f'; break;
				case 'u': {
					if (p + 4 >= end) { free(buf); return NULL; }
					unsigned int cp = 0;
					for (int i = 1; i <= 4; i++) {
						char c = p[i];
						cp <<= 4;
						if (c >= '0' && c <= '9') cp |= (unsigned int)(c - '0');
						else if (c >= 'a' && c <= 'f') cp |= (unsigned int)(c - 'a' + 10);
						else if (c >= 'A' && c <= 'F') cp |= (unsigned int)(c - 'A' + 10);
						else { free(buf); return NULL; }
					}
					p += 4;
					/* Minimal UTF-8 encode (BMP only, no surrogate-pair handling — adequate
					 * for the ASCII-dominant fields this schema carries). */
					if (cp < 0x80) {
						buf[out++] = (char)cp;
					} else if (cp < 0x800) {
						buf[out++] = (char)(0xC0 | (cp >> 6));
						buf[out++] = (char)(0x80 | (cp & 0x3F));
					} else {
						buf[out++] = (char)(0xE0 | (cp >> 12));
						buf[out++] = (char)(0x80 | ((cp >> 6) & 0x3F));
						buf[out++] = (char)(0x80 | (cp & 0x3F));
					}
					break;
				}
				default: free(buf); return NULL;
			}
			p++;
		} else {
			buf[out++] = *p++;
		}
	}
	if (p >= end) { free(buf); return NULL; } /* unterminated string */
	buf[out] = '\0';
	*pp = p + 1;
	return buf;
}

static char* get_string_field(const char* buf, const char* end, const char* key, int required, int* ok) {
	const char* v = find_key(buf, end, key);
	if (!v) {
		if (required) *ok = 0;
		return NULL;
	}
	if (v < end && *v == 'n' && v + 4 <= end && memcmp(v, "null", 4) == 0) return NULL;
	char* s = parse_json_string(&v, end);
	if (!s && required) *ok = 0;
	return s;
}

static int get_int_field(const char* buf, const char* end, const char* key, int dflt, int* ok, int required) {
	const char* v = find_key(buf, end, key);
	if (!v) {
		if (required) *ok = 0;
		return dflt;
	}
	char* endptr = NULL;
	long val = strtol(v, &endptr, 10);
	if (endptr == v) {
		if (required) *ok = 0;
		return dflt;
	}
	return (int)val;
}

int jsonlite_parse_connect(const char* payload, size_t len, ConnectParams* out) {
	memset(out, 0, sizeof(*out));
	const char* buf = payload;
	const char* end = payload + len;
	int ok = 1;

	out->host = get_string_field(buf, end, "host", 1, &ok);
	out->password = get_string_field(buf, end, "password", 1, &ok);

	out->port = get_int_field(buf, end, "port", 5900, &ok, 1);
	out->colorDepth = get_int_field(buf, end, "colorDepth", 32, &ok, 0);

	if (!ok) {
		connect_params_free(out);
		return -1;
	}
	return 0;
}

void connect_params_free(ConnectParams* p) {
	free(p->host);
	free(p->password);
	memset(p, 0, sizeof(*p));
}

int jsonlite_build_connected(char* buf, size_t buf_size, int width, int height) {
	int n = snprintf(buf, buf_size, "{\"width\":%d,\"height\":%d}", width, height);
	if (n < 0 || (size_t)n >= buf_size) return -1;
	return n;
}

/* Escapes `"` and `\` and control chars minimally — error strings from libvncclient are the
 * only untrusted-ish input here, and this is enough to keep the JSON well-formed. */
static int append_escaped(char* buf, size_t buf_size, size_t* pos, const char* s) {
	for (const char* p = s; *p; p++) {
		const char* rep = NULL;
		char tmp[3];
		if (*p == '"') rep = "\\\"";
		else if (*p == '\\') rep = "\\\\";
		else if (*p == '\n') rep = "\\n";
		else if (*p == '\r') rep = "\\r";
		else if ((unsigned char)*p < 0x20) { snprintf(tmp, sizeof(tmp), "%02x", *p); rep = tmp; }
		if (rep) {
			size_t rl = strlen(rep);
			if (*pos + rl >= buf_size) return -1;
			memcpy(buf + *pos, rep, rl);
			*pos += rl;
		} else {
			if (*pos + 1 >= buf_size) return -1;
			buf[(*pos)++] = *p;
		}
	}
	return 0;
}

int jsonlite_build_status(char* buf, size_t buf_size, const char* state, const char* message) {
	size_t pos = 0;
	const char* head = "{\"state\":\"";
	size_t hl = strlen(head);
	if (pos + hl >= buf_size) return -1;
	memcpy(buf, head, hl);
	pos += hl;
	if (append_escaped(buf, buf_size, &pos, state) < 0) return -1;
	if (pos + 1 >= buf_size) return -1;
	buf[pos++] = '"';
	if (message) {
		const char* mid = ",\"message\":\"";
		size_t ml = strlen(mid);
		if (pos + ml >= buf_size) return -1;
		memcpy(buf + pos, mid, ml);
		pos += ml;
		if (append_escaped(buf, buf_size, &pos, message) < 0) return -1;
		if (pos + 1 >= buf_size) return -1;
		buf[pos++] = '"';
	}
	if (pos + 1 >= buf_size) return -1;
	buf[pos++] = '}';
	buf[pos] = '\0';
	return (int)pos;
}
