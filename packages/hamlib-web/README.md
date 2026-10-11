# hamlib-web

Hamlib CAT control in the browser over Web Serial, compiled to WebAssembly.

This package is `private` and `UNLICENSED`; it is not published to npm. The
repository root README covers building and testing it.

## Entry points

| Import | What it is |
| --- | --- |
| `hamlib-web` | The easy surface: `createEasy`, one rig object, state snapshots, events, booleans |
| `hamlib-web/native` | The 1:1 surface: `createHamlib` and a method per upstream Hamlib call |
| `hamlib-web/react` | React hooks over the easy surface; `react` is an optional peer dependency |
| `hamlib-web/wasm` | The raw Emscripten module and its generated declaration, for advanced use |

## The easy surface

```ts
import { createEasy, HamlibError } from 'hamlib-web';
import type { EasyHamlib, EasyRig, RigState } from 'hamlib-web';

const hamlib: EasyHamlib = await createEasy();
hamlib.version;                       // "Hamlib 4.7.2 …"
hamlib.models;                        // RigModel[], sorted by manufacturer then model

const rig: EasyRig = await hamlib.open({ modelId });   // asks for the port: user gesture
rig.baudRate;                                          // the rate the port was opened at

const state: RigState = await rig.refresh();           // every field optional
state.frequency;                                       // Hz, or undefined when unreadable
rig.state;                                             // the last completed refresh, if any

await rig.setFrequency(14_074_000);
await rig.setMode('USB');                              // passband filled in from the model
await rig.setPassband('narrow');                       // current mode + width, in one compound
await rig.setPtt(true);

const stop = rig.watch(1000);                          // refresh() every second
rig.on('state', (next) => console.log(next));
stop();

rig.capabilities.setFrequency;                         // booleans, from rig_caps
rig.raw;                                               // the 1:1 Rig, for anything below

await rig.close();                                     // idempotent
await hamlib.dispose();                                // closes rigs, unregisters ports
```

What it adds, and what it deliberately does not:

* `refresh()` composes the reads a UI always wants into one snapshot and emits
  it as `state`.  It reads only the getters the model advertises: a field the
  model cannot read is omitted, never invented, so a frequency-only receiver
  yields a snapshot with `frequency` alone (`mode` and `passband` always appear
  together or not at all).  A supported read that fails throws and leaves the
  previous successful snapshot in place, and the `state` event only ever
  carries a completed refresh.
* Every easy method is one *compound* operation on the module queue: the
  passband lookup and the write of `setMode()`, all of `setPassband()` and all
  the reads of `refresh()`, run inside a single queue slot, so a raw call
  through `rig.raw`, a call on another rig or a later easy call cannot
  interleave with their steps.  This orders the library's own commands; nothing
  can stop someone turning the radio's physical controls between two CAT
  replies.
* Every generated method takes that queue, including the `pure` helpers that
  read only `rig_caps` (`passband*`, the token codecs, the `has_*` masks, the
  `ext*` lookups).  They make no CAT traffic, but they still enter the Wasm
  module, which must not be re-entered while a native call is suspended under
  Asyncify.
* `setMode(mode)` fills in the passband through Hamlib's own
  `passband_normal`; pass one explicitly to override it.
* `setPassband('normal' | 'narrow' | 'wide')` reads the current mode, applies
  the matching Hamlib passband helper and writes mode and width back, all inside
  one compound operation - so a mode selection issued afterwards cannot be
  undone by the older passband action.
* `setPtt(true)` and `PttState` replace the string vocabulary.  It is an
  explicit on/off command, not a toggle: it never consults a readback, so it
  works on a model that can only set PTT.  The observed state is separate - read
  it from `state.ptt` (or the `ptt` event) and do not overwrite it with what was
  requested.
* A write never invents state - Hamlib's own cache decides what the next read
  reports - and a read the model cannot perform still fails with the native
  `UNSUPPORTED_OPERATION` error rather than returning a plausible value.
* `watch()` registers a poll and registrations compose: the smallest interval
  wins, removing one leaves the others polling, and removing the last stops the
  scheduler.  A tick that arrives while the previous poll is still in flight is
  skipped, so a slow rig cannot build a backlog of reads.  `close()` and
  `dispose()` stop polling synchronously, cancel publication, and leave no
  timer behind - including when the underlying rig was closed through
  `rig.raw`. If a listener closes or disposes during dispatch, remaining
  listeners of that same event and later field events are not delivered. This
  also applies to error listeners; the failed command still rejects to its caller.
* `hamlib.open()` hands back one owned rig.  An instance tracks its easy
  handles, and an open that races with `dispose()` is closed again instead of
  being published, so `dispose()` never leaves a live wrapper or a port behind.
* The baud rate is either stated or searched, never guessed into a success.
  Omitting `baudRate` leaves Hamlib's own default, which is the *highest* rate
  the model advertises - and a rig behind a real UART answers at one rate only,
  the one its own menu is set to, producing silence rather than an error at any
  other.  Such an open is rejected with the rate it tried and the range the
  model declares, so a wrong rate reads as a wrong rate instead of as a
  connected rig whose every read fails.  When the rate is unknown, ask for one:

  ```ts
  const port = await hamlib.requestPort();
  const baudRate = await hamlib.detectBaudRate({ modelId, port });  // tries the declared range
  const rig = await hamlib.open({ modelId, port, baudRate });
  rig.baudRate;                                                     // 38400, say - keep it
  ```

  `easyRig.baudRate` reports the rate a live rig was opened at, so storing it
  (a cookie, a settings row, your own default) makes the next connect explicit
  and instant.  A rig whose USB interface ignores the line rate - a CDC-ACM one
  - is unaffected either way.

## The 1:1 surface

```ts
import { createHamlib, HamlibError } from 'hamlib-web/native';
import type { Hamlib, Rig, RigModel, RigMode, RigModeState } from 'hamlib-web/native';

const hamlib: Hamlib = await createHamlib();
const port = await hamlib.requestPort();          // requires a user gesture
const rig: Rig = await hamlib.open({ modelId, port, baudRate: 19200 });

rig.baudRate;                                     // 19200: what this port was opened at
// Unknown rate? Search the range the model declares, then open with the answer:
// const baudRate = await hamlib.detectBaudRate({ modelId, port });

const frequency: number = await rig.getFrequency();
const mode: RigModeState = await rig.getMode();   // { mode, passband }
await rig.setFrequency(7_074_000);
await rig.setMode('CW', 500);                     // the width is the caller's
await rig.setPtt('on');
const ptt: string = await rig.getPtt();           // the rig's own state name

await rig.close();                                // idempotent
await hamlib.dispose();                           // closes rigs, unregisters ports
```

Every operation is a real typed method named after the upstream call it binds,
and none of them is a hand-written wrapper:

```ts
rig.model.capabilities;                               // string[]: methods this model implements
await rig.setRit(500);                                // throws HamlibError on failure
await rig.setLevel('RF', 0.5);                        // level name + float/int value
const split = await rig.getSplitFreqMode();           // { txFreq, txMode, txWidth }
const ext = await rig.extLookupTok(0);                // RigConfparam, or empty when unknown
await rig.passbandWide('USB');                        // pure: no CAT traffic, still queued
```

The discovery surface `rigctl` itself uses is bound too, so a client can find
out what a model offers without a hardcoded model table: `tokenForeach()` walks
the configuration parameters (the frontend's plus the model's serial ones),
`extLevelForeach()`, `extFuncForeach()` and `extParmForeach()` walk the model's
three extension tables, and `hasScan()`/`hasVfoOp()` return the backend's own
`scan_ops`/`vfo_ops` masks (so a suboperation that is a valid name but not
implemented comes back zero). Every walker returns plain
`RigConfparam` objects - one projected entry per parameter, with the native
vector freed - never an Embind-owned value.

Each method is gated by `rig.model.capabilities`, derived from the backend's
`rig_caps`: calling one the model does not implement throws
`UNSUPPORTED_OPERATION` before the rig is touched. The two PTT operations are
gated on the catalogue entry's own flags instead, because a backend that drives
push-to-talk over the serial RTS/DTR line declares no `get_ptt`/`set_ptt`
function pointer.

`RigMode` is a `string`: the accepted names evolve with upstream Hamlib and
every setter value is parsed by Hamlib's own `rig_parse_mode()`. The library
does not second-guess arguments — an unknown name or an unsupported width is
Hamlib's error to report.

## React

```tsx
import { HamlibProvider, useEasyRig, useModels, useRigState, useRigError } from 'hamlib-web/react';

function Rig() {
  const models = useModels();
  const { rig, connect, disconnect, connecting } = useEasyRig();
  const state = useRigState(rig, { pollMs: 1000 });

  return <button onClick={() => void connect({ modelId: models[0].id })}>{state?.frequency}</button>;
}

createRoot(document.getElementById('root')).render(
  <HamlibProvider><Rig /></HamlibProvider>,
);
```

`HamlibProvider` loads one instance (and disposes it on unmount); `useEasyRig`
owns one rig and closes it on unmount; `useRigState` subscribes to the state
event and optionally polls; `useRigError` reports the last operation failure.
StrictMode double-invocation is handled: an effect that unmounts before its
module or rig finished opening disposes what it created.

Each `connect()` carries an identity.  `disconnect()`, a replacement connection
and unmount invalidate older attempts, so a connect that finishes opening after
being superseded closes what it opened instead of publishing it; only the
current attempt may set `rig`, `connecting` or the connection error.  A
superseded attempt cannot clear the current one's `connecting` flag.  On a
telemetry failure the rig stays owned and `error` reports it, so cleanup is
never stranded behind a disabled button.  `useRigState` registers the rig's own
`watch()` and its cleanup removes only its own registration, so several
consumers can poll the same rig.

## How far a model is supported

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

One thing no field can carry is the baud rate the rig itself is configured for:
a backend declares a *range*, and the radio's menu decides the value inside it.
`support` therefore says nothing about it - a "verified" model can still be
opened at the wrong rate, which is silence rather than an error, and is why an
open verifies that the rig answered (see the baud rate bullet under the easy
surface).

## Errors

Every failure is a `HamlibError` with:

| Field | Meaning |
| --- | --- |
| `code` | Stable code: `WEB_SERIAL_UNAVAILABLE`, `PORT_PERMISSION_DENIED`, `TRANSPORT_FAILURE`, `HAMLIB_ERROR`, `RIG_UNRESPONSIVE`, `INVALID_ARGUMENT`, `UNSUPPORTED_OPERATION`, `RIG_CLOSED`, `DISPOSED` |
| `operation` | Stable operation name, e.g. `"open"` or `"getFrequency"` |
| `hamlibCode` / `hamlibMessage` | Hamlib's own error code and text |
| `cause` | The underlying DOM exception, when Web Serial raised one |

## Loading

`createEasy()` / `createHamlib()` load the Emscripten module and resolve the
`.wasm` asset next to the installed package with `new URL(..., import.meta.url)`.
Pass `locateFile` to override it.

## What is generated

Every operation on `Rig` comes from the pinned upstream Hamlib headers, so the
generator classifies each declaration into a shape whose types all map, and
*refuses* the rest with a reason in `coverage.json` rather than binding a guess.

The surface is the one the reference client needs: a declaration is bound
because the upstream `rigctl`/`rigctld` sources call it, and one they never call
is refused with that reason. Today that is 89 generated operations plus 11 whose
C++ body is hand-written (the caller-buffer, table-walker, extended-setting and
PTT shapes): 100 methods on `Rig`, against 87 refusals.

`hamlib.config.yaml` declares the value objects and the operations whose C++
body a signature cannot describe (the module lifecycle, port registration and
open/close ownership, the `char *` buffer wrapper, the `struct confparams` table
walkers, extended settings and PTT); their TypeScript methods are generated too,
so adding an operation is a config edit plus `mise run generate`.

The raw Emscripten module and its generated declaration are exported as
`hamlib-web/wasm`. The generated declaration is typed in terms of value objects
and primitive handles only — no C pointers, no Hamlib structures, no Wasm
memory addresses.

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
