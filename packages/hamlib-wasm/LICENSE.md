# `hamlib-wasm` licensing

This npm package contains independently developed wrapper code and a
WebAssembly build of Hamlib. It is **not MIT-only**.

| Component | License |
| --- | --- |
| Original JavaScript/TypeScript API, adapters and transports | MIT |
| Original native C/C++ bridge and eligible generated bindings | MIT |
| Hamlib library compiled into `dist/native/hamlib-wasm.wasm` | LGPL-2.1-or-later |
| Changes to LGPL-covered Hamlib sources | LGPL-2.1-or-later |
| Upstream Hamlib source archive and other bundled source material | File-level mixture; see notices |
| Toolchain-emitted or other third-party material | Its original terms; see notices |

The binary contains Hamlib. Recipients must respect the LGPL terms applying
to it. The wrapper's MIT license does not remove those conditions.

Complete license texts are included under `LICENSES/`; Hamlib's original
copyright and license information is also under
`dist/third_party/hamlib/` (`LICENSE`, `COPYING`, `COPYING.LIB`, `AUTHORS`).
Toolchain runtime notices for Emscripten and its sysroot (musl, compiler-rt,
libc++) are in `THIRD_PARTY_NOTICES.md`, `LICENSES/Emscripten.txt`,
`LICENSES/Apache-2.0.txt` and `LICENSES/LLVM.txt`.

The materials needed to rebuild or relink this WASM binary with a modified
Hamlib, including the complete corresponding Hamlib source archive, the
applied patch, the native bridge source, generated native bindings, and build
instructions, are supplied in
`dist/third_party/hamlib/corresponding-source.tar.gz` and described in
`REBUILDING.md` and `dist/third_party/hamlib/SOURCE.json`.

The corresponding-source archive contains the complete upstream Hamlib source
tree. Individual files in that archive are covered by the GPL or other
licenses, including GPL-2.0-or-later utilities and examples and the
GPL-3.0-or-later `lib/precise_time.c`. Their inclusion as separate
corresponding-source materials does not mean those programs were linked into
the WebAssembly runtime; the linked-input audit is recorded in
`dist/third_party/hamlib/LINK_INPUTS.json`. Consult `THIRD_PARTY_NOTICES.md`.

Downstream distributors of an application containing the WASM binary are
responsible for satisfying any LGPL distribution obligations applicable to
their own distribution. See the downstream-distribution section of `README.md`.
