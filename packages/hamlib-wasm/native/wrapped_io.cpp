/*
 * SPDX-License-Identifier: MIT
 *
 * Link-time replacement of the POSIX calls Hamlib makes on a serial port.
 *
 * Hamlib's `src/iofunc.c` reads, writes and waits on `hamlib_port_t.fd`, and
 * `src/sleep.c` waits with `nanosleep()`.  In this build those descriptors are
 * opaque handles owned by the browser transport, and blocking the thread would
 * stall the browser event loop, so the calls are redirected here instead of
 * patching upstream:
 *
 *   read()       -> the JavaScript RX queue (native/web_serial.c)
 *   write()      -> the Web Serial writer
 *   select()     -> the transport's waitReadable()
 *   nanosleep()  -> emscripten_sleep(), so Asyncify can settle pending
 *                   browser promises while the delay elapses
 *
 * Anything not addressed to a browser transport handle falls through to the
 * real libc function, so network, file and console I/O are unaffected.  This
 * keeps upstream's own logic - the read loop, the 7 data bit masking in
 * `port_read_generic`, the retry accounting and the timeout handling in
 * `read_block_generic` - in charge of the protocol.
 *
 * The wrappers are installed by the linker flags in
 * `build/compile-native.ts` via `LINK_ARGS` (`-Wl,--wrap=read`, ...).
 *
 * This file is C++ because the module is linked with `em++`, which compiles a
 * `.c` input as C++ and would mangle the wrapper names the linker looks for.
 * The wrappers therefore carry explicit C linkage.
 *
 * Provenance: project-owned code, MIT.
 */

#include <emscripten.h>

#include <errno.h>
#include <sys/select.h>
#include <sys/types.h>
#include <time.h>

#include "web_serial.h"

extern "C"
{

    extern ssize_t __real_read(int fd, void *buf, size_t count);
    extern ssize_t __real_write(int fd, const void *buf, size_t count);
    extern int __real_select(int nfds, fd_set *readfds, fd_set *writefds,
                             fd_set *exceptfds, struct timeval *timeout);
    extern int __real_nanosleep(const struct timespec *req,
                                struct timespec *rem);

    ssize_t __wrap_read(int fd, void *buf, size_t count)
    {
        if (!webserial_owns_fd(fd))
        {
            return __real_read(fd, buf, count);
        }

        return webserial_read_fd(fd, buf, count);
    }

    ssize_t __wrap_write(int fd, const void *buf, size_t count)
    {
        if (!webserial_owns_fd(fd))
        {
            return __real_write(fd, buf, count);
        }

        return webserial_write_fd(fd, buf, count);
    }

    int __wrap_select(int nfds, fd_set *readfds, fd_set *writefds,
                      fd_set *exceptfds, struct timeval *timeout)
    {
        int handled = 0;
        int result = webserial_select_fd(readfds, timeout, &handled);

        if (!handled)
        {
            return __real_select(nfds, readfds, writefds, exceptfds, timeout);
        }

        /*
         * select() always clears writefds/exceptfds and rewrites readfds.
         * The browser transport has no exceptional conditions, so leaving
         * those bits set would make port_wait_for_data_direct() report a
         * spurious EIO.
         */
        if (exceptfds) { FD_ZERO(exceptfds); }

        if (writefds) { FD_ZERO(writefds); }

        return result;
    }

    int __wrap_nanosleep(const struct timespec *req, struct timespec *rem)
    {
        unsigned long long milliseconds;

        if (rem)
        {
            rem->tv_sec = 0;
            rem->tv_nsec = 0;
        }

        if (!req || req->tv_sec < 0 || req->tv_nsec < 0)
        {
            errno = EINVAL;
            return -1;
        }

        milliseconds = (unsigned long long) req->tv_sec * 1000ULL
                       + ((unsigned long long) req->tv_nsec + 999999ULL)
                       / 1000000ULL;

        /*
         * Asyncify: hand control back to the browser event loop so pending
         * Web Serial promises can settle while the requested delay elapses.
         * A zero-length wait returns immediately; yielding there would only
         * add a task to the queue.
         */
        if (milliseconds > 0)
        {
            emscripten_sleep((unsigned int) milliseconds);
        }

        return 0;
    }

} // extern "C"
