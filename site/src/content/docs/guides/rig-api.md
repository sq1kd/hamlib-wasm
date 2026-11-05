---
title: Rig API
description: createHamlib, Rig, state snapshots, events and polling.
---

`hamlib-wasm` is the entry to reach for first: one rig object, a state
snapshot, events, and booleans instead of Hamlib's enums. It is a thin layer
over the [raw surface](../raw-api/), which stays one property away as
`rig.raw`.

```ts
import { createHamlib, HamlibError } from 'hamlib-wasm';
import type { Hamlib, Rig, RigState } from 'hamlib-wasm';

const hamlib: Hamlib = await createHamlib({ levels: ['STRENGTH'] });
hamlib.version;                       // "Hamlib <version> …"
hamlib.models;                        // RigModel[], sorted by manufacturer then model

const modelId = hamlib.models.find((entry) => entry.model === 'TS-480')!.id;
const rig: Rig = await hamlib.open({ modelId });         // asks for the port: user gesture
rig.baudRate;                                          // the rate the port was opened at

const state: RigState = await rig.refresh();           // every field optional
state.frequency;                                       // Hz, or undefined when unreadable

await rig.setFrequency(14_074_000);
await rig.setMode('USB');                              // passband filled in from the model
await rig.setPassband('narrow');                       // current mode + width, in one step
await rig.setPtt(true);

await rig.close();                                     // idempotent
await hamlib.dispose();                                // closes every rig and port
```

Every method acts on the rig's current VFO. To pick a VFO, or to work split,
use `rig.raw` (`setVfo`, `setSplitVfo`, `setSplitFreq`, …).

## Reading state

`refresh()` composes the reads a UI always wants - frequency, mode with
passband, PTT, and the configured levels - into one `RigState` and remembers it
as `rig.state`.

- It reads only the getters the model advertises. A field the model cannot
  read is **omitted, never invented**: a frequency-only receiver yields a
  snapshot with `frequency` alone. `mode` and `passband` appear together or not
  at all.
- A supported read that fails throws and leaves the previous snapshot in place.
- `rig.state` and the `state` event carry the merged snapshot of every
  completed read, whether it came from `refresh()` or a `watch()` tick.
- A write never invents state either: Hamlib's own cache decides what the next
  read reports.

## Writing

- `setFrequency(hz)` takes the frequency in Hz.
- `setMode(mode)` takes a Hamlib mode name - `USB`, `LSB`, `CW`, `CWR`, `AM`,
  `FM`, `RTTY`, `PKTUSB`, `PKTLSB` and others; the model decides which it
  accepts. The passband defaults to the model's normal width for that mode;
  pass a width in Hz to override it.
- `setPassband('normal' | 'narrow' | 'wide')` reads the current mode, applies
  the matching Hamlib passband helper and writes both back as one operation.
- `setPtt(true | false)` is an explicit command, not a toggle. It keys the
  transmitter for real, so have a dummy load or an antenna connected. The
  observed state is `state.ptt` (or the `ptt` event); do not overwrite it with
  what was requested. `ptt` reads `'off'`, `'on'`, or `'on-mic'`/`'on-data'` on
  radios that report which audio input is transmitting.

Calls run one at a time, in order. A method that takes several CAT commands
runs them back to back, so a raw call, a call on another rig or a later `Rig`
call cannot slip in between.

## Events and polling

```ts
const stop = rig.watch({ intervalMs: 1000, fields: ['frequency', 'mode'] });
const stopMeter = rig.watch({ intervalMs: 500, levels: ['STRENGTH'] });

rig.on('state', (next) => console.log(next));
rig.on('levels', (values) => console.log(values.STRENGTH));
rig.on('error', (error) => console.warn(error.operation, error.message));

stop();
stopMeter();
```

`watch()` registers a poll that reads only the fields it names. Each interval
has its own timer, so a fast meter poll does not speed up a slow frequency
poll. A tick that arrives while the previous one is still running is skipped,
so a slow rig cannot build a backlog. Every tick publishes `state` and the
field events for what it read. A tick is best effort - a failed field emits
`error` and leaves the rest untouched. `close()` and `dispose()` stop every
poll synchronously.

`watch()` returns no promise: a closed rig, a bad interval or an unknown field
throws `RIG_CLOSED` or `INVALID_ARGUMENT` right away.

## Levels

Levels are opt-in: `createHamlib({ levels: ['STRENGTH', 'SWR'] })` names the ones
the instance may read, and `refresh()`/`watch()` read only those the model
advertises. Values are on Hamlib's scales:

| Level | Value |
| --- | --- |
| `STRENGTH` | Signal strength in dB relative to S9, an integer: S0 is -54, S9 is 0, S9+20 is 20 |
| `SWR` | Standing wave ratio, 1 and up |
| `ALC` | ALC meter, as the backend scales it (usually 0 to 1) |
| `RFPOWER` | The output power setting, 0 to 1 of the rig's maximum |
| `RFPOWER_METER` | Measured forward power, 0 to 1 of the rig's maximum |

```ts
await rig.level('STRENGTH');          // one read
rig.capabilities.levels;              // configured levels this model has
```

A level whose read fails twice in a row is dropped for the session; reopening
the rig probes it again. Hamlib caches levels for 500 ms, so polling faster
mostly re-reads the cache.

## Capabilities

`rig.capabilities` answers "can this model do X" as booleans, derived from the
backend's `rig_caps`:

```ts
rig.capabilities.setFrequency;   // boolean
rig.capabilities.getPtt;         // boolean
```

A read the model cannot perform fails with `UNSUPPORTED_OPERATION` rather than
returning a plausible value.

## Baud rate

A rig behind a real UART answers at exactly one rate - the one set in its own
menu - and is silent at every other. Omitting `baudRate` uses the highest rate
the model declares; an open that gets no answer is rejected with
`HAMLIB_ERROR`, rather than looking like a connected rig whose every read
fails.

When the rate is unknown, search the declared range on a granted port:

```ts
const port = await hamlib.requestPort();
const baudRate = await hamlib.detectBaudRate({ modelId, port });
const rig = await hamlib.open({ modelId, port, baudRate });
```

Store `rig.baudRate` to make the next connection explicit and instant. USB
radios whose CAT interface ignores the line rate (CDC-ACM) are unaffected.

## Errors

Every failure is a `HamlibError` with a stable `code`, the `operation` that
failed, Hamlib's own `hamlibCode`/`hamlibMessage` where there is one, and the
underlying `cause` when a transport raised it. The ones a first session meets:

| When | Code |
| --- | --- |
| The browser has no Web Serial | `TRANSPORT_UNAVAILABLE` |
| The user dismissed the port chooser | `PORT_PERMISSION_DENIED` |
| `open()` got no answer - usually the wrong baud rate | `HAMLIB_ERROR` |
| `detectBaudRate()` found no rate that answers | `RIG_UNRESPONSIVE` |
| The model cannot do what was asked | `UNSUPPORTED_OPERATION` |
| The port failed, e.g. the cable was unplugged | `TRANSPORT_FAILURE` |
| The rig or the instance was closed | `RIG_CLOSED`, `DISPOSED` |

The [`HamlibErrorCode`](../../api/hamlib-wasm/type-aliases/hamliberrorcode/)
reference lists them all.

Every call runs under a watchdog, `callTimeoutMs` (30 s by default). A call
that overruns cannot be cancelled: the caller gets `RIG_TIMEOUT`, later calls
get `RIG_HUNG`, and `dispose()` still closes the port. Create a new instance
to continue.

See the [API reference](../../api/hamlib-wasm/readme/) for every type and option.
