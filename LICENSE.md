# Licensing

`hamlib-wasm` combines original code with the Hamlib library. Each component
keeps its own license; the npm package as a whole is
`MIT AND LGPL-2.1-or-later`.

| Component | License |
| --- | --- |
| Original code: TypeScript API, adapters and transports, the native C/C++ bridge, generated bindings, build tooling, tests and examples | MIT (`LICENSES/MIT.txt`) |
| Hamlib, including our changes to it, compiled into `dist/native/hamlib-wasm.wasm` | LGPL-2.1-or-later (`LICENSES/LGPL-2.1-or-later.txt`) |
| Hamlib's API documentation, carried as the doc comments of the generated `RawRig` methods (`dist/native/generated/operations.*`) | LGPL-2.1-or-later (`LICENSES/LGPL-2.1-or-later.txt`) |
| Upstream Hamlib source archive in the corresponding-source kit | File-level mixture, including GPL-2.0-or-later and GPL-3.0-or-later files that are not linked into the WASM |
| Emscripten runtime and sysroot (musl, compiler-rt, libc++) | Their own permissive terms (`LICENSES/Emscripten.txt`, `LICENSES/LLVM.txt`) |

The WASM binary is a combined work. The MIT license of the original code does
not remove the LGPL conditions that apply to Hamlib, and Hamlib is not
relicensed under MIT.

- `THIRD_PARTY_NOTICES.md` lists the third-party components, their
  copyrights, and which upstream files are and are not linked.
- `REBUILDING.md` explains how to rebuild and relink the WASM with a modified
  Hamlib from the corresponding-source kit
  (`dist/third_party/hamlib/corresponding-source.tar.gz`). The npm package
  ships it; the repository generates it from
  `packages/hamlib-wasm/build/REBUILDING.md.in` when the package is built.
