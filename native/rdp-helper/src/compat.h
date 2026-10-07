#ifndef ONEGYEOK_COMPAT_H
#define ONEGYEOK_COMPAT_H

/* Thin POSIX shim so framing.c / main.c build unchanged on POSIX and with MSVC on Windows.
 * Only the handful of pthread/unistd calls these helpers actually use are covered. */

#ifdef _WIN32

#ifndef _CRT_NONSTDC_NO_WARNINGS
#define _CRT_NONSTDC_NO_WARNINGS
#endif
#ifndef _CRT_SECURE_NO_WARNINGS
#define _CRT_SECURE_NO_WARNINGS
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif

#include <winsock2.h>
#include <windows.h>
#include <fcntl.h>
#include <io.h>
#include <stdio.h>
#include <stdlib.h>

#define STDIN_FILENO 0
#define STDOUT_FILENO 1

typedef SSIZE_T ssize_t;

/* SRWLOCK has a static initializer and needs no destroy, which mirrors
 * PTHREAD_MUTEX_INITIALIZER usage in this codebase. */
typedef SRWLOCK pthread_mutex_t;
#define PTHREAD_MUTEX_INITIALIZER SRWLOCK_INIT
static inline int pthread_mutex_lock(pthread_mutex_t* m) { AcquireSRWLockExclusive(m); return 0; }
static inline int pthread_mutex_unlock(pthread_mutex_t* m) { ReleaseSRWLockExclusive(m); return 0; }

typedef HANDLE pthread_t;
typedef struct {
	void* (*fn)(void*);
	void* arg;
} compat_thread_start;

static DWORD WINAPI compat_thread_tramp(LPVOID p) {
	compat_thread_start s = *(compat_thread_start*)p;
	free(p);
	s.fn(s.arg);
	return 0;
}

static inline int pthread_create(pthread_t* t, const void* attr, void* (*fn)(void*), void* arg) {
	(void)attr;
	compat_thread_start* s = (compat_thread_start*)malloc(sizeof(*s));
	if (!s) return 1;
	s->fn = fn;
	s->arg = arg;
	*t = CreateThread(NULL, 0, compat_thread_tramp, s, 0, NULL);
	if (!*t) { free(s); return 1; }
	return 0;
}

static inline int pthread_join(pthread_t t, void** ret) {
	(void)ret;
	WaitForSingleObject(t, INFINITE);
	CloseHandle(t);
	return 0;
}

/* The framed protocol is binary: stdin/stdout must not translate \n or stop at ^Z. */
static inline void compat_set_binary_stdio(void) {
	_setmode(_fileno(stdin), _O_BINARY);
	_setmode(_fileno(stdout), _O_BINARY);
}

#define compat_read(fd, buf, n) _read((fd), (buf), (unsigned)(n))
#define compat_write(fd, buf, n) _write((fd), (buf), (unsigned)(n))

#else /* POSIX */

#include <pthread.h>
#include <unistd.h>

static inline void compat_set_binary_stdio(void) {}

#define compat_read(fd, buf, n) read((fd), (buf), (n))
#define compat_write(fd, buf, n) write((fd), (buf), (n))

#endif
#endif
