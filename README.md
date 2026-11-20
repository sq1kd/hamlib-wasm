# hamlib-wasm

**Control your radio from a web page.** Hamlib's own CAT backends, compiled to
WebAssembly: Web Serial in Chrome, Edge and Firefox 151+, `serialport` in Node
and Electron. Nothing native to install.

[Try the live demo](https://sq1kd.github.io/hamlib-wasm/demo/) with your rig
plugged in, or read [the documentation](https://sq1kd.github.io/hamlib-wasm/getting-started/)
to build with it. The package is
[`hamlib-wasm` on npm](https://www.npmjs.com/package/hamlib-wasm).

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

## Contributing

Bug reports are most useful with the diagnostics report the live demo copies for
you. [`CONTRIBUTING.md`](CONTRIBUTING.md) covers the repository layout and
building and testing locally; [`SECURITY.md`](SECURITY.md) says how to report a
vulnerability.

## Licensing

`MIT AND LGPL-2.1-or-later`: the project's own code is MIT, and Hamlib, linked
statically into `hamlib-wasm.wasm`, stays LGPL-2.1-or-later. See
[`LICENSE.md`](LICENSE.md) for the component map and
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) for the notices. The npm
package carries `REBUILDING.md`, how to relink the WASM with a modified Hamlib.
