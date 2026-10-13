#include "framing.h"

#include <errno.h>
#include <pthread.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static pthread_mutex_t g_write_mutex = PTHREAD_MUTEX_INITIALIZER;

static int read_exact(int fd, uint8_t* buf, size_t n) {
	size_t got = 0;
	while (got < n) {
		ssize_t r = read(fd, buf + got, n - got);
		if (r == 0) return 0; /* EOF */
		if (r < 0) {
			if (errno == EINTR) continue;
			return -1;
		}
		got += (size_t)r;
	}
	return 1;
}

static int write_exact(int fd, const uint8_t* buf, size_t n) {
	size_t sent = 0;
	while (sent < n) {
		ssize_t w = write(fd, buf + sent, n - sent);
		if (w < 0) {
			if (errno == EINTR) continue;
			return -1;
		}
		sent += (size_t)w;
	}
	return 0;
}

int frame_read(int fd, Frame* out) {
	uint8_t lenbuf[4];
	int rc = read_exact(fd, lenbuf, 4);
	if (rc <= 0) return rc; /* 0 = clean EOF, -1 = error */

	uint32_t length = (uint32_t)lenbuf[0] | ((uint32_t)lenbuf[1] << 8) |
	                   ((uint32_t)lenbuf[2] << 16) | ((uint32_t)lenbuf[3] << 24);
	if (length < 1 || length > (64u * 1024 * 1024)) return -1; /* sanity bound */

	uint8_t* body = malloc(length);
	if (!body) return -1;
	rc = read_exact(fd, body, length);
	if (rc <= 0) {
		free(body);
		return -1; /* mid-frame EOF is always an error, not clean */
	}

	out->type = body[0];
	out->payload_len = length - 1;
	if (out->payload_len > 0) {
		out->payload = malloc(out->payload_len);
		if (!out->payload) {
			free(body);
			return -1;
		}
		memcpy(out->payload, body + 1, out->payload_len);
	} else {
		out->payload = NULL;
	}
	free(body);
	return 1;
}

int frame_write(int fd, uint8_t type, const uint8_t* payload, uint32_t payload_len) {
	uint32_t length = payload_len + 1;
	uint8_t header[5];
	header[0] = (uint8_t)(length & 0xFF);
	header[1] = (uint8_t)((length >> 8) & 0xFF);
	header[2] = (uint8_t)((length >> 16) & 0xFF);
	header[3] = (uint8_t)((length >> 24) & 0xFF);
	header[4] = type;

	pthread_mutex_lock(&g_write_mutex);
	int rc = write_exact(fd, header, 5);
	if (rc == 0 && payload_len > 0) rc = write_exact(fd, payload, payload_len);
	pthread_mutex_unlock(&g_write_mutex);
	return rc;
}
