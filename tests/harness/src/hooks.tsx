/**
 * The hook harness page: it drives `useRig` and `useRigState` exactly the
 * way an application would, and publishes what the hooks published as plain
 * data.
 *
 * The specs use it for the connection races the demo's own UI hides - its
 * Connect and Disconnect buttons are disabled while a connection is pending -
 * so with the Web Serial double parked inside `SerialPort.open()` a spec can
 * cancel the attempt from outside, then assert both what the hooks published
 * and, through the emulator, that the port was really released.
 *
 * Test artifact, not an example: nothing here is shipped.
 */
import { StrictMode, useEffect, useRef } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';

import { HamlibProvider, useRig, useModels, useRigState } from 'hamlib-wasm/react';
import type { HamlibOptions } from 'hamlib-wasm';

import { POLL_MS } from './hook-harness-types';
import type { HookControls, HookSnapshot } from './hook-harness-types';

/** Read once by the provider: a second Wasm instance is never wanted here. */
const OPTIONS: HamlibOptions = {};

/** What the mounted probe published, or `undefined` while nothing is mounted. */
let controls: HookControls | undefined;

const EMPTY_SNAPSHOT: HookSnapshot = {
  ready: false,
  connected: false,
  connecting: false,
  error: null,
  hasState: false,
  frequency: null,
  snapshots: 0,
};

/**
 * The last snapshot the probe rendered, kept after it unmounts.
 *
 * A spec that cancels an attempt by taking the probe away needs to see what
 * the hooks had published *before* they went away.
 */
let lastPublished: HookSnapshot = EMPTY_SNAPSHOT;

function Probe(): ReactElement {
  const { rig, connecting, error, connect, disconnect, clearError } = useRig();
  const models = useModels();
  const state = useRigState(rig, { pollMs: POLL_MS });
  const snapshotsRef = useRef(0);

  useEffect(() => {
    if (state !== undefined) {
      snapshotsRef.current += 1;
    }
  }, [state]);

  /* Re-published every render, so a spec always sees the latest render's
   * values; cleared on unmount so a late call cannot act on a dead tree. */
  useEffect(() => {
    const harness: HookControls = {
      connect: (modelName: string, baudRate?: number) => {
        const model = models.find((candidate) => candidate.model === modelName);

        if (model === undefined) {
          return Promise.reject(new Error(`the catalogue has no ${modelName}`));
        }

        return connect(
          baudRate === undefined
            ? { modelId: model.id }
            : { modelId: model.id, baudRate },
        );
      },
      disconnect,
      clearError,
      snapshot: (): HookSnapshot => ({
        ready: models.length > 0,
        connected: rig !== undefined,
        connecting,
        error: error === undefined
          ? null
          : { code: error.code, operation: error.operation, message: error.message },
        hasState: state !== undefined,
        frequency: state?.frequency ?? null,
        snapshots: snapshotsRef.current,
      }),
    };

    controls = harness;
    lastPublished = harness.snapshot();

    return () => {
      if (controls === harness) {
        controls = undefined;
      }
    };
  });

  return <p id="probe">hook probe</p>;
}

const container = document.getElementById('root');

if (container === null) {
  throw new Error('the hook harness page has no #root element');
}

let root = createRoot(container);

/**
 * StrictMode is opt-in through the URL (`?strict=1`): React only double-invokes
 * effects in a development build, so the specs that need it point at the dev
 * server instead of the preview.
 */
const strict = new URLSearchParams(window.location.search).has('strict');

/** Whether the probe is rendered; the provider stays mounted either way. */
let visible = true;

/** Render (or re-render) the provider and, while visible, the probe. */
function render(): void {
  const tree = <HamlibProvider options={OPTIONS}>{visible ? <Probe /> : null}</HamlibProvider>;

  root.render(strict ? <StrictMode>{tree}</StrictMode> : tree);
}

function mount(): void {
  visible = true;
  render();
}

function unmount(): void {
  root.unmount();
  /* React 19 refuses to render into an unmounted root, so a remount gets a
   * fresh one. */
  root = createRoot(container as HTMLElement);
}

window.__hookHarness = {
  connect: (modelName: string, baudRate?: number) => controls === undefined
    ? Promise.reject(new Error('the hook harness is not mounted'))
    : controls.connect(modelName, baudRate),
  disconnect: () => controls?.disconnect() ?? Promise.resolve(),
  clearError: () => { controls?.clearError(); },
  snapshot: () => controls?.snapshot() ?? EMPTY_SNAPSHOT,
  lastPublished: () => lastPublished,
  setProbeVisible: (isVisible: boolean) => {
    visible = isVisible;
    render();
  },
  unmount,
  mount,
};

mount();
