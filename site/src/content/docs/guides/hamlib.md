---
title: 1:1 Hamlib API
description: createHamlib and the generated Rig - a typed method per upstream Hamlib call.
---

`hamlib-wasm/hamlib` exposes Hamlib as it is: `createHamlib()` and a `Rig`
with one typed method per upstream call, named after it. Use it when the
[easy surface](../easy/) does not cover what you need - or reach the same
object from an easy rig as `rig.raw`, without loading a second module.

```ts
import { createHamlib, HamlibError } from 'hamlib-wasm/hamlib';
import type { Hamlib, Rig, RigModeState } from 'hamlib-wasm/hamlib';

const hamlib: Hamlib = await createHamlib();
const port = await hamlib.requestPort();          // requires a user gesture
const rig: Rig = await hamlib.open({ modelId, port, baudRate: 19200 });

const frequency: number = await rig.getFrequency();
const mode: RigModeState = await rig.getMode();   // { mode, passband }
await rig.setFrequency(7_074_000);
await rig.setMode('CW', 500);                     // the width is the caller's
await rig.setPtt('on');
const ptt: string = await rig.getPtt();           // the rig's own state name

await rig.close();
await hamlib.dispose();
```

## What is bound

Every method on `Rig` is generated from the pinned upstream Hamlib headers. A
declaration is bound because the upstream `rigctl`/`rigctld` sources call it;
one whose types cannot be mapped is refused with a recorded reason instead of
being bound as a guess. That is about a hundred methods today:

```ts
rig.model.capabilities;                       // string[]: methods this model implements
await rig.setRit(500);
await rig.setLevel('RF', 0.5);                // level name + value
const split = await rig.getSplitFreqMode();   // { txFreq, txMode, txWidth }
await rig.passbandWide('USB');                // pure: no CAT traffic, still queued
```

The discovery surface `rigctl` uses is bound too, so a client can find out what
a model offers without a hard-coded table: `tokenForeach()`,
`extLevelForeach()`, `extFuncForeach()` and `extParmForeach()` walk the
configuration and extension tables, and `hasScan()`/`hasVfoOp()` return the
backend's own masks. Every walker returns plain `RigConfparam` objects.

## Gating and arguments

Each method is gated by `rig.model.capabilities`, derived from the backend's
`rig_caps`: calling one the model does not implement throws
`UNSUPPORTED_OPERATION` before the rig is touched. The PTT methods are gated on
the catalogue's own flags instead, because a backend that keys PTT over the
serial RTS/DTR line declares no `get_ptt`/`set_ptt` function.

The library does not second-guess arguments. `RigMode` is a `string` parsed by
Hamlib's `rig_parse_mode()`; an unknown name or unsupported width is Hamlib's
error to report.

## One queue

The module is single-threaded and runs under Asyncify, so every call -
including the "pure" helpers that make no CAT traffic - goes through one queue
per module. Calls never overlap, but a sequence of calls is not atomic: if two
steps must not be separated by another caller, order them yourself (the easy
surface does this for `setMode` and `setPassband`).

## Mixing with the easy surface

`EasyRig.raw` is this `Rig`. The [live demo](../../demo/) drives one rig both
ways and logs the calls each makes:

```ts
import { createEasy } from 'hamlib-wasm';

const easy = await createEasy();
const rig = await easy.open({ modelId });

await rig.setMode('USB');                                   // easy: width filled in
await rig.raw.setMode('USB', await rig.raw.passbandNormal('USB'));  // 1:1: spelled out
await rig.raw.setRit(200);                                  // only on the 1:1 surface
```

See the [API reference](../../api/hamlib-wasm/hamlib/readme/) for the full `Rig`.
