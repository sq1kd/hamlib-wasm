/*
 * Browser (Web Serial) serial transport for the Hamlib WebAssembly build.
 *
 * This header is Hamlib-free on purpose: it is included both by the
 * project-owned replacement of Hamlib's `src/serial.c` and by the small
 * link-time shims in `native/wrapped_io.c`.  Keeping it free of Hamlib types
 * means the shims can be compiled and reasoned about without the upstream
 * include path.
 *
 * The heavy lifting lives in `native/web_serial.ts`, which owns the logical
 * path registry, the Web Serial streams, the RX byte queue and the signal
 * state.  `native/web_serial.c` adapts Hamlib's ordinary serial contract onto
 * those primitives, and `native/wrapped_io.c` redirects the POSIX calls
 * Hamlib's `src/iofunc.c` and `src/sleep.c` make for a serial port to them.
 *
 * Provenance: project-owned code, UNLICENSED.
 */
#ifndef HAMLIB_WEB_SERIAL_H
#define HAMLIB_WEB_SERIAL_H 1

#include <sys/select.h>
#include <sys/time.h>
#include <sys/types.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Positive integer handles returned by the JavaScript transport are stored in
 * hamlib_port_t.fd.  Logical paths use this opaque prefix.
 *
 * The separator must not be ':' and the path must contain '/', because
 * Hamlib's rig_open() runs the pathname through parse_hoststr() and switches a
 * "host:port" looking path to RIG_PORT_NETWORK; a path containing '/' is
 * explicitly treated as a device path (misc.c parse_hoststr()). */
#define WEBSERIAL_PATH_PREFIX "webserial/"

/* Open handles the wrappers can dispatch on.  A rig uses one CAT port and at
 * most one shared PTT/DCD port, so this is generous. */
#define WEBSERIAL_MAX_HANDLES 16

/* Error sentinels returned by the JavaScript transport.  They are translated
 * into Hamlib error codes by ws_map_error(). */
#define WS_OK          0
#define WS_ERR_IO     -1
#define WS_ERR_CONF   -2
#define WS_ERR_INVAL  -3
#define WS_ERR_TIMEOUT -4
#define WS_ERR_ACCESS -5
#define WS_ERR_BUSY   -6

/* Bit layout of the modem status word returned by hamlibWsGetSignals(). */
#define WEBSERIAL_SIGNAL_CTS 0x1
#define WEBSERIAL_SIGNAL_DSR 0x2
#define WEBSERIAL_SIGNAL_DCD 0x4
#define WEBSERIAL_SIGNAL_RI  0x8

/* --- handle registry ---------------------------------------------------- */

/* True when fd is a handle this transport handed out and has not closed. */
int webserial_owns_fd(int fd);

/* Record a freshly opened handle.  No-op when the table is full. */
void webserial_register_handle(int fd);

/* Forget a handle.  No-op for unknown values, so it is safe to call twice. */
void webserial_unregister_handle(int fd);

/* --- byte primitives ---------------------------------------------------- */

/* Read already-buffered bytes; never blocks.  Returns the byte count, sets
 * errno to EAGAIN and returns -1 when nothing is buffered, or returns a
 * negative WS_ERR_* sentinel on a transport failure. */
ssize_t webserial_read_fd(int fd, void *buf, size_t count);

/* Write the whole buffer, awaiting the Web Serial writer.  Returns the byte
 * count, or a negative WS_ERR_* sentinel. */
ssize_t webserial_write_fd(int fd, const void *buf, size_t count);

/* select()-style readiness check for the handle in readfds.
 *
 * `*handled` is set to 1 when one of the registered handles is present in
 * readfds and the transport served the call; it is left at 0 when the sets do
 * not mention the browser transport, so the caller can fall back to the real
 * select().  Returns 1 (ready), 0 (timeout) or -1 (transport failure). */
int webserial_select_fd(fd_set *readfds, struct timeval *timeout, int *handled);

/* --- diagnostics -------------------------------------------------------- */

/* Human readable description of the most recent DOM/transport failure, or
 * NULL when none is recorded.  The returned pointer stays valid until the
 * next call to webserial_last_error(). */
const char *webserial_last_error(void);

/* Forget the recorded transport failure. */
void webserial_clear_error(void);

#ifdef __cplusplus
}
#endif

#endif /* HAMLIB_WEB_SERIAL_H */
