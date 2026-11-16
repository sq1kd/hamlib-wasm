---
title: React hooks
description: HamlibProvider, useRig, useRigState, useRigError and useModels.
---

`hamlib-wasm/react` wraps the [default surface](../rig-api/) in a provider and a few
hooks. They own the module, the rig and the polling, so your components only
render what they get. `react` is an optional peer dependency; no other entry
imports it.

```tsx
import { createRoot } from 'react-dom/client';
import { HamlibProvider, useRig, useModels, useRigError, useRigState } from 'hamlib-wasm/react';

function RigView() {
  const models = useModels();
  const { rig, connect, disconnect, connecting, error } = useRig();
  const state = useRigState(rig, { pollMs: 1000 });
  const failure = useRigError(rig);
  const model = models.find((entry) => entry.model === 'TS-480');

  if (rig === undefined) {
    return (
      <button disabled={connecting || model === undefined}
              // connect() publishes its failure as `error` and also rejects.
              onClick={() => connect({ modelId: model!.id, baudRate: 9600 }).catch(() => {})}>
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
  <HamlibProvider options={options}><RigView /></HamlibProvider>,
);
```

## The pieces

| Hook | What it does |
| --- | --- |
| `HamlibProvider` | Loads one module with `createHamlib(options)` and disposes it on unmount. `options` is read once - keep it stable. |
| `useHamlibContext()` | `{ hamlib, loading, error }`: the module once loaded, and the load error if it failed. |
| `useHamlib()` | The loaded `Hamlib`. Throws while it is still loading, so use it only below a check of `loading`. |
| `useModels()` | The model catalogue; empty until the module has loaded. |
| `useRig()` | Owns one rig: `connect(options)`, `disconnect()`, `rig`, `connecting`, `error`, `clearError()`. Closes the rig on unmount. `connect()` both sets `error` and rejects. |
| `useRigState(rig, { pollMs, fields, levels })` | Subscribes to the `state` event and, with `pollMs`, registers the rig's own `watch()` for exactly the fields named. |
| `useRigError(rig)` | The last operation failure the rig reported. Reset when `rig` changes, not by a later success. |

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
handler in a browser. Dismissing the chooser rejects it with
`PORT_PERMISSION_DENIED`; handle the promise (`.catch(() => {})` is enough
when the UI shows `error`), or the browser reports an unhandled rejection.

The [live demo](../../demo/) is built on these hooks. See the
[API reference](../../api/hamlib-wasm/react/readme/) for every option.
