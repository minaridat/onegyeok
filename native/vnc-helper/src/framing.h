#ifndef ONEGYEOK_VNC_FRAMING_H
#define ONEGYEOK_VNC_FRAMING_H

#include <stdint.h>
#include <stddef.h>

/* Wire protocol, both directions: [u32 LE length][u8 type][payload (length-1 bytes)].
 * See docs/기술스택/04_VNC_기술스택.md for the authoritative message catalogue. */

typedef struct {
	uint8_t type;
	uint8_t* payload; /* malloc'd, length payload_len; may be NULL if payload_len==0 */
	uint32_t payload_len;
} Frame;

/* Blocking read of exactly one frame from fd. Returns 1 on success (caller must free
 * out->payload), 0 on clean EOF before any byte of a new frame, -1 on error/short read. */
int frame_read(int fd, Frame* out);

/* Writes one frame atomically (serialized via an internal mutex, safe to call from multiple
 * threads) to fd. Returns 0 on success, -1 on error. */
int frame_write(int fd, uint8_t type, const uint8_t* payload, uint32_t payload_len);

#endif
