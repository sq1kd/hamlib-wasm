---
title: Getting started
description: Install hamlib-wasm, pick an entry point and connect to a rig.
---

`hamlib-wasm` is [Hamlib](https://hamlib.github.io/) compiled to WebAssembly,
with a serial transport for each runtime: the
[Web Serial API](https://developer.mozilla.org/docs/Web/API/Web_Serial_API) in
a browser, [`serialport`](https://serialport.io/) in Node and Electron. The CAT
backends are upstream Hamlib code, and we add a TypeScript API on top;
[How it works](../how-it-works/) explains why we built it that way.

## Install

```sh
npm install hamlib-wasm
```

Two peer dependencies are optional and only needed by the entry that uses them:

- `react` (18 or later) for `hamlib-wasm/react`;
- `serialport` (12 or later) for Node and Electron main processes, which also
  need Node 24 or later.

The package runs no build step at install time. The Wasm binary (about 4.5 MB,
1.1 MB gzip) ships inside it and is resolved next to the installed module with
`new URL(..., import.meta.url)`, the pattern bundlers such as Vite rewrite
into an emitted asset. Pass `locateFile` to load it from somewhere else.

## Entry points

| Import | What it is |
| --- | --- |
| `hamlib-wasm` | The [default surface](../guides/rig-api/): `createHamlib`, one rig object, state snapshots, events, booleans |
| `hamlib-wasm/raw` | The [raw surface](../guides/raw-api/): `createRawHamlib` and a typed method per upstream Hamlib call |
| `hamlib-wasm/react` | [React hooks](../guides/react/) over the default surface |
| `hamlib-wasm/node` | The [`serialport` transport](../guides/node/): `nodeSerialTransport()`, whose `listPorts()` lists the machine's ports |

Start with `hamlib-wasm`. Anything it does not cover is one step away on the
same rig, through `rig.raw`.

## First connection

You need three things from the radio: its model name, the CAT baud rate set in
its menu, and a USB or serial cable (some radios need a USB driver from the
manufacturer first). Find the model in the catalogue by manufacturer and model
name:

```ts
import { createHamlib, HamlibError } from 'hamlib-wasm';

const hamlib = await createHamlib();
const model = hamlib.models.find(
  (entry) => entry.manufacturer === 'Kenwood' && entry.model === 'TS-480',
)!;
```

Then connect, read and write. In a browser `open()` shows the port chooser, so
run it from a click handler:

```ts
button.addEventListener('click', async () => {
  try {
    const rig = await hamlib.open({ modelId: model.id, baudRate: 9600 });

    const state = await rig.refresh();
    console.log(state.frequency, state.mode);   // 14074000 'USB'

    await rig.setFrequency(7_074_000);          // Hz
    await rig.setMode('USB');                    // passband: the model's normal width

    await rig.close();
  } catch (error) {
    if (error instanceof HamlibError) {
      // error.code is stable: PORT_PERMISSION_DENIED when the chooser was
      // dismissed, HAMLIB_ERROR when the rig did not answer (check the baud
      // rate), UNSUPPORTED_OPERATION when the model cannot do something.
      console.error(error.code, error.message);
    }
  }
});
```

`rig.setPtt(true)` keys the transmitter for real. Connect a dummy load or an
antenna before you try it, and always follow it with `rig.setPtt(false)`.

When you are done with the module, `await hamlib.dispose()` closes every rig
it opened.

### Check for Web Serial first

A browser without Web Serial still loads the module, but every port operation
fails with `TRANSPORT_UNAVAILABLE`. Check up front to show a helpful message
instead:

```ts
if (!('serial' in navigator)) {
  // Tell the user to use desktop Chrome, Edge or Firefox 151+.
}
```

### In Node

Node has no port chooser: list the ports, then pass the radio's path.

```ts
import { createHamlib } from 'hamlib-wasm';
import { nodeSerialTransport } from 'hamlib-wasm/node';

console.log(await nodeSerialTransport().listPorts());

const hamlib = await createHamlib();
const port = await hamlib.requestPort({ path: '/dev/tty.usbserial-1410' });   // COM3 on Windows
const rig = await hamlib.open({ modelId: model.id, port, baudRate: 9600 });
```

`open()` without a `port` rejects with `INVALID_ARGUMENT` in Node.

## Where it runs

**Browsers.** Web Serial is available in desktop Chromium-based browsers
(Chrome, Edge, Opera and others) and in Firefox 151 and later. It needs a
[secure context](https://developer.mozilla.org/docs/Web/Security/Secure_Contexts):
the page must be served over HTTPS or from `localhost`. Mobile browsers and
Safari do not offer Web Serial. Opening a port shows the browser's port
chooser, which requires a user gesture such as a click.

**Node and Electron.** `createHamlib()` and `createRawHamlib()` select the transport
the runtime has: where there is no Web Serial they use `serialport`, which you
install alongside the package (Node 24 or later). An Electron renderer is a
browser and keeps Web Serial. See [Node and Electron](../guides/node/).

## Next steps

- Try the [live demo](../demo/) with a radio connected over USB.
- Read the [Rig API guide](../guides/rig-api/).
- Check whether your radio is [supported](../guides/rigs/).
- If you deploy the Wasm, read [Licensing](../guides/licensing/): it embeds
  LGPL-2.1-or-later Hamlib.
