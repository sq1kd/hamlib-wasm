# Third-party notices

This file describes the third-party material distributed with `hamlib-wasm`.
It is a notice inventory, not a replacement for the license texts under
`LICENSES/` or the upstream notices retained in the source archive.

## Hamlib

- Upstream project: https://github.com/Hamlib/Hamlib
- Release: pinned in `packages/hamlib-wasm/hamlib.config.yaml`. The npm package
  records the exact version, commit, tag object, archive URL and archive and
  patch SHA-256 values in `dist/third_party/hamlib/SOURCE.json` and
  `REBUILDING.md`.
- Copyright: Hamlib contributors. The upstream `AUTHORS`, `LICENSE`, `COPYING`
  and `COPYING.LIB` files ship unchanged in `dist/third_party/hamlib/` and in
  the source kit.
- Library frontend, backends and our changes to them: `LGPL-2.1-or-later`.
  The full text is `LICENSES/LGPL-2.1-or-later.txt`.
- Local changes: the WASM integration patch in `dist/third_party/hamlib/`
  modifies `src/rig.c` only and carries a dated modification notice. The
  browser transport replaces `src/serial.c` at build time with our own
  `native/web_serial.c`; it is not an upstream edit.
- Corresponding source and relinking instructions: `REBUILDING.md` and
  `dist/third_party/hamlib/corresponding-source.tar.gz`.

## GPL-covered files in the upstream source archive

The corresponding-source kit contains Hamlib's complete upstream source tree,
not a selected subset. Some files in that tree carry their own licenses and are
not part of the linked WASM:

- Hamlib utilities, test programs and examples: generally
  `GPL-2.0-or-later` (`LICENSES/GPL-2.0-or-later.txt`).
- `lib/precise_time.c`: `GPL-3.0-or-later`, copyright Dave Freese, W1HKJ and
  Alex Reece (`LICENSES/GPL-3.0-or-later.txt`). Hamlib's `src/sleep.c` calls
  `monotonic_seconds()`, which would pull this file in. The link uses
  `-Wl,--wrap=monotonic_seconds` to redirect that call to the original MIT
  implementation in `native/monotonic_time.c`, so `precise_time.o` is not
  linked.
- `security/aes.c`, `security/sha256.c` and related helpers:
  `GPL-2.0-or-later`. No linked object references them.
- `lib/getopt*.c`, `rigs/kit/si570avrusb.h` and
  `rigs/winradio/linradio/wrapi.h`: GPL-licensed and not compiled into this
  build (no libusb, no WinRadio backend, and getopt is not part of
  `libhamlib`).
- `rigs/tuner/videodev*.h`: GPL-2.0-or-later with a BSD-3-Clause alternative;
  the Video4Linux backends are not enabled.

## Linked-input audit

Every build parses the wasm-ld link map and writes
`dist/third_party/hamlib/LINK_INPUTS.json`: each object pulled from
`libhamlib.a`, its upstream source and its license, classified from the source
header with Hamlib's upstream `LICENSE` policy as the fallback for library
sources. The build fails if a linked object is GPL-licensed or cannot be
classified, and `verify-package` re-checks the packed tarball for the same
conditions and for the absence of `precise_time.o`. A new backend or linked
dependency changes this file and should be reviewed there.

## cJSON

`lib/cJSON.c` and `lib/cJSON.h` are part of Hamlib's source tree and are
compiled into Hamlib. cJSON is Copyright (c) 2009-2017 Dave Gamble and cJSON
contributors, licensed under the MIT License. The upstream header is retained
in the source archive.

## Emscripten and toolchain runtime

The WASM loader and runtime are generated with Emscripten; the version used is
recorded in `dist/third_party/hamlib/SOURCE.json`. Emscripten is available
under the MIT License or the University of Illinois/NCSA Open Source License
(`LICENSES/Emscripten.txt`).

The binary includes Emscripten sysroot runtime components. musl libc is
MIT-licensed. compiler-rt and libc++ are licensed under the Apache License 2.0
with LLVM Exceptions (`LICENSES/LLVM.txt`). These are toolchain components,
not Hamlib code.

## Project-owned bridge and generated bindings

`native/facade.cpp`, `native/wrapped_io.cpp`, `native/monotonic_time.c`,
`native/web_serial.c`, `native/web_serial.h`, `native/web_serial.ts`,
`native/compat/pthread.h` and the TypeScript runtime are original project code
licensed under MIT. They are included in the source kit so a recipient can
relink the WASM with a modified Hamlib.

`packages/hamlib-codegen` generates `native/generated/*.inc` and
`src/native/generated/**` from Hamlib's public headers. The output reproduces
the API names, signatures, field names and value layouts needed to
interoperate with Hamlib; it does not copy upstream function bodies,
documentation or tables. It is MIT to the extent it is our original material;
any independently copyrightable third-party material in it keeps its own
license. The Emscripten-generated `hamlib-wasm.d.mts` declares the
project-owned Embind facade and carries an MIT banner.
