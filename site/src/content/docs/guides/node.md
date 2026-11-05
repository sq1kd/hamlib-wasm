---
title: Node and Electron
description: Drive a rig from Node, a CLI or an Electron main process through serialport.
---

The same package runs outside a browser. `createHamlib()` and `createRawHamlib()`
select the transport the runtime has: Web Serial in a page, the
[`serialport`](https://serialport.io/) package in Node. Install it next to
`hamlib-wasm`:

```sh
npm install hamlib-wasm serialport
```

`serialport` is an optional peer dependency (12 or later; tested with 13),
imported lazily on the first `requestPort()` or `listPorts()`. A web page never
loads it. Node 24 or later is required.

## Read a rig

This is the core of the repository's `examples/node` command line example: list
ports, or open one, read it once and close it.

```ts
import { createHamlib, HamlibError } from 'hamlib-wasm';
import type { Rig } from 'hamlib-wasm';
import { nodeSerialTransport } from 'hamlib-wasm/node';

// --list: one line per port.
for (const port of await nodeSerialTransport().listPorts()) {
  console.log(port.path, port.manufacturer ?? '-', `${port.vendorId ?? '-'}:${port.productId ?? '-'}`);
}

// --port: no transport passed, so createHamlib() picks serialport itself.
const hamlib = await createHamlib();
let rig: Rig | undefined;

try {
  const model = hamlib.models.find((entry) => entry.model === 'TS-480')!;
  const port = await hamlib.requestPort({ path: '/dev/tty.usbserial-1410' });
  const baudRate = await hamlib.detectBaudRate({ modelId: model.id, port });

  rig = await hamlib.open({ modelId: model.id, port, baudRate });
  const state = await rig.refresh();

  console.log(`${model.manufacturer} ${model.model} at ${rig.baudRate} baud:`, state);
} catch (error) {
  if (error instanceof HamlibError) {
    console.error(`${error.operation} failed: ${error.message} [${error.code}]`);
  }
  throw error;
} finally {
  await rig?.close();
  await hamlib.dispose();
}
```

In Node, `requestPort({ path })` names the device - there is no chooser. On
Windows a port is a name like `COM3`. Pass the port to `open()`: unlike in a
browser, `open({ modelId })` without one rejects with `INVALID_ARGUMENT`.

From a checkout of the repository the example runs with plain Node's type
stripping:

```sh
node examples/node/src/main.ts --list
node examples/node/src/main.ts --port /dev/tty.usbserial-1410 --model TS-480
```

It only reads: it never writes a frequency, a mode or PTT.

## Transport options

`hamlib-wasm/node` exports `nodeSerialTransport()`. Pass it explicitly to
`createHamlib({ transport })` to configure it - an explicit transport always wins
over the automatic choice. `nodeSerialTransport({ serialport })` accepts any
module with a compatible `SerialPort` class, so a different binding or a
subclass is a one-line change.

The port contract is a single interface, `SerialPortLike`: a browser
`SerialPort` already satisfies it, and the Node transport is the second
implementation. See the [API reference](../../api/hamlib-wasm/node/readme/).

## Electron

- **Renderer.** An Electron renderer is a browser, so it keeps Web Serial.
  Your main process must handle `select-serial-port` (and the permission
  checks), or `requestPort()` never resolves.
- **Main process.** Behaves like Node: `serialport` is selected automatically.
  Its bindings are N-API, so no native rebuild is needed for Electron.
- **asar packaging.** The `serialport` native binding cannot be loaded from
  inside an asar archive. With electron-builder, leave it unpacked:

  ```json
  { "asarUnpack": ["**/node_modules/@serialport/bindings-cpp/**"] }
  ```
