# hamlib-web

Hamlib CAT control in the browser over Web Serial, compiled to WebAssembly.

This package is `private` and `UNLICENSED`; it is not published to npm. The
repository root README covers building and testing it.

## API

```ts
import { createHamlib, HamlibError } from 'hamlib-web';
import type { Hamlib, Rig, RigModel, RigMode, RigModeState } from 'hamlib-web';

const hamlib: Hamlib = await createHamlib();
hamlib.version;                       // "Hamlib 4.7.2"
hamlib.models;                        // RigModel[], sorted by manufacturer then model

const port = await hamlib.requestPort();          // requires a user gesture
const rig: Rig = await hamlib.open({ modelId, port, baudRate: 19200 });

const frequency: number = await rig.getFrequency();
const mode: RigModeState = await rig.getMode();   // { mode, passband }
await rig.setFrequency(7_074_000);
await rig.setMode('CW', 500);                     // the width is the caller's
await rig.setPtt('on');
const ptt: string = await rig.getPtt();           // the rig's own state name

await rig.close();                                // idempotent
await hamlib.dispose();                           // closes rigs, unregisters ports
```

### The whole surface is generated

Every operation on `Rig` comes from the upstream Hamlib headers, so each one is
a real typed method named after the call it binds and none of them is a
hand-written wrapper:

```ts
rig.model.capabilities;            // string[]: generated methods this model implements
const hz = await rig.getResolution('USB');            // pure, no CAT traffic
await rig.setRit(500);                                // throws HamlibError on failure
await rig.setLevel('RF', 0.5);                        // level name + float/int value
await rig.getSplitFreqMode();                         // Promise<{ tx_freq, tx_mode, tx_width }>
const conf = await rig.confparamLookup('rig_pathname'); // struct projection
```

The generator classifies each declaration into a shape whose types all map, and
*refuses* the rest with a reason in `coverage.json` rather than binding a guess.
`hamlib.config.yaml` declares the value objects and the operations whose C++
body a signature cannot describe (the module lifecycle, port registration and
open/close ownership, the `char *` buffer wrappers, the callback table walkers
and PTT); their TypeScript methods are generated too, so adding an operation is
a config edit plus `mise run generate`.

Each generated method is gated by `rig.model.capabilities`, derived from the
backend's `rig_caps`: calling one the model does not implement throws
`UNSUPPORTED_OPERATION` before the rig is touched.  The two PTT operations are
gated on the catalogue entry's own flags instead, because a backend that drives
push-to-talk over the serial RTS/DTR line declares no `get_ptt`/`set_ptt`
function pointer.

`RigMode` is a `string`: the accepted names evolve with upstream Hamlib and
every setter value is parsed by Hamlib's own `rig_parse_mode()`. The library
does not second-guess arguments — an unknown name or an unsupported width is
Hamlib's error to report.

### How far a model is supported

Hamlib reports several hundred serial models, and `RIG_PORT_SERIAL` only says
that a backend goes through the common port layer. Every `RigModel` therefore
carries:

| Field | Meaning |
| --- | --- |
| `support` | `"verified"` when a browser test in this package drives the model through the Web Serial double, otherwise `"candidate"` |
| `limitation` | Set when the build cannot drive the model: it declares line settings Web Serial cannot express, or a recorded reason applies |
| `serialDataBits`, `serialStopBits`, `serialParity`, `serialHandshake` | The line settings the backend declares |

`VERIFIED_MODELS` lists the verified models with their evidence, and
`UNUSABLE_MODELS` the recorded reasons. "Verified" never means tested against
hardware.

A model that declares settings Web Serial cannot express fails with
`-RIG_ECONF` before the port is opened, so a user never ends up on a silently
downgraded port.

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

The binding surface is **generated, not handwritten**. `packages/hamlib-codegen`
reads the pinned Hamlib headers with clang (the pinned emsdk) and classifies
every `rig_get_*` / `rig_set_*` declaration into a shape whose types are all
mapped. A declaration that classifies is generated mechanically into
`native/generated/*.inc`, `src/native/generated/operations.ts` and the typed
method classes; one whose types or shape the generator does not understand is
refused and listed, never bound on a guess.
`packages/hamlib-web/hamlib.config.yaml` declares the value objects and the
operations whose C++ body a signature cannot describe; the pinned signature of
every upstream symbol those bodies call is recorded in `coverage.json`, so
drift fails the build instead of changing behaviour silently.

Every project-owned file is strict TypeScript. The browser serial transport is
authored in `native/web_serial.ts` and compiled to the Emscripten JS library
(`--js-library`) during `build:native`; no JavaScript is handwritten in this
repository. The generated low-level contract types every operation as
`T | Promise<T>` because an Asyncify-suspended call returns a promise.

## Licensing

`UNLICENSED` project code; Hamlib is LGPL-2.1-or-later and its licence, pinned
source URL/checksum and patch are shipped under `dist/third_party/hamlib`,
reachable as `hamlib-web/third_party/*`.

Hamlib is linked into `dist/native/hamlib-web.wasm` statically, so the
corresponding source has to stay reachable: `dist/third_party/hamlib/SOURCE.json`
names the exact release, its archive URL and SHA-256, and the applied patch
text; `packages/hamlib-web/hamlib.config.yaml` and the build scripts in this
repository reproduce or relink that artifact with `mise run build:native`. The
package runs no build step at install time.
