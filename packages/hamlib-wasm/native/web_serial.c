/*
 * SPDX-License-Identifier: MIT
 *
 * Serial transport implementation of Hamlib's serial port layer.
 *
 * This file *replaces* Hamlib's upstream src/serial.c when building for
 * Emscripten (the build installs it as src/serial.c before configuring).  It
 * keeps the exact upstream entry points and signatures - serial_open(),
 * serial_setup(), serial_flush(), ser_open(), ser_close(), ser_set_rts(),
 * ser_get_rts(), ser_set_dtr(), ser_get_dtr(), ser_set_brk(), ser_get_cts(),
 * ser_get_dsr() and ser_get_car() - so that neither the rig backends nor
 * src/iofunc.c need any knowledge of the transport that acquired the port.
 *
 * Nothing else upstream is touched for the transport: the read()/write()/
 * select() calls src/iofunc.c makes for a serial port are redirected here by
 * the link-time wrapper in native/wrapped_io.c, so upstream's own read loop
 * (including its 7 data bit masking) stays in charge.
 *
 * hamlib_port_t.fd keeps holding an integer, but it is an opaque handle owned
 * by the JavaScript registry (native/web_serial.ts) rather than an operating
 * system descriptor.  All blocking work is exported to JavaScript through
 * imports annotated with __async: "auto", which Emscripten's Asyncify turns
 * back into synchronous-looking C.
 *
 * Provenance: this file is project-owned code, licensed MIT, and is
 * not derived from Hamlib's serial.c.  Hamlib itself remains LGPL-2.1-or-later.
 */

#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/select.h>
#include <sys/types.h>
#include <unistd.h>

#include "hamlib/config.h"
#include "hamlib/rig.h"
#include "hamlib/port.h"

#include "iofunc.h"
#include "misc.h"
#include "serial.h"
#include "generated/codecs.h"
#include "generated/line_settings.h"
#include "web_serial.h"

/* A C string the transport or a codec may leave NULL, or `fallback`. */
static const char *textOr(const char *text, const char *fallback)
{
    return text ? text : fallback;
}

/* --- error mapping ------------------------------------------------------ */

int webserial_map_error(int status)
{
    switch (status)
    {
    case WS_OK:
        return RIG_OK;

    case WS_ERR_CONF:
        return -RIG_ECONF;

    case WS_ERR_INVAL:
        return -RIG_EINVAL;

    case WS_ERR_TIMEOUT:
        return -RIG_ETIMEOUT;

    case WS_ERR_ACCESS:
    case WS_ERR_BUSY:
        return -RIG_EACCESS;

    case WS_ERR_IO:
    default:
        return -RIG_EIO;
    }
}

const char *webserial_last_error(void)
{
    static char buffer[512];
    int len = hamlibWsWriteLastError(buffer, (int) sizeof(buffer));

    if (len <= 0) { return NULL; }

    return buffer;
}

void webserial_clear_error(void)
{
    hamlibWsClearLastError();
}

/* --- handle registry ---------------------------------------------------- */

/*
 * The POSIX wrappers only receive a descriptor, so the transport keeps the
 * set of descriptors it owns, together with the logical path each was opened
 * for.  Serial opens are rare and bounded, so a small linear table beats any
 * allocation.
 */
struct ws_handle
{
    int fd;
    char path[HAMLIB_FILPATHLEN];
};

static struct ws_handle ws_handles[WEBSERIAL_MAX_HANDLES];

int webserial_owns_fd(int fd)
{
    if (fd <= 0) { return 0; }

    for (int i = 0; i < WEBSERIAL_MAX_HANDLES; ++i)
    {
        if (ws_handles[i].fd == fd) { return 1; }
    }

    return 0;
}

int webserial_register_handle(int fd, const char *path)
{
    if (fd <= 0 || webserial_owns_fd(fd)) { return RIG_OK; }

    for (int i = 0; i < WEBSERIAL_MAX_HANDLES; ++i)
    {
        if (ws_handles[i].fd == 0)
        {
            ws_handles[i].fd = fd;
            SNPRINTF(ws_handles[i].path, sizeof(ws_handles[i].path), "%s",
                     path ? path : "");
            return RIG_OK;
        }
    }

    /* Reporting success here would leave the descriptor unowned, so the read
     * and write wrappers would fall through to libc and the port would be
     * driven by the host filesystem.  Fail the open instead. */
    rig_debug(RIG_DEBUG_ERR, "%s: handle table is full\n", __func__);
    return -RIG_ENOMEM;
}

void webserial_unregister_handle(int fd)
{
    for (int i = 0; i < WEBSERIAL_MAX_HANDLES; ++i)
    {
        if (ws_handles[i].fd == fd)
        {
            ws_handles[i].fd = 0;
            ws_handles[i].path[0] = '\0';
        }
    }
}

long webserial_rx_bytes(const char *path)
{
    if (!path || path[0] == '\0') { return -1; }

    for (int i = 0; i < WEBSERIAL_MAX_HANDLES; ++i)
    {
        if (ws_handles[i].fd > 0 && strcmp(ws_handles[i].path, path) == 0)
        {
            return (long) hamlibWsBytesReceived(ws_handles[i].fd);
        }
    }

    return -1;
}

/* --- configuration validation ------------------------------------------ */

/*
 * The settings this build's transport contract accepts are the ones Web Serial
 * can express, listed under `lineSettings` in hamlib.config.yaml.  They apply
 * to every transport - the Node adapter included - so a rig that declares
 * anything else is refused before the port is touched rather than silently
 * downgraded.
 */
static int ws_validate_config(const hamlib_port_t *p)
{
    if (!webserial_supports_data_bits(p->parm.serial.data_bits))
    {
        rig_debug(RIG_DEBUG_ERR,
                  "%s: %d data bits are not supported by the serial transport\n",
                  __func__, p->parm.serial.data_bits);
        return -RIG_ECONF;
    }

    if (!webserial_supports_stop_bits(p->parm.serial.stop_bits))
    {
        rig_debug(RIG_DEBUG_ERR,
                  "%s: %d stop bits are not supported by the serial transport\n",
                  __func__, p->parm.serial.stop_bits);
        return -RIG_ECONF;
    }

    if (!webserial_supports_parity(p->parm.serial.parity))
    {
        rig_debug(RIG_DEBUG_ERR,
                  "%s: %s parity is not supported by the serial transport\n",
                  __func__, textOr(strSerialParity(p->parm.serial.parity), "unknown"));
        return -RIG_ECONF;
    }

    if (!webserial_supports_handshake(p->parm.serial.handshake))
    {
        rig_debug(RIG_DEBUG_ERR,
                  "%s: %s handshake is not supported by the serial transport\n",
                  __func__, textOr(strSerialHandshake(p->parm.serial.handshake), "unknown"));
        return -RIG_ECONF;
    }

    if (p->parm.serial.rate <= 0)
    {
        rig_debug(RIG_DEBUG_ERR,
                  "%s: baud rate %d is not valid for the serial transport\n",
                  __func__, p->parm.serial.rate);
        return -RIG_ECONF;
    }

    return RIG_OK;
}

/*
 * Open rp->pathname with rp's line settings and record the handle in rp->fd.
 * The caller has validated the settings.
 */
static int ws_open_port(hamlib_port_t *rp)
{
    int status;
    int handle = hamlibWsOpenPort(rp->pathname, rp->parm.serial.rate,
                                  rp->parm.serial.data_bits,
                                  rp->parm.serial.stop_bits,
                                  strSerialParity(rp->parm.serial.parity),
                                  strSerialHandshake(rp->parm.serial.handshake));

    if (handle <= 0)
    {
        rig_debug(RIG_DEBUG_ERR, "%s: cannot open %s (%s)\n", __func__,
                  rp->pathname, textOr(webserial_last_error(), "transport error"));
        /* Handles are positive: 0 is no handle, not success. */
        return handle < 0 ? webserial_map_error(handle) : -RIG_EIO;
    }

    status = webserial_register_handle(handle, rp->pathname);

    if (status != RIG_OK)
    {
        hamlibWsClosePort(handle);
        return status;
    }

    rp->fd = handle;
    return RIG_OK;
}

/* --- upstream serial.c contract ---------------------------------------- */

/*
 * Only used by src/iofunc.c for microHam devices, which do not exist in a
 * browser.  Keep the symbol so the upstream declaration is satisfied.
 */
int is_uh_radio_fd(int fd)
{
    (void) fd;
    return 0;
}

/**
 * \brief Open a hamlib_port using the browser transport
 * \param rp rig port descriptor
 * \return RIG_OK or < 0
 */
int HAMLIB_API serial_open(hamlib_port_t *rp)
{
    int status;

    if (!rp)
    {
        return -RIG_EINVAL;
    }

    if (rp->pathname[0] == '\0')
    {
        rig_debug(RIG_DEBUG_ERR, "%s: no pathname registered\n", __func__);
        return -RIG_EINVAL;
    }

    if (strncmp(rp->pathname, WEBSERIAL_PATH_PREFIX,
                strlen(WEBSERIAL_PATH_PREFIX)) != 0)
    {
        rig_debug(RIG_DEBUG_ERR,
                  "%s: '%s' is not a serial transport logical path\n", __func__,
                  rp->pathname);
        return -RIG_EINVAL;
    }

    status = ws_validate_config(rp);

    if (status != RIG_OK)
    {
        return status;
    }

    rig_debug(RIG_DEBUG_VERBOSE, "%s: %s\n", __func__, rp->pathname);

    return ws_open_port(rp);
}

/**
 * \brief Apply serial configuration to an already open port
 * \param rp rig port descriptor
 * \return RIG_OK or < 0
 */
int HAMLIB_API serial_setup(hamlib_port_t *rp)
{
    int status;
    int matches;

    if (!rp)
    {
        return -RIG_EINVAL;
    }

    status = ws_validate_config(rp);

    if (status != RIG_OK)
    {
        return status;
    }

    if (rp->fd <= 0)
    {
        /* Not open yet: serial_open() applies the configuration. */
        return RIG_OK;
    }

    matches = hamlibWsMatchesOpenOptions(rp->fd, rp->parm.serial.rate,
                                         rp->parm.serial.data_bits,
                                         rp->parm.serial.stop_bits,
                                         strSerialParity(rp->parm.serial.parity),
                                         strSerialHandshake(rp->parm.serial.handshake));

    if (matches < 0)
    {
        return webserial_map_error(matches);
    }

    if (matches)
    {
        return RIG_OK;
    }

    /*
     * The transport contract fixes line settings at open(), so a genuine
     * reconfiguration (some backends change the baud rate after talking to
     * the rig) requires closing and reopening the port.  Never pretend the
     * new settings took effect.
     */
    rig_debug(RIG_DEBUG_VERBOSE, "%s: reopening %s for %d baud\n", __func__,
              rp->pathname, rp->parm.serial.rate);

    webserial_unregister_handle(rp->fd);
    status = hamlibWsClosePort(rp->fd);

    if (status < 0)
    {
        rp->fd = -1;
        return webserial_map_error(status);
    }

    rp->fd = -1;

    return ws_open_port(rp);
}

/**
 * \brief Discard bytes already delivered to the JavaScript RX queue
 * \param p rig port descriptor
 * \return RIG_OK
 *
 * The transport contract offers no primitive to flush the operating system or
 * adapter buffers, so this only drops what already reached the read queue.
 */
int HAMLIB_API serial_flush(hamlib_port_t *p)
{
    int status;

    if (!p || p->fd <= 0)
    {
        return RIG_OK;
    }

    status = hamlibWsFlush(p->fd);

    if (status < 0)
    {
        return webserial_map_error(status);
    }

    return RIG_OK;
}

/**
 * \brief Open a serial port and return its handle
 * \param p rig port descriptor
 * \return handle or < 0
 */
int ser_open(hamlib_port_t *p)
{
    int status;

    if (!p)
    {
        return -RIG_EINVAL;
    }

    status = serial_open(p);

    if (status != RIG_OK)
    {
        return status;
    }

    return p->fd;
}

/**
 * \brief Close a serial port
 * \param p rig port descriptor
 * \return RIG_OK or < 0
 */
int ser_close(hamlib_port_t *p)
{
    int status;

    if (!p)
    {
        return -RIG_EINVAL;
    }

    if (p->fd <= 0)
    {
        /* Already closed, or never opened. */
        p->fd = -1;
        return RIG_OK;
    }

    webserial_unregister_handle(p->fd);
    status = hamlibWsClosePort(p->fd);
    p->fd = -1;

    if (status < 0)
    {
        return webserial_map_error(status);
    }

    return RIG_OK;
}

/**
 * \brief Set Request to Send (RTS)
 */
int HAMLIB_API ser_set_rts(hamlib_port_t *p, int state)
{
    if (!p || p->fd <= 0)
    {
        return -RIG_EIO;
    }

    return webserial_map_error(hamlibWsSetSignals(p->fd, state ? 1 : 0, -1, -1));
}

/**
 * \brief Get the last RTS output state requested through the transport
 */
int HAMLIB_API ser_get_rts(hamlib_port_t *p, int *state)
{
    int value;

    if (!p || !state || p->fd <= 0)
    {
        return -RIG_EIO;
    }

    value = hamlibWsLastRts(p->fd);

    if (value < 0)
    {
        return webserial_map_error(value);
    }

    *state = value ? 1 : 0;
    return RIG_OK;
}

/**
 * \brief Set Data Terminal Ready (DTR)
 */
int HAMLIB_API ser_set_dtr(hamlib_port_t *p, int state)
{
    if (!p || p->fd <= 0)
    {
        return -RIG_EIO;
    }

    return webserial_map_error(hamlibWsSetSignals(p->fd, -1, state ? 1 : 0, -1));
}

/**
 * \brief Get the last DTR output state requested through the transport
 */
int HAMLIB_API ser_get_dtr(hamlib_port_t *p, int *state)
{
    int value;

    if (!p || !state || p->fd <= 0)
    {
        return -RIG_EIO;
    }

    value = hamlibWsLastDtr(p->fd);

    if (value < 0)
    {
        return webserial_map_error(value);
    }

    *state = value ? 1 : 0;
    return RIG_OK;
}

/**
 * \brief Assert or clear BREAK
 */
int HAMLIB_API ser_set_brk(const hamlib_port_t *p, int state)
{
    if (!p || p->fd <= 0)
    {
        return -RIG_EIO;
    }

    return webserial_map_error(hamlibWsSetSignals(p->fd, -1, -1, state ? 1 : 0));
}

static int ws_get_input_signal(hamlib_port_t *p, int *state, int bit,
                               const char *what)
{
    int signals;

    if (!p || !state || p->fd <= 0)
    {
        return -RIG_EIO;
    }

    signals = hamlibWsGetSignals(p->fd);

    if (signals < 0)
    {
        rig_debug(RIG_DEBUG_ERR, "%s: cannot read %s - %s\n", __func__, what,
                  webserial_last_error() ? webserial_last_error() : "I/O error");
        return webserial_map_error(signals);
    }

    *state = (signals & bit) ? 1 : 0;
    return RIG_OK;
}

/**
 * \brief Get Carrier Detect (DCD)
 */
int HAMLIB_API ser_get_car(hamlib_port_t *p, int *state)
{
    return ws_get_input_signal(p, state, WEBSERIAL_SIGNAL_DCD, "DCD");
}

/**
 * \brief Get Clear to Send (CTS)
 */
int HAMLIB_API ser_get_cts(hamlib_port_t *p, int *state)
{
    return ws_get_input_signal(p, state, WEBSERIAL_SIGNAL_CTS, "CTS");
}

/**
 * \brief Get Data Set Ready (DSR)
 */
int HAMLIB_API ser_get_dsr(hamlib_port_t *p, int *state)
{
    return ws_get_input_signal(p, state, WEBSERIAL_SIGNAL_DSR, "DSR");
}

/* --- byte primitives used by the link-time wrappers -------------------- */

ssize_t webserial_read_fd(int fd, void *buf, size_t count)
{
    int want;
    int got;

    if (fd <= 0 || !buf)
    {
        return -1;
    }

    /*
     * Hamlib's read_string() shrinks its request to zero bytes once it has
     * learnt the response length, so treat "no bytes requested" as "one byte".
     */
    if (count == 0)
    {
        want = 1;
    }
    else if (count > (size_t) INT_MAX)
    {
        want = INT_MAX;
    }
    else
    {
        want = (int) count;
    }

    got = hamlibWsRead(fd, buf, want);

    if (got < 0)
    {
        errno = EIO;
        return -1;
    }

    if (got == 0)
    {
        errno = EAGAIN;
        return -1;
    }

    errno = 0;
    return got;
}

ssize_t webserial_write_fd(int fd, const void *buf, size_t count)
{
    int written;

    if (fd <= 0)
    {
        errno = EIO;
        return -1;
    }

    if (count == 0)
    {
        return 0;
    }

    if (count > (size_t) INT_MAX)
    {
        errno = EINVAL;
        return -1;
    }

    written = hamlibWsWrite(fd, buf, (int) count);

    if (written < 0)
    {
        errno = EIO;
        return -1;
    }

    /* The JavaScript writer accepts whole chunks or fails. */
    if (written != (int) count)
    {
        errno = EIO;
        return -1;
    }

    return (ssize_t) count;
}

int webserial_select_fd(fd_set *readfds, struct timeval *timeout, int *handled)
{
    int fd = -1;
    int timeout_ms = -1;
    int ready;

    if (handled) { *handled = 0; }

    if (!readfds) { return 0; }

    for (int i = 0; i < WEBSERIAL_MAX_HANDLES; ++i)
    {
        if (ws_handles[i].fd > 0 && FD_ISSET(ws_handles[i].fd, readfds))
        {
            fd = ws_handles[i].fd;
            break;
        }
    }

    if (fd < 0) { return 0; }

    if (handled) { *handled = 1; }

    if (timeout)
    {
        timeout_ms = (int)(timeout->tv_sec * 1000
                           + (timeout->tv_usec + 999) / 1000);
    }

    ready = hamlibWsWaitReadable(fd, timeout_ms);

    if (ready > 0)
    {
        FD_SET(fd, readfds);
        return 1;
    }

    if (ready == 0)
    {
        FD_ZERO(readfds);
        return 0;
    }

    rig_debug(RIG_DEBUG_ERR, "%s: transport failure - %s\n", __func__,
              webserial_last_error() ? webserial_last_error() : "I/O error");
    return -1;
}
