/**
 * hamlib-web/react - React bindings for the easy surface.
 *
 * `react` is an optional peer dependency: importing `hamlib-web` or
 * `hamlib-web/native` never pulls it in, and this entry is the only one that
 * does.
 *
 * The shape follows the constraints the Wasm module imposes:
 *
 *  - one module per provider, disposed on unmount (a second provider is a
 *    second Wasm instance with its own memory);
 *  - one connected rig per `useEasyRig()` caller, closed on unmount;
 *  - polling is `useRigState(rig, { pollMs })`, which is the rig's own
 *    `watch()` - the calls serialize on the module queue, so a poll never
 *    overlaps a write;
 *  - StrictMode double-invocation is handled: an effect that unmounts before
 *    its module or rig finished opening disposes what it created.
 *
 * No JSX is required: the provider builds its element with `createElement`, so
 * this entry compiles as ordinary TypeScript.
 */

import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import type { ReactElement, ReactNode } from 'react';

import { HamlibError, createEasy } from './index.js';
import type {
  EasyHamlib,
  EasyRig,
  HamlibOptions,
  OpenEasyRigOptions,
  RigModel,
  RigState,
} from './index.js';

export type {
  EasyCapabilities,
  EasyHamlib,
  EasyRig,
  EasyRigEvents,
  HamlibOptions,
  OpenEasyRigOptions,
  PassbandSelector,
  PttState,
  RigModel,
  RigState,
} from './index.js';
export { HamlibError, createEasy } from './index.js';

/** Wrap any thrown value as a `HamlibError`. */
function asHamlibError(error: unknown, operation: string): HamlibError {
  if (error instanceof HamlibError) {
    return error;
  }

  return new HamlibError(
    error instanceof Error ? error.message : String(error),
    { code: 'TRANSPORT_FAILURE', operation, cause: error },
  );
}

/** What the provider publishes. */
export interface HamlibContextValue {
  /** The loaded module, or `undefined` while it is still loading. */
  readonly hamlib: EasyHamlib | undefined;
  /** Why loading failed, when it did. */
  readonly error: HamlibError | undefined;
  readonly loading: boolean;
}

const HamlibContext = createContext<HamlibContextValue | undefined>(undefined);

export interface HamlibProviderProps {
  children?: ReactNode;
  /**
   * Passed to `createEasy` when the provider mounts.
   *
   * Read once: keep this object stable (a module constant, or memoized with
   * `useMemo`) - changing its identity does not re-create the module, because
   * a second Wasm instance is never what a re-render wants.
   */
  options?: HamlibOptions;
}

/**
 * Load one Hamlib instance and publish it to the hooks below.
 *
 * Renders `children` immediately; the hooks report `loading` until the module
 * is ready, so a page can show its own skeleton.
 */
export function HamlibProvider({ children, options }: HamlibProviderProps): ReactElement {
  const [value, setValue] = useState<HamlibContextValue>({
    hamlib: undefined,
    error: undefined,
    loading: true,
  });
  const optionsRef = useRef<HamlibOptions | undefined>(options);

  useEffect(() => {
    let live = true;
    let instance: EasyHamlib | undefined;

    void (async () => {
      try {
        const created = await createEasy(optionsRef.current ?? {});
        instance = created;

        if (live) {
          setValue({ hamlib: created, error: undefined, loading: false });
        } else {
          /* Mounted and unmounted before the module loaded: nothing may
           * survive the effect. */
          await created.dispose();
        }
      } catch (error) {
        if (live) {
          setValue({
            hamlib: undefined,
            error: asHamlibError(error, 'createEasy'),
            loading: false,
          });
        }
      }
    })();

    return () => {
      live = false;
      void instance?.dispose();
    };
  }, []);

  return createElement(HamlibContext.Provider, { value }, children);
}

/** The provider's value.  Throws when there is no provider above. */
export function useHamlibContext(): HamlibContextValue {
  const value = useContext(HamlibContext);

  if (value === undefined) {
    throw new Error('useHamlib requires a <HamlibProvider> above it');
  }

  return value;
}

/** The loaded module.  Throws while it is still loading. */
export function useHamlib(): EasyHamlib {
  const { hamlib } = useHamlibContext();

  if (hamlib === undefined) {
    throw new Error('the Hamlib module is not loaded yet; wait for HamlibProvider to finish');
  }

  return hamlib;
}

const NO_MODELS: readonly RigModel[] = [];

/** The catalogue, empty until the module loads. */
export function useModels(): readonly RigModel[] {
  return useHamlibContext().hamlib?.models ?? NO_MODELS;
}

export interface UseEasyRigResult {
  /** The connected rig, once `connect()` has resolved. */
  readonly rig: EasyRig | undefined;
  readonly connecting: boolean;
  /** A failed `connect()`.  Rig operations report through `useRigError`. */
  readonly error: HamlibError | undefined;
  /**
   * Open a rig.  Without `port`, this runs `requestPort()`, so it must be
   * called from a user gesture.
   */
  connect(options: OpenEasyRigOptions): Promise<void>;
  /** Close the current rig.  Safe to call when there is none. */
  disconnect(): Promise<void>;
  clearError(): void;
}

/**
 * Own one rig for the component's lifetime.
 *
 * Closing on unmount is the default rather than an opt-in: a rig owns a port,
 * and a React tree that forgets to close one leaves the device locked.
 */
export function useEasyRig(): UseEasyRigResult {
  const { hamlib } = useHamlibContext();
  const [rig, setRig] = useState<EasyRig | undefined>(undefined);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<HamlibError | undefined>(undefined);
  const rigRef = useRef<EasyRig | undefined>(undefined);
  /**
   * Identity of the connection attempt allowed to touch this hook's state.
   *
   * Every `connect()` takes the next value; `disconnect()`, unmount and a
   * replacement connection bump it.  A monotonic counter rather than a
   * boolean, so a stale callback cannot become valid again just because the
   * hook remounted (StrictMode) and a shared liveness flag flipped back.
   */
  const generationRef = useRef(0);

  const claim = useCallback((): number => {
    generationRef.current += 1;
    return generationRef.current;
  }, []);

  /** Drop the current rig and close it; the caller owns the generation. */
  const release = useCallback(async (current: EasyRig | undefined): Promise<void> => {
    rigRef.current = undefined;
    setRig(undefined);
    await current?.close();
  }, []);

  useEffect(() => () => {
    /* Unmount invalidates every attempt, so one that finishes opening later
     * closes what it opened instead of publishing it - and the state that
     * attempt owned does not survive into a remount. */
    generationRef.current += 1;
    setConnecting(false);
    setError(undefined);

    const current = rigRef.current;

    rigRef.current = undefined;
    void current?.close();
  }, []);

  const disconnect = useCallback(async (): Promise<void> => {
    claim();
    setConnecting(false);
    await release(rigRef.current);
  }, [claim, release]);

  const connect = useCallback(async (options: OpenEasyRigOptions): Promise<void> => {
    if (!hamlib) {
      throw new Error('the Hamlib module is not loaded yet; wait for HamlibProvider to finish');
    }

    const generation = claim();

    setConnecting(true);
    setError(undefined);

    try {
      /* Close the previous rig as part of this attempt.  Deliberately not
       * `disconnect()`: that would claim a new generation and invalidate this
       * very attempt. */
      await release(rigRef.current);

      if (generation !== generationRef.current) {
        return;
      }

      const opened = await hamlib.open(options);

      if (generation !== generationRef.current) {
        /* Superseded (or unmounted) while the port was opening: the rig that
         * did open has no owner, so close it instead of publishing it. */
        await opened.close();
        return;
      }

      rigRef.current = opened;
      setRig(opened);
    } catch (cause) {
      const failure = asHamlibError(cause, 'open');

      /* Only the current attempt may publish an error. */
      if (generation === generationRef.current) {
        setError(failure);
      }

      throw failure;
    } finally {
      if (generation === generationRef.current) {
        setConnecting(false);
      }
    }
  }, [hamlib, claim, release]);

  const clearError = useCallback((): void => {
    setError(undefined);
  }, []);

  return { rig, connecting, error, connect, disconnect, clearError };
}

export interface UseRigStateOptions {
  /** Poll every `pollMs`; `0` (the default) reads only on demand. */
  pollMs?: number;
}

/**
 * The rig's state snapshot, kept current from its `state` event and, when
 * `pollMs` is set, from a poll.
 */
export function useRigState(
  rig: EasyRig | undefined,
  options: UseRigStateOptions = {},
): RigState | undefined {
  const [state, setState] = useState<RigState | undefined>(rig?.state);
  const pollMs = options.pollMs ?? 0;

  useEffect(() => {
    if (rig === undefined) {
      setState(undefined);
      return;
    }

    setState(rig.state);

    const unsubscribe = rig.on('state', setState);
    const stop = pollMs > 0 ? rig.watch(pollMs) : undefined;

    return () => {
      unsubscribe();
      stop?.();
    };
  }, [rig, pollMs]);

  return state;
}

/** The most recent operation failure the rig reported, if any. */
export function useRigError(rig: EasyRig | undefined): HamlibError | undefined {
  const [error, setError] = useState<HamlibError | undefined>(undefined);

  useEffect(() => {
    if (rig === undefined) {
      setError(undefined);
      return;
    }

    setError(undefined);

    return rig.on('error', setError);
  }, [rig]);

  return error;
}
