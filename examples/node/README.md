# hamlib-wasm Node example

The same package as the browser examples, driven from a terminal. Ports come
from node-serialport rather than a page's Web Serial chooser, because
`createEasy()` / `createHamlib()` select the transport the runtime has:
`hamlib-wasm/node` is imported here for `listPorts()`, not to wire the
transport. The catalogue, the model ids, the baud-rate search and `refresh()`
are unchanged.

`serialport` is the package's optional peer dependency and is installed by this
example, so run it from the repository root with the workspace's dependencies in
place (`npm install`).

Plain Node's type stripping runs the source directly — no build step, the same
way this repository's `build/*.ts` scripts run.

## List the ports

```sh
node examples/node/src/main.ts --list
```

One line per port: the path to pass to `--port`, then manufacturer, serial
number and `vendorId:productId`. A field the operating system did not report
prints as `-`. Exits 0.

## Read a rig

```sh
node examples/node/src/main.ts --port /dev/tty.usbserial-1410 --model TS-480
```

`--port` takes the device path `--list` printed. `--model` takes a
`RigModel.model` name from the catalogue and defaults to `TS-480`. `--baud`
pins the line rate; without it the example runs `detectBaudRate()` first, the
same search the browser examples offer, because a wrong rate produces silence
rather than an error.

The example only reads: it opens the port, prints what `refresh()` reports
(`frequency`, `mode` with passband, `ptt`), and closes the port again. It never
writes a frequency, a mode or PTT.

On Windows a port is a name like `COM3`, not a filesystem path.

## Electron

- **Renderer** — an Electron renderer is a browser, so it keeps the default Web
  Serial transport and the package's browser behaviour is unchanged. Electron
  implements `navigator.serial` in the renderer, but the application's main
  process has to answer the `select-serial-port` event and decide whether to
  grant the port; without that handler `requestPort()` never resolves.
- **Main process** — `createEasy()` / `createHamlib()` select the Node transport
  on their own where there is no Web Serial; import `hamlib-wasm/node` for
  `listPorts()` and to pass transport options, as this example's `--list` does.
  `serialport`'s bindings are N-API, so Electron needs no native rebuild.
- **Packaging with asar** — the `serialport` native binding is a `.node` file
  inside the archive, which cannot be loaded from there. electron-builder has
  to leave it unpacked:

  ```json
  {
    "asarUnpack": ["**/node_modules/@serialport/bindings-cpp/**"]
  }
  ```
