# hamlib-web

Hamlib CAT control in the browser over Web Serial, compiled to WebAssembly.

This package is `private` and `UNLICENSED`; it is not published to npm. The
repository root README covers building and testing it.

## API

```ts
import { createHamlib, HamlibError } from 'hamlib-web';
import type { Hamlib, Rig, RigModel, RigStatus, RigMode, PttState } from 'hamlib-web';

const hamlib: Hamlib = await createHamlib();
hamlib.version;                       // "Hamlib 4.7.2"
hamlib.models;                        // RigModel[], sorted by manufacturer then model

const port = await hamlib.requestPort();          // requires a user gesture
const rig: Rig = await hamlib.open({ modelId, port, baudRate: 19200 });

const status: RigStatus = await rig.getStatus();  // { frequency, mode, passband }
await rig.setFrequency(7_074_000);
const mode = await rig.getMode();                 // { mode, passband }
await rig.setMode('CW', 500);                     // passband optional
await rig.setPtt('on');                           // 'off' | 'on' | 'on-mic' | 'on-data'
const ptt: PttState = await rig.getPtt();

await rig.close();                                // idempotent
await hamlib.dispose();                           // closes rigs, unregisters ports
```

`RigMode` is a `string`: the accepted names evolve with upstream Hamlib and
every setter value is validated by Hamlib's own `rig_parse_mode()`.

### Errors

Every failure is a `HamlibError` with:

| Field | Meaning |
| --- | --- |
| `code` | Stable code: `WEB_SERIAL_UNAVAILABLE`, `PORT_PERMISSION_DENIED`, `TRANSPORT_FAILURE`, `HAMLIB_ERROR`, `INVALID_ARGUMENT`, `UNSUPPORTED_OPERATION`, `RIG_CLOSED`, `DISPOSED` |
| `operation` | Stable operation name, e.g. `"open"` or `"getFrequency"` |
| `hamlibCode` / `hamlibMessage` | Hamlib's own error code and text |
| `cause` | The underlying DOM exception, when Web Serial raised one |

### Loading

`createHamlib()` loads the Emscripten module and resolves the `.wasm` asset
next to the installed package with `new URL(..., import.meta.url)`. Pass
`locateFile` to override it.

## Requirements

A secure context desktop Chromium family browser with Web Serial, served over
HTTPS or `localhost`. The module is single threaded and needs no
`SharedArrayBuffer`, `COOP`/`COEP` headers or worker setup.

## Native module

The Embind facade and its generated declaration are also exported for advanced
use: `hamlib-web/native` (Emscripten glue + `.d.mts`) and
`hamlib-web/native/hamlib-web.wasm`. The generated declaration is typed in
terms of value objects and primitive handles only - no C pointers, no Hamlib
structures, no Wasm memory addresses.

## Licensing

`UNLICENSED` project code; Hamlib is LGPL-2.1-or-later and its licence, pinned
source URL/checksum and patch are shipped under `dist/third_party/hamlib`,
reachable as `hamlib-web/third_party/*`.
