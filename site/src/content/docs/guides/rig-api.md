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

const rig: Rig = await hamlib.open({ modelId });         // asks for the port: user gesture
rig.baudRate;                                          // the rate the port was opened at

const state: RigState = await rig.refresh();           // every field optional
state.frequency;                                       // Hz, or undefined when unreadable

await rig.setFrequency(14_074_000);
await rig.setMode('USB');                              // passband filled in from the model
await rig.setPassband('narrow');                       // current mode + width, in one step
await rig.setPtt(true);

await rig.close();                                     // idempotent
await hamlib.dispose();                                // closes rigs, unregisters ports
```

## Reading state

`refresh()` composes the reads a UI always wants - frequency, mode with
passband, PTT, and the configured levels - into one `RigState` and remembers it
as `rig.state`.

- It reads only the getters the model advertises. A field the model cannot
  read is **omitted, never invented**: a frequency-only receiver yields a
  snapshot with `frequency` alone. `mode` and `passband` appear together or not
  at all.
- A supported read that fails throws and leaves the previous snapshot in place.
  The `state` event only ever carries a completed refresh.
- A write never invents state either: Hamlib's own cache decides what the next
  read reports.

## Writing

- `setMode(mode)` fills in the passband through Hamlib's own `passband_normal`;
  pass a width to override it.
- `setPassband('normal' | 'narrow' | 'wide')` reads the current mode, applies
  the matching Hamlib passband helper and writes both back as one operation.
- `setPtt(true | false)` is an explicit command, not a toggle. The observed
  state is `state.ptt` (or the `ptt` event); do not overwrite it with what was
  requested.

Every `Rig` method is one compound operation on the module's queue, so a raw
call, a call on another rig or a later `Rig` call cannot interleave with its
steps.

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
so a slow rig cannot build a backlog. A tick is best effort - a failed field
emits `error` and leaves the rest untouched. `close()` and `dispose()` stop
every poll synchronously.

## Levels

Levels are opt-in: `createHamlib({ levels: ['STRENGTH', 'SWR'] })` names the ones
the instance may read, and `refresh()`/`watch()` read only those the model
advertises. The available names are `STRENGTH`, `SWR`, `ALC`, `RFPOWER` (the
setpoint) and `RFPOWER_METER` (measured power).

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
the model declares; an open that gets no answer is rejected with the rate it
tried and the declared range, rather than looking like a connected rig whose
every read fails.

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
underlying `cause` when a transport raised it. Codes: `TRANSPORT_UNAVAILABLE`,
`PORT_PERMISSION_DENIED`, `TRANSPORT_FAILURE`, `HAMLIB_ERROR`,
`RIG_UNRESPONSIVE`, `INVALID_ARGUMENT`, `UNSUPPORTED_OPERATION`, `RIG_CLOSED`,
`RIG_TIMEOUT`, `RIG_HUNG`, `DISPOSED`.

Every native call runs under a watchdog, `callTimeoutMs` (30 s by default).
Asyncify cannot unwind a suspended call, so an overrun is not cancelled: the
caller gets `RIG_TIMEOUT`, later calls get `RIG_HUNG`, and `dispose()` still
closes the port. Create a new instance to continue.

See the [API reference](../../api/hamlib-wasm/readme/) for every type and option.
