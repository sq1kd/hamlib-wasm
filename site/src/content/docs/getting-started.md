---
title: Getting started
description: Install hamlib-wasm, pick an entry point and connect to a rig.
---

`hamlib-wasm` is [Hamlib](https://hamlib.github.io/) compiled to WebAssembly,
with a serial transport for each runtime: the
[Web Serial API](https://developer.mozilla.org/docs/Web/API/Web_Serial_API) in
a browser, [`serialport`](https://serialport.io/) in Node and Electron. The CAT
backends are upstream Hamlib code; the package adds a TypeScript API on top.

## Install

```sh
npm install hamlib-wasm
```

Two peer dependencies are optional and only needed by the entry that uses them:

- `react` (18 or later) for `hamlib-wasm/react`;
- `serialport` (12 or later) for Node and Electron main processes.

The package runs no build step at install time. The Wasm binary (about 5 MB,
1.3 MB gzip) ships inside it and is resolved next to the installed module with
`new URL(..., import.meta.url)`, the pattern bundlers such as Vite rewrite
into an emitted asset. Pass `locateFile` to load it from somewhere else.

## Entry points

| Import | What it is |
| --- | --- |
| `hamlib-wasm` | The [default surface](../guides/rig-api/): `createHamlib`, one rig object, state snapshots, events, booleans |
| `hamlib-wasm/raw` | The [raw surface](../guides/raw-api/): `createRawHamlib` and a typed method per upstream Hamlib call |
| `hamlib-wasm/react` | [React hooks](../guides/react/) over the default surface |
| `hamlib-wasm/node` | The [`serialport` transport](../guides/node/): `nodeSerialTransport` and `listPorts()` |

Start with `hamlib-wasm`. Anything it does not cover is one step away on the
same rig, through `rig.raw`.

## First connection

```ts
import { createHamlib } from 'hamlib-wasm';

const hamlib = await createHamlib();
const modelId = hamlib.models.find((model) => model.model === 'TS-480')!.id;

// In a browser this opens the port chooser, so call it from a click handler.
const rig = await hamlib.open({ modelId, baudRate: 9600 });

const state = await rig.refresh();
console.log(state.frequency, state.mode);

await rig.close();
await hamlib.dispose();
```

## Where it runs

**Browsers.** Web Serial is available in desktop Chromium-based browsers
(Chrome, Edge, Opera and others) and in Firefox 151 and later. It needs a
[secure context](https://developer.mozilla.org/docs/Web/Security/Secure_Contexts):
the page must be served over HTTPS or from `localhost`. Mobile browsers and
Safari do not offer Web Serial. Opening a port shows the browser's port
chooser, which requires a user gesture such as a click.

**Node and Electron.** `createHamlib()` and `createRawHamlib()` select the transport
the runtime has: where there is no Web Serial they use `serialport`, which you
install alongside the package. An Electron renderer is a browser and keeps Web
Serial. See [Node and Electron](../guides/node/).

## Next steps

- Try the [live demo](../demo/) with a radio connected over USB.
- Read the [Rig API guide](../guides/rig-api/).
- Check whether your radio is [supported](../guides/rigs/).
- If you deploy the Wasm, read [Licensing](../guides/licensing/): it embeds
  LGPL-2.1-or-later Hamlib.
