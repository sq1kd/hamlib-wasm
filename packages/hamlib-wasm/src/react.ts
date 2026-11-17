// SPDX-License-Identifier: MIT

/**
 * hamlib-wasm/react - React bindings for the default surface.
 *
 * `react` is an optional peer dependency: importing `hamlib-wasm` or
 * `hamlib-wasm/raw` never pulls it in, and this entry is the only one that
 * does.
 *
 * The shape follows the constraints the Wasm module imposes:
 *
 *  - one module per provider, disposed on unmount (a second provider is a
 *    second Wasm instance with its own memory);
 *  - one connected rig per `useRig()` caller, closed on unmount;
 *  - polling is `useRigState(rig, { pollMs })`, which is the rig's own
 *    `watch()` - the calls serialize on the module queue, so a poll never
 *    overlaps a write;
 *  - StrictMode double-invocation is handled: an effect that unmounts before
 *    its module or rig finished opening disposes what it created.
 *
 * No JSX is required: the provider builds its element with `createElement`, so
 * this entry compiles as ordinary TypeScript.
 *
 * @packageDocumentation
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

import { asHamlibError } from './errors.js';
import { createHamlib } from './index.js';
import type {
  Hamlib,
  HamlibError,
  HamlibOptions,
  Rig,
  LevelName,
  OpenRigOptions,
  RigField,
  RigModel,
  RigState,
} from './index.js';

export type {
  Hamlib,
  HamlibErrorCode,
  HamlibOptions,
  LevelName,
  OpenRigOptions,
  PassbandSelector,
  PortFilter,
  PortRequest,
  PttState,
  Rig,
  RigCapabilities,
  RigEvents,
  RigField,
  RigMode,
  RigModel,
  RigState,
  RigOperationCapabilities,
  SerialInputSignals,
  SerialLineSettings,
  SerialOutputSignals,
  SerialPortInfo,
  SerialPortLike,
  SerialTransport,
  WatchOptions,
} from './index.js';
export { HamlibError, createHamlib, webSerialTransport } from './index.js';

/** What the provider publishes. */
export interface HamlibContextValue {
  /** The loaded module, or `undefined` while it is still loading. */
  readonly hamlib: Hamlib | undefined;
  /** Why loading failed, when it did. */
  readonly error: HamlibError | undefined;
  readonly loading: boolean;
}

const HamlibContext = createContext<HamlibContextValue | undefined>(undefined);

export interface HamlibProviderProps {
  children?: ReactNode;
  /**
   * Passed to `createHamlib` when the provider mounts.
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
    let instance: Hamlib | undefined;

    void (async () => {
      try {
        const created = await createHamlib(optionsRef.current ?? {});
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
            error: asHamlibError(error, 'createHamlib'),
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

/**
 * The provider's value: the module once loaded, `loading` until then, and the
 * load `error` if it failed.  Throws when there is no provider above.
 */
export function useHamlibContext(): HamlibContextValue {
  const value = useContext(HamlibContext);

  if (value === undefined) {
    throw new Error('useHamlib requires a <HamlibProvider> above it');
  }

  return value;
}

/**
 * The loaded module.
 *
 * Throws while it is still loading - including on the first render - so call
 * it only below a component that has checked `useHamlibContext().loading`.
 */
export function useHamlib(): Hamlib {
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

export interface UseRigResult {
  /** The connected rig, once `connect()` has resolved. */
  readonly rig: Rig | undefined;
  readonly connecting: boolean;
  /** A failed `connect()`.  Rig operations report through `useRigError`. */
  readonly error: HamlibError | undefined;
  /**
   * Open a rig.  Without `port`, this runs `requestPort()`, so it must be
   * called from a user gesture.
   *
   * A failure is published as `error` and also rejects, so handle the promise:
   * `connect(options).catch(() => {})` when `error` is all the UI needs.
   * Dismissing the browser's port chooser is such a failure
   * (`PORT_PERMISSION_DENIED`).
   */
  connect(options: OpenRigOptions): Promise<void>;
  /** Close the current rig.  Safe to call when there is none. */
  disconnect(): Promise<void>;
  /** Forget the last `connect()` failure. */
  clearError(): void;
}

/**
 * Own one rig for the component's lifetime.
 *
 * Closing on unmount is the default rather than an opt-in: a rig owns a port,
 * and a React tree that forgets to close one leaves the device locked.
 */
export function useRig(): UseRigResult {
  const { hamlib } = useHamlibContext();
  const [rig, setRig] = useState<Rig | undefined>(undefined);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<HamlibError | undefined>(undefined);
  const rigRef = useRef<Rig | undefined>(undefined);
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
  const release = useCallback(async (current: Rig | undefined): Promise<void> => {
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

  const connect = useCallback(async (options: OpenRigOptions): Promise<void> => {
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
  /**
   * Fields the poll reads; see {@link WatchOptions.fields}.  Omitted, the
   * poll reads frequency, mode and PTT - not levels.
   *
   * Compared by value, so a literal array in render does not restart the poll.
   */
  fields?: readonly RigField[];
  /** Levels the poll reads; implies the `'levels'` field. */
  levels?: readonly LevelName[];
}

/**
 * The rig's state snapshot, kept current from its `state` event and, when
 * `pollMs` is set and the rig is connected, from a poll.
 */
export function useRigState(
  rig: Rig | undefined,
  options: UseRigStateOptions = {},
): RigState | undefined {
  const [state, setState] = useState<RigState | undefined>(rig?.state);
  const pollMs = options.pollMs ?? 0;
  /* Value keys, not the arrays: an inline `fields` literal is a new identity on
   * every render and would restart the poll each time. */
  const fieldsKey = options.fields?.join(',') ?? '';
  const levelsKey = options.levels?.join(',') ?? '';

  useEffect(() => {
    if (rig === undefined) {
      setState(undefined);
      return;
    }

    setState(rig.state);

    const unsubscribe = rig.on('state', setState);
    /* A poll must not ask for a level the instance cannot read: `watch()`
     * refuses that, and a throw from an effect would take the tree with it.
     * The hook therefore polls the intersection of what was asked for and what
     * the rig advertises. */
    const advertised = new Set<LevelName>(rig.capabilities.levels);
    const fields = fieldsKey === ''
      ? undefined
      : fieldsKey.split(',').filter(
        (field) => field !== 'levels' || advertised.size > 0,
      ) as RigField[];
    const levels = levelsKey === ''
      ? undefined
      : levelsKey.split(',').filter((name) => advertised.has(name as LevelName)) as LevelName[];
    /* useRig keeps a lost rig published, and watch() throws on it. */
    const stop = pollMs > 0 && rig.connected
      ? rig.watch({
        intervalMs: pollMs,
        ...(fields === undefined ? {} : { fields }),
        ...(levels === undefined || levels.length === 0 ? {} : { levels }),
      })
      : undefined;

    return () => {
      unsubscribe();
      stop?.();
    };
  }, [rig, pollMs, fieldsKey, levelsKey]);

  return state;
}

/**
 * The most recent operation failure the rig reported, if any.  It is reset
 * when `rig` changes; it is not cleared by a later success.
 */
export function useRigError(rig: Rig | undefined): HamlibError | undefined {
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
