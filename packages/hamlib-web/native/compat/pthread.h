/*
 * Single-threaded pthread compatibility header for the WebAssembly build.
 *
 * The browser build runs Hamlib on the main thread without Emscripten
 * pthreads, SharedArrayBuffer or cross-origin isolation, and Hamlib is linked
 * without `-pthread`.
 *
 * Types, constants and prototypes are taken verbatim from the platform
 * pthread.h (musl predefines them in bits/alltypes.h, so redefining them
 * breaks every translation unit that has seen a libc header).  On top of
 * those declarations this header enforces the semantics the build depends on:
 *
 *   - mutex and attribute operations are no-ops, because there is exactly one
 *     thread and no contention to resolve,
 *   - thread creation/join/cancel and condition waits fail with ENOSYS, so a
 *     code path that would need a second thread fails loudly instead of
 *     silently degrading or deadlocking the browser event loop.
 *
 * Hamlib never reaches the failing paths in this build: the facade sets
 * async=0 and poll_interval=0 through Hamlib's public configuration before
 * rig_open(), and the pinned patch skips only the Morse worker start.  A
 * backend that would still need a second thread (AnyTone D578A, for example)
 * therefore fails its open loudly instead of degrading quietly.
 *
 * This header must be passed first on the include path so it wins over the
 * platform pthread.h for every Hamlib translation unit.
 */
#ifndef HAMLIB_WEB_COMPAT_PTHREAD_H
#define HAMLIB_WEB_COMPAT_PTHREAD_H 1

#include_next <pthread.h>

#include <errno.h>

/* --- mutexes and attributes: no-ops in a single-threaded build ---------- */

#define pthread_mutex_init(mutex, attr) 0
#define pthread_mutex_destroy(mutex) 0
#define pthread_mutex_lock(mutex) 0
#define pthread_mutex_trylock(mutex) 0
#define pthread_mutex_timedlock(mutex, abstime) 0
#define pthread_mutex_unlock(mutex) 0

#define pthread_mutexattr_init(attr) 0
#define pthread_mutexattr_destroy(attr) 0
#define pthread_mutexattr_settype(attr, type) 0

#define pthread_attr_init(attr) 0
#define pthread_attr_destroy(attr) 0

/* --- thread lifecycle: no second thread can exist ---------------------- */

#define pthread_create(thread, attr, start_routine, arg) (ENOSYS)
#define pthread_join(thread, retval) (ENOSYS)
#define pthread_cancel(thread) (ENOSYS)
#define pthread_detach(thread) (ENOSYS)

/* --- condition variables: a wait could never be woken ------------------ */

#define pthread_cond_wait(cond, mutex) (ENOSYS)
#define pthread_cond_timedwait(cond, mutex, abstime) (ENOSYS)

#endif /* HAMLIB_WEB_COMPAT_PTHREAD_H */
