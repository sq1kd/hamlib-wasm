# hamlib-wasm

[Hamlib](https://hamlib.github.io/) CAT control compiled to WebAssembly, with a
switchable serial transport: Web Serial in desktop Chromium-based browsers and
Firefox 151+ (in a secure context, HTTPS or `localhost`), node-serialport in
Node and Electron.

This repository builds and tests the `hamlib-wasm` npm package. Usage, the API,
runtime support and limitations are documented in the package README:
[`packages/hamlib-wasm/README.md`](packages/hamlib-wasm/README.md).

## Layout

| Path | Purpose |
| --- | --- |
| `packages/hamlib-wasm` | The package: the entry points in `src/` (`index.ts`, `raw.ts`, `node.ts`, `react.ts`), native sources and build scripts |
| `packages/hamlib-wasm/hamlib.config.yaml` | The one config: the pinned release (version, archive URL + SHA-256, patches) and the binding surface |
| `packages/hamlib-wasm/coverage.json` | Generated coverage report: bound vs refused declarations, with reasons |
| `packages/hamlib-wasm/build` | Native build, package build, audits and the generator wrapper |
| `packages/hamlib-wasm/native` | Serial transport (TypeScript, compiled to the Emscripten JS library), link-time POSIX wrappers, Embind facade, `pthread` shim |
| `packages/hamlib-wasm/baseline/baseline.json` | Recorded catalogue digest and CAT trace for the pinned release |
| `packages/hamlib-codegen` | The AST-driven generator: classifies upstream declarations and emits the binding surface |
| `site` | Documentation website (Astro Starlight, TypeDoc API reference) with the on-demand live rig demo |
| `examples/node` | Node CLI: lists this machine's serial ports and drives a rig read-only through the Node transport |
| `tests/browser` | Playwright Web Serial double with emulated rigs, a virtual page clock, and the scenarios driving them, in Chromium and Firefox |
| `tests/harness` | Pages that publish the built package (`index.html`) and drive the React hooks (`hooks.html`) for the browser specs |
| `tests/hooks` | `vitest` + jsdom: the React hook state machine against a stubbed package boundary |
| `tests/node` | `vitest` in Node: the built Wasm module, the port contract and the `serialport` adapter against the emulated rigs |
| `tests/codegen` | `vitest`: the generator against synthetic clang ASTs |
| `tests/hardware` | Opt-in, read-only checks against a real rig through the Node transport |
| `tests/consumer` | External consumer fixture, typechecked against the packed tarball |
| `.github/` | `ci.yml` (check-release, commitlint on PRs, weekly relink), `release.yml`, and the shared `actions/setup` |
| `release.config.cjs` / `RELEASING.md` | semantic-release configuration and the publishing runbook |

Build products live in `.cache/hamlib/<version>` (downloaded upstream source and
object files) and `packages/hamlib-wasm/dist`; neither is committed.

## Development

Everything runs through the toolchain pinned in `mise.toml`:

```sh
mise install && mise run bootstrap   # toolchain, locked npm deps, Playwright browsers, commit hook
mise run check                       # the local gate: lint, types, generated files, unit + browser tests
mise tasks                           # every other task, with its description
```

The first build downloads the pinned Hamlib release, verifies its SHA-256,
applies the patches `hamlib.config.yaml` lists and compiles it with Emscripten;
later builds reuse `.cache`. Commit messages follow Conventional Commits, which
semantic-release derives the version from; the hook `bootstrap` installs checks
them.

## Licensing

`MIT AND LGPL-2.1-or-later`: original project code is MIT, and Hamlib, linked
statically into the published `hamlib-wasm.wasm`, stays LGPL-2.1-or-later, so
the npm package is not MIT-only. See [`LICENSE.md`](LICENSE.md) for the
component map and [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) for the
notices and the licensing audit. The npm package also carries `REBUILDING.md`,
the instructions for relinking the WASM with a modified Hamlib, rendered at
build time from `packages/hamlib-wasm/build/REBUILDING.md.in`.
