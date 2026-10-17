# Third-party notices

This file describes the third-party material distributed with `hamlib-wasm`.
It is a notice inventory, not a replacement for the license texts under
`LICENSES/` or the upstream notices retained in the source archive.

## Hamlib 4.7.2

- Upstream project: https://github.com/Hamlib/Hamlib
- Version: 4.7.2
- Release tag object: `f4fe0e5feab233cf45606f63d7f2fdcb7d5579dc`
- Commit: `40f63488fe0bd751b147f48d62fd217bf53713a0`
- Source archive: https://github.com/Hamlib/Hamlib/releases/download/4.7.2/hamlib-4.7.2.tar.gz
- Source archive SHA-256: `ae1fcf2dbc80ea0786ea8f047b09399c3f7737d1930442f61a031708ed33e88f`
- Upstream licensing statement: https://github.com/Hamlib/Hamlib/blob/4.7.2/LICENSE
- Copyright: Hamlib contributors; the original upstream `AUTHORS`, `LICENSE`,
  `COPYING` and `COPYING.LIB` files are retained in the source kit.
- Library frontend, backends and our changes to them: `LGPL-2.1-or-later`.
- Local changes: the WASM integration patch in
  `dist/third_party/hamlib/hamlib-4.7.2-web.patch`; the patch contains a dated
  modification notice in the modified `src/rig.c`. The browser transport is
  supplied by replacing `src/serial.c` at build time with our own
  `native/web_serial.c`; it is not an upstream edit.
- Corresponding source and relinking instructions: see `REBUILDING.md`,
  `dist/third_party/hamlib/SOURCE.json` and
  `dist/third_party/hamlib/corresponding-source.tar.gz`.
- Full LGPL text: `LICENSES/LGPL-2.1-or-later.txt` and the upstream
  `COPYING.LIB` retained in the source kit.

## GPL-covered materials in the upstream source archive

The corresponding-source archive contains Hamlib's complete upstream source
tree. Some files in that tree are not part of the linked WASM binary and carry
their own licenses:

- Hamlib utilities, test programs and examples: generally
  `GPL-2.0-or-later`. The full text is in `LICENSES/GPL-2.0-or-later.txt`.
- `lib/precise_time.c`: `GPL-3.0-or-later`, copyright Dave Freese, W1HKJ and
  Alex Reece. The build does not link this file. Hamlib's `src/sleep.c`
  reference to `monotonic_seconds()` is redirected by the linker
  (`--wrap=monotonic_seconds`) to the original MIT implementation in
  `native/monotonic_time.c`. The full GPL-3.0 text is in
  `LICENSES/GPL-3.0-or-later.txt`.
- `security/aes.c`, `security/sha256.c` and related security helpers:
  `GPL-2.0-or-later`. They are present in the upstream archive but no linked
  object references them, so they are not included in the WASM.
- `lib/getopt*.c`, `rigs/kit/si570avrusb.h`,
  `rigs/winradio/linradio/wrapi.h`: GPL-licensed upstream files that are not
  compiled into this build (no libusb, no WinRadio backend, and the getopt
  helpers are not part of `libhamlib`).
- `rigs/tuner/videodev*.h`: GPL-2.0-or-later with a BSD-3-Clause alternative.
  The Video4Linux backends are not enabled in this build.

The linked-input audit in `dist/third_party/hamlib/LINK_INPUTS.json` lists
every object pulled from `libhamlib.a` into the final WASM. It contains no
`GPL-`-licensed entry. The GPL files above are present only as corresponding
source in the archive.

## cJSON

`lib/cJSON.c` and `lib/cJSON.h` are part of Hamlib's source tree and are
compiled into Hamlib. cJSON is Copyright (c) 2009-2017 Dave Gamble and cJSON
contributors, licensed under the MIT License. The upstream header is retained
in the source archive; the MIT text is `LICENSES/MIT.txt`.

## Emscripten and toolchain runtime

The native WASM loader and runtime were generated with Emscripten 6.0.10.
Emscripten is available under the MIT License or the University of
Illinois/NCSA Open Source License. The full text and copyright notice are in
`LICENSES/Emscripten.txt`.

The binary and loader include Emscripten sysroot runtime components. musl libc
is MIT-licensed. compiler-rt and libc++ are Apache-2.0-licensed with the LLVM
Exceptions; see `LICENSES/Apache-2.0.txt` and `LICENSES/LLVM.txt`. Those
components are part of the toolchain, not Hamlib code.

## Project-owned bridge

`native/facade.cpp`, `native/wrapped_io.cpp`, `native/monotonic_time.c`,
`native/web_serial.c`, `native/web_serial.h`, `native/web_serial.ts`,
`native/compat/pthread.h`, the generated `native/generated/*.inc`, and the
TypeScript runtime are original project code licensed under MIT. They are
included in the corresponding-source kit so a recipient can relink the WASM
with a modified Hamlib.
