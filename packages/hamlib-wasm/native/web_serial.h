/*
 * SPDX-License-Identifier: MIT
 *
 * Serial transport for the Hamlib WebAssembly build (Web Serial in the
 * browser, node-serialport in Node; see native/web_serial.ts).
 *
 * This header is Hamlib-free on purpose: it is included by the project-owned
 * replacement of Hamlib's `src/serial.c`, by the facade and by the link-time
 * shims in `native/wrapped_io.cpp`.  Keeping it free of Hamlib types means the
 * shims can be compiled and reasoned about without the upstream include path.
 *
 * The heavy lifting lives in `native/web_serial.ts`, which owns the logical
 * path registry, the port streams, the RX byte queue and the signal state.
 * `native/web_serial.c` adapts Hamlib's ordinary serial contract onto those
 * primitives, and `native/wrapped_io.cpp` redirects the POSIX calls Hamlib's
 * `src/iofunc.c` and `src/sleep.c` make for a serial port to them.
 *
 * The status codes and signal bits below are the whole contract between the
 * two languages: the generator reads them from this header and hands them to
 * `native/web_serial.ts` as `WsStatus`/`WsSignal`.
 *
 * Provenance: project-owned code, MIT.
 */
#ifndef HAMLIB_WASM_SERIAL_H
#define HAMLIB_WASM_SERIAL_H 1

#include <sys/select.h>
#include <sys/time.h>
#include <sys/types.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Positive integer handles returned by the JavaScript transport are stored in
 * hamlib_port_t.fd.  Logical paths use this opaque prefix.  The macro keeps its
 * historical name; the path namespace is the transport's own, so it says
 * nothing about which transport acquired the port.
 *
 * The separator must not be ':' and the path must contain '/', because
 * Hamlib's rig_open() runs the pathname through parse_hoststr() and switches a
 * "host:port" looking path to RIG_PORT_NETWORK; a path containing '/' is
 * explicitly treated as a device path (misc.c parse_hoststr()). */
#define WEBSERIAL_PATH_PREFIX "serial/"

/* Open handles the wrappers can dispatch on.  A rig uses one CAT port and at
 * most one shared PTT/DCD port, so this is generous. */
#define WEBSERIAL_MAX_HANDLES 16

/* What the JavaScript transport returns on failure; webserial_map_error()
 * translates it into a Hamlib error code. */
enum ws_status
{
    WS_OK = 0,
    WS_ERR_IO = -1,
    WS_ERR_CONF = -2,
    WS_ERR_INVAL = -3,
    WS_ERR_TIMEOUT = -4,
    WS_ERR_ACCESS = -5,
    WS_ERR_BUSY = -6
};

/* Bit layout of the modem status word returned by hamlibWsGetSignals(). */
enum ws_signal
{
    WEBSERIAL_SIGNAL_CTS = 0x1,
    WEBSERIAL_SIGNAL_DSR = 0x2,
    WEBSERIAL_SIGNAL_DCD = 0x4,
    WEBSERIAL_SIGNAL_RI = 0x8
};

/* --- JavaScript transport imports (native/web_serial.ts) ---------------- */

/* Bind a port the TypeScript layer stored under `token` to a logical path. */
int hamlibWsRegisterPort(const char *path, int token);
int hamlibWsUnregisterPort(const char *path);
/* Release every registered port from JavaScript; used by destroy() and by the
 * TypeScript layer when a native call is stuck. */
int hamlibWsForceCloseAll(void);
/* One formatted Hamlib debug line, handed to the JavaScript log hook. */
void hamlibWsLog(int level, const char *message);

/* A positive handle, or a WS_ERR_* status.  `parity` and `flow_control` are
 * Hamlib's names for the line settings (see generated/codecs.h). */
int hamlibWsOpenPort(const char *path, int rate, int data_bits, int stop_bits,
                     const char *parity, const char *flow_control);
int hamlibWsClosePort(int handle);
/* 1 when the open handle already runs these settings, 0 when not. */
int hamlibWsMatchesOpenOptions(int handle, int rate, int data_bits,
                               int stop_bits, const char *parity,
                               const char *flow_control);
/* Buffered bytes copied (0 when none), never blocking. */
int hamlibWsRead(int handle, void *buf, int len);
int hamlibWsBytesReceived(int handle);
int hamlibWsWrite(int handle, const void *buf, int len);
/* 1 when bytes are buffered, 0 on timeout; `timeout_ms` -1 waits forever. */
int hamlibWsWaitReadable(int handle, int timeout_ms);
int hamlibWsFlush(int handle);
/* -1 leaves a line as it is. */
int hamlibWsSetSignals(int handle, int rts, int dtr, int brk);
/* A ws_signal mask. */
int hamlibWsGetSignals(int handle);
int hamlibWsLastRts(int handle);
int hamlibWsLastDtr(int handle);
int hamlibWsWriteLastError(char *buf, int len);
int hamlibWsClearLastError(void);

/* --- status ------------------------------------------------------------- */

/* The Hamlib error code for a transport status: RIG_OK for WS_OK, -RIG_EIO
 * for a status it has no closer code for. */
int webserial_map_error(int status);

/* --- handle registry ---------------------------------------------------- */

/* True when fd is a handle this transport handed out and has not closed. */
int webserial_owns_fd(int fd);

/* Record a freshly opened handle for `path`.  RIG_OK, or -RIG_ENOMEM when the
 * table is full - the caller must then close the handle again. */
int webserial_register_handle(int fd, const char *path);

/* Forget a handle.  No-op for unknown values, so it is safe to call twice. */
void webserial_unregister_handle(int fd);

/* Bytes the rig has sent on `path` since the port was opened, or -1 when
 * `path` is not an open handle.
 *
 * rig_open() reads the rig's state and discards the result, so a line that
 * never answered still looks opened.  This counter is the ground truth behind
 * that: it is never cleared by a read, so it answers "has anything at all
 * arrived from this rig", which is what the facade asks after opening. */
long webserial_rx_bytes(const char *path);

/* --- byte primitives ---------------------------------------------------- */

/* Read already-buffered bytes; never blocks.  Returns the byte count, or -1
 * with errno EAGAIN when nothing is buffered and EIO on a transport failure,
 * as read() would. */
ssize_t webserial_read_fd(int fd, void *buf, size_t count);

/* Write the whole buffer, awaiting the transport's writer.  Returns the byte
 * count, or -1 with errno set (EIO, or EINVAL for an oversized buffer), as
 * write() would. */
ssize_t webserial_write_fd(int fd, const void *buf, size_t count);

/* select()-style readiness check for the handle in readfds.
 *
 * `*handled` is set to 1 when one of the registered handles is present in
 * readfds and the transport served the call; it is left at 0 when the sets do
 * not mention the serial transport, so the caller can fall back to the real
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

#endif /* HAMLIB_WASM_SERIAL_H */
