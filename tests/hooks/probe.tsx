/**
 * Render helpers for the hook unit tests.
 *
 * No testing library: a container, a root and React's own `act` are enough, and
 * they keep the dependencies to `react`, `react-dom`, `vitest` and `jsdom`.
 */
import { StrictMode, act, useEffect, useRef } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';

import { HamlibProvider, useEasyRig } from 'hamlib-wasm/react';
import type { HamlibOptions } from 'hamlib-wasm';

import { MODEL } from './fake-hamlib';
import type { HamlibError } from './fake-hamlib';

/** Read once by the provider. */
const PROVIDER_OPTIONS: HamlibOptions = {};

/** What the hook last published. */
export interface Published {
  rig: unknown;
  connecting: boolean;
  error: HamlibError | undefined;
}

/** The hook's own API, republished every render. */
export interface Controls {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
}

export interface ProbeHandle {
  readonly published: Published;
  readonly controls: Controls;
  unmount(): void;
}

/** Let React flush the provider's module load and every queued effect. */
export async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

export interface RenderProbeOptions {
  /** Start a connection from the mount effect, the way an app would. */
  connectOnMount?: boolean;
  /** Render the whole tree, provider included, under `StrictMode`. */
  strict?: boolean;
  /**
   * Mount and load the provider first, then mount the probe under `StrictMode`
   * inside it.  Both of StrictMode's effect passes then run with a module
   * ready, which is the situation in which a shared liveness flag revives a
   * stale callback; a plain `strict` mount loads the module during the first
   * pass, so no attempt can be in flight when the cleanup runs.
   */
  strictAfterLoad?: boolean;
}

/**
 * Mount the probe and return the handles the tests drive.
 *
 * The probe starts no connection unless asked to, so a test decides exactly
 * which attempt exists and when.
 */
export async function renderProbe(options: RenderProbeOptions = {}): Promise<ProbeHandle> {
  const published: Published = { rig: undefined, connecting: false, error: undefined };
  const controls: Controls = {
    connect: () => Promise.reject(new Error('the probe has not rendered yet')),
    disconnect: () => Promise.resolve(),
  };

  function Probe(): ReactElement {
    const { rig, connecting, error, connect, disconnect } = useEasyRig();
    const startedRef = useRef(false);

    useEffect(() => {
      published.rig = rig;
      published.connecting = connecting;
      published.error = error;
      controls.connect = () => connect({ modelId: MODEL.id });
      controls.disconnect = disconnect;
    });

    useEffect(() => {
      /* Once per instance, so a StrictMode remount does not start a second
       * connection: the hazard under test is the attempt that survives the
       * cleanup, not the number of attempts. */
      if (options.connectOnMount !== true || startedRef.current) {
        return;
      }

      startedRef.current = true;
      void connect({ modelId: MODEL.id }).catch(() => undefined);
    }, [connect]);

    return <p>probe</p>;
  }

  const container = document.createElement('div');

  document.body.append(container);

  const provider = <HamlibProvider options={PROVIDER_OPTIONS}><Probe /></HamlibProvider>;
  const root = createRoot(container);

  if (options.strictAfterLoad === true) {
    await act(async () => {
      root.render(<HamlibProvider options={PROVIDER_OPTIONS}>{null}</HamlibProvider>);
    });
    await flush();
    await act(async () => {
      root.render(
        <HamlibProvider options={PROVIDER_OPTIONS}>
          <StrictMode><Probe /></StrictMode>
        </HamlibProvider>,
      );
    });
  } else {
    await act(async () => {
      root.render(options.strict === true ? <StrictMode>{provider}</StrictMode> : provider);
    });
  }

  /* The provider loads its module in an effect, and `connect` needs it. */
  await flush();

  return {
    published,
    controls,
    unmount: (): void => {
      act(() => {
        root.unmount();
      });
    },
  };
}
