/*
 * Monotonic clock for the Hamlib WebAssembly build.
 *
 * Hamlib's src/sleep.c calls monotonic_seconds() to measure how long a delay
 * actually took.  Upstream provides that symbol in lib/precise_time.c, which is
 * GPL-3.0-or-later.  The linker redirects the reference here with
 * `-Wl,--wrap=monotonic_seconds`, so precise_time.o is never pulled into the
 * WASM binary.  This implementation uses Emscripten's monotonic clock and is
 * original project code.
 *
 * SPDX-License-Identifier: MIT
 */

#include <emscripten.h>

#ifdef __cplusplus
extern "C" {
#endif

double __wrap_monotonic_seconds(void)
{
    return emscripten_get_now() / 1000.0;
}

#ifdef __cplusplus
}
#endif
