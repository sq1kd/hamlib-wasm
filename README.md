# hamlib-wasm

**Control your radio from a web page.** Hamlib's own CAT backends, compiled to
WebAssembly: Web Serial in Chrome, Edge and Firefox 151+, `serialport` in Node
and Electron. Nothing native to install.

**[Try the live demo](https://sq1kd.github.io/hamlib-wasm/demo/)** ·
[Documentation](https://sq1kd.github.io/hamlib-wasm/) ·
[npm](https://www.npmjs.com/package/hamlib-wasm)

## Quick start

```sh
npm install hamlib-wasm
```

```ts
import { createHamlib } from 'hamlib-wasm';

const hamlib = await createHamlib();
const modelId = hamlib.models.find((entry) => entry.model === 'TS-480')!.id;
const rig = await hamlib.open({ modelId });     // asks for the port: call from a click

const { frequency, mode } = await rig.refresh();
await rig.setFrequency(14_074_000);             // Hz

await rig.close();
```

Every serial rig Hamlib supports is in the catalogue, driven by the same backend
code as `rigctl`. The [package README](packages/hamlib-wasm/README.md) is the full
reference; the [supported rigs](https://sq1kd.github.io/hamlib-wasm/guides/rigs/)
guide says which models were tested and how.

## Repository layout

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
| `.github/` | `ci.yml` (the release gate, commitlint on PRs), `release.yml` (gate, publish, Pages on push) and the shared `actions/setup` |
| `release.config.cjs` / `RELEASING.md` | semantic-release configuration and the publishing runbook |

Build products live in `.cache/hamlib/<version>` (downloaded upstream source and
object files) and `packages/hamlib-wasm/dist`; neither is committed.

## Contributing

Bug reports are most useful with the diagnostics report the live demo copies for
you. See [`CONTRIBUTING.md`](CONTRIBUTING.md) to build and test locally
(`mise install && mise run bootstrap`, then `mise run check`), and
[`SECURITY.md`](SECURITY.md) to report a vulnerability.

## Licensing

`MIT AND LGPL-2.1-or-later`: original project code is MIT, and Hamlib, linked
statically into the published `hamlib-wasm.wasm`, stays LGPL-2.1-or-later, so
the npm package is not MIT-only. See [`LICENSE.md`](LICENSE.md) for the
component map and [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) for the
notices and the licensing audit. The npm package also carries `REBUILDING.md`,
the instructions for relinking the WASM with a modified Hamlib, rendered at
build time from `packages/hamlib-wasm/build/REBUILDING.md.in`.
