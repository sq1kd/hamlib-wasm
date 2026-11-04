---
title: React hooks
description: HamlibProvider, useEasyRig, useRigState, useRigError and useModels.
---

`hamlib-wasm/react` wraps the [easy surface](../easy/) in a provider and a few
hooks. `react` is an optional peer dependency; no other entry imports it.

```tsx
import { createRoot } from 'react-dom/client';
import { HamlibProvider, useEasyRig, useModels, useRigError, useRigState } from 'hamlib-wasm/react';

function Rig() {
  const models = useModels();
  const { rig, connect, disconnect, connecting, error } = useEasyRig();
  const state = useRigState(rig, { pollMs: 1000 });
  const failure = useRigError(rig);

  if (rig === undefined) {
    return (
      <button disabled={connecting || models.length === 0}
              onClick={() => void connect({ modelId: models[0].id })}>
        Connect
      </button>
    );
  }

  return (
    <>
      <p>{state?.frequency ?? '…'} Hz {state?.mode}</p>
      <button onClick={() => void rig.setPtt(false)}>TX off</button>
      <button onClick={() => void disconnect()}>Disconnect</button>
      {(error ?? failure) && <p>{(error ?? failure)?.message}</p>}
    </>
  );
}

const options = { levels: ['STRENGTH'] } as const;

createRoot(document.getElementById('root')!).render(
  <HamlibProvider options={options}><Rig /></HamlibProvider>,
);
```

## The pieces

| Hook | What it does |
| --- | --- |
| `HamlibProvider` | Loads one module with `createEasy(options)` and disposes it on unmount. `options` is read once - keep it stable. |
| `useHamlibContext()` / `useHamlib()` | The loaded `EasyHamlib`, plus `loading` and the load `error`. |
| `useModels()` | The model catalogue; empty until the module has loaded. |
| `useEasyRig()` | Owns one rig: `connect(options)`, `disconnect()`, `rig`, `connecting`, `error`. Closes the rig on unmount. |
| `useRigState(rig, { pollMs, fields, levels })` | Subscribes to the `state` event and, with `pollMs`, registers the rig's own `watch()` for exactly the fields named. |
| `useRigError(rig)` | The last operation failure the rig reported. |

## Guarantees

- **One module per provider.** A second provider is a second Wasm instance with
  its own memory - rarely what you want.
- **Ownership races are handled.** Each `connect()` carries an identity:
  `disconnect()`, a newer `connect()` or unmount invalidate older attempts, and
  an attempt that finishes after being superseded closes what it opened instead
  of publishing it.
- **StrictMode-safe.** An effect that unmounts before its module or rig
  finished opening disposes what it created.
- **Polling composes.** `useRigState` registers its own `watch()` and removes
  only that registration, so several components can poll the same rig at
  different rates.
- **Errors do not strand cleanup.** On a telemetry failure the rig stays owned
  and `error` reports it, so Disconnect stays available.

`connect()` without a `port` runs `requestPort()`, so call it from a click
handler in a browser.

The [live demo](../../demo/) is built on these hooks. See the
[API reference](../../api/hamlib-wasm/react/readme/) for every option.
