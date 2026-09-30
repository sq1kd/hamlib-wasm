/*
 * Browser (Web Serial) serial transport for the Hamlib WebAssembly build.
 *
 * This header declares the C entry points used by the patched src/iofunc.c.
 * The heavy lifting lives in native/web_serial.js, which owns the logical
 * path registry, the Web Serial streams, the RX byte queue and the signal
 * state.  native/web_serial.c replaces Hamlib's upstream src/serial.c and
 * adapts the ordinary Hamlib serial contract onto those primitives.
 */
#ifndef HAMLIB_WEB_SERIAL_H
#define HAMLIB_WEB_SERIAL_H 1

#include <sys/select.h>
#include <sys/types.h>

#include "hamlib/rig.h"
#include "hamlib/port.h"

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

/* Read already-buffered bytes; never blocks.  Returns the byte count, or a
 * negative RIG_* error.  A zero-length request reads one byte, because
 * Hamlib's read_string() shrinks its request size to zero after the first
 * successful read. */
ssize_t webserial_read(hamlib_port_t *p, void *buf, size_t count);

/* Write the whole buffer, awaiting the Web Serial writer.  Returns the byte
 * count, or a negative RIG_* error. */
ssize_t webserial_write(hamlib_port_t *p, const void *buf, size_t count);

/* select()-style readiness check.  Returns 1 with p->fd set in readfds when
 * buffered data is available, 0 on timeout, -1 on transport failure. */
int webserial_select(hamlib_port_t *p, fd_set *readfds,
                     struct timeval *timeout);

/* Human readable description of the most recent DOM/transport failure, or
 * NULL when none is recorded.  The returned pointer stays valid until the
 * next call to webserial_last_error(). */
const char *webserial_last_error(void);

/* Forget the recorded transport failure. */
void webserial_clear_error(void);

/** @} */

#ifdef __cplusplus
}
#endif

#endif /* HAMLIB_WEB_SERIAL_H */
