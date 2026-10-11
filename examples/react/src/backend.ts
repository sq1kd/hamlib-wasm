/**
 * The two backends the demo can drive the same panel with.
 *
 * The point of the comparison is the call surface each one produces, so both
 * expose one `Backend` shape and log every call they make:
 *
 *  - `easy` uses `hamlib-web/react` (`useEasyRig`, `useRigState`), so a
 *    refresh is one `refresh()` and a mode change fills in the passband;
 *  - `native` uses `hamlib-web/native` directly (`createHamlib` and the rig's
 *    generated methods), so the same screen is three explicit reads and an
 *    explicit passband, polled by hand.
 *
 * The panel cannot tell them apart, which is the point.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { HamlibError, capabilitiesOf } from 'hamlib-web';
import type { EasyCapabilities, EasyRig, PttState, RigState } from 'hamlib-web';
import { useEasyRig, useRigError, useRigState } from 'hamlib-web/react';
import { createHamlib } from 'hamlib-web/native';
import type { Hamlib, Rig } from 'hamlib-web/native';

import type { PassbandKind } from './RigPanel';

export type BackendKind = 'easy' | 'native';

/** How often a connected backend re-reads the rig, in milliseconds. */
export const POLL_MS = 1000;

export interface LogEntry {
  readonly api: BackendKind;
  readonly call: string;
}

export type Log = (entry: LogEntry) => void;

export interface Backend {
  readonly kind: BackendKind;
  /**
   * Whether a rig is owned right now.
   *
   * This is the connection predicate, never `state !== undefined`: a snapshot
   * can be missing while a rig is owned (a model that cannot read telemetry),
   * and a stale one can outlive the ownership that produced it.
   */
  readonly connected: boolean;
  readonly state: RigState | undefined;
  readonly capabilities: EasyCapabilities;
  readonly connecting: boolean;
  readonly error: HamlibError | undefined;
  /**
   * Open a rig.
   *
   * `port` is a port that was already granted, used when the caller had to ask
   * for one to find the baud rate first; without it the backend asks for one
   * itself, which is why this needs a user gesture either way.
   */
  connect(modelId: number, baudRate: number | undefined, port?: SerialPort): Promise<void>;
  disconnect(): Promise<void>;
  setFrequency(hz: number): Promise<void>;
  setMode(mode: string, passband?: number): Promise<void>;
  setPassband(kind: PassbandKind): Promise<void>;
  setPtt(on: boolean): Promise<void>;
  refresh(): Promise<void>;
}

/** What a backend can do before a rig is connected. */
export const NO_CAPABILITIES: EasyCapabilities = {
  getFrequency: false,
  setFrequency: false,
  getMode: false,
  setMode: false,
  getPtt: false,
  setPtt: false,
};

const PTT_STATES: readonly PttState[] = ['off', 'on', 'on-mic', 'on-data'];

function toPttState(value: string): PttState {
  return PTT_STATES.find((state) => state === value) ?? 'off';
}

function asError(error: unknown, operation: string): HamlibError {
  if (error instanceof HamlibError) {
    return error;
  }

  return new HamlibError(
    error instanceof Error ? error.message : String(error),
    { code: 'TRANSPORT_FAILURE', operation, cause: error },
  );
}

/** Hamlib's own passband helper for the requested width. */
async function passbandWidth(rig: Rig, mode: string, kind: PassbandKind): Promise<number> {
  switch (kind) {
    case 'narrow':
      return rig.passbandNarrow(mode);
    case 'wide':
      return rig.passbandWide(mode);
    default:
      return rig.passbandNormal(mode);
  }
}

/** The easy surface: the panel's defaults, straight from the library. */
export function useEasyBackend(log: Log): Backend {
  const { rig, connecting, error: connectError, connect, disconnect } = useEasyRig();
  const state = useRigState(rig, { pollMs: POLL_MS });
  const operationError = useRigError(rig);

  const call = useCallback(async <T,>(label: string, run: () => Promise<T>): Promise<void> => {
    log({ api: 'easy', call: label });
    await run();
  }, [log]);

  const requireRig = useCallback((): EasyRig => {
    if (rig === undefined) {
      throw new HamlibError('the rig is not connected', { code: 'RIG_CLOSED', operation: 'open' });
    }

    return rig;
  }, [rig]);

  return useMemo<Backend>(() => ({
    kind: 'easy',
    connected: rig !== undefined,
    state,
    capabilities: rig?.capabilities ?? NO_CAPABILITIES,
    connecting,
    error: connectError ?? operationError,
    connect: async (modelId, baudRate, port) => {
      log({ api: 'easy', call: `open({ modelId: ${modelId}${baudRate === undefined ? '' : `, baudRate: ${baudRate}`}${port === undefined ? '' : ', port: <granted>'} })` });
      await connect({
        modelId,
        ...(baudRate === undefined ? {} : { baudRate }),
        ...(port === undefined ? {} : { port }),
      });
      /* The polling below is the app's declaration, not a call: the library's
       * watch() reads the rig on the module's queue. */
      log({ api: 'easy', call: `useRigState(rig, { pollMs: ${POLL_MS} })` });
    },
    disconnect: async () => {
      log({ api: 'easy', call: 'close()' });
      await disconnect();
    },
    setFrequency: (hz) => call(`setFrequency(${hz})`, () => requireRig().setFrequency(hz)),
    setMode: (mode, passband) => call(
      `setMode('${mode}'${passband === undefined ? '' : `, ${passband}`})`,
      async () => {
        const current = requireRig();

        if (passband === undefined) {
          /* The easy call fills the passband in from the model. */
          await current.setMode(mode);
          return;
        }

        await current.setMode(mode, passband);
      },
    ),
    setPtt: (on) => call(`setPtt(${on})`, () => requireRig().setPtt(on)),
    setPassband: (kind) => call(`setPassband('${kind}')`, async () => {
      /* One easy compound: the mode read, the width lookup and the write run
       * in a single queue slot, so a later mode selection cannot land between
       * them and be undone by this older action. */
      await requireRig().setPassband(kind);
    }),
    refresh: () => call('refresh()', async () => {
      await requireRig().refresh();
    }),
  }), [rig, state, connecting, connectError, operationError, connect, disconnect, call, log, requireRig]);
}

/** The 1:1 surface: the same screen, spelled out against `hamlib-web/native`. */
export function useNativeBackend(log: Log): Backend {
  const liveRef = useRef(true);
  /* The attempt counter.  Every `connect()` takes a new id, and every
   * `disconnect()` and unmount bumps it, so an attempt that no longer holds the
   * current id knows it must not publish - and must release what it opened. */
  const generationRef = useRef(0);
  /* The attempt currently in flight, or undefined: what a superseded attempt
   * asks before disposing a module no current attempt wants. */
  const pendingRef = useRef<number | undefined>(undefined);
  const modulePromiseRef = useRef<Promise<Hamlib> | undefined>(undefined);
  const moduleRef = useRef<Hamlib | undefined>(undefined);
  const rigRef = useRef<Rig | undefined>(undefined);
  const capsRef = useRef<EasyCapabilities>(NO_CAPABILITIES);
  const pollingRef = useRef(false);
  /* Order complete panel actions, not just each generated native call. */
  const actionTailRef = useRef<Promise<void> | undefined>(undefined);

  const [state, setState] = useState<RigState | undefined>(undefined);
  const [capabilities, setCapabilities] = useState<EasyCapabilities>(NO_CAPABILITIES);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<HamlibError | undefined>(undefined);
  const [connected, setConnected] = useState(false);

  /**
   * Whether `attempt` still owns this hook, and `rig` - when given - is still
   * the rig that attempt opened.  Every state, error and snapshot is checked
   * against it after the await that produced it.
   */
  const owns = useCallback(
    (attempt: number, rig?: Rig): boolean => liveRef.current
      && generationRef.current === attempt
      && (rig === undefined || rigRef.current === rig),
    [],
  );

  /* One Wasm module per hook, however many attempts ask for it: a superseded
   * attempt can then never leave a second module unowned. */
  const loadModule = useCallback((): Promise<Hamlib> => {
    const adopted = moduleRef.current;

    if (adopted !== undefined) {
      return Promise.resolve(adopted);
    }

    modulePromiseRef.current ??= createHamlib().catch((cause: unknown) => {
      /* A failed load must not poison the next attempt. */
      modulePromiseRef.current = undefined;
      throw cause;
    });

    return modulePromiseRef.current;
  }, []);

  /**
   * Give back a module this attempt loaded when no current attempt wants it:
   * work that went obsolete must not leave a Wasm instance behind.
   */
  const abandonModule = useCallback(async (attempt: number, module: Hamlib): Promise<void> => {
    const waiting = pendingRef.current;

    if (moduleRef.current !== undefined || (waiting !== undefined && waiting !== attempt)) {
      return;
    }

    modulePromiseRef.current = undefined;
    await module.dispose();
  }, []);

  /**
   * Read the telemetry the model advertises, and only that: an unsupported
   * field is omitted from the snapshot rather than invented.  A failed read
   * keeps the previous snapshot and reports itself as an error - it never
   * costs the rig its ownership.
   */
  const readTelemetry = useCallback(async (attempt: number, rig: Rig): Promise<void> => {
    const advertised = capsRef.current;

    try {
      const next: RigState = {};

      if (advertised.getFrequency) {
        log({ api: 'native', call: 'getFrequency()' });
        next.frequency = await rig.getFrequency();
      }

      if (advertised.getMode) {
        log({ api: 'native', call: 'getMode()' });
        const mode = await rig.getMode();

        next.mode = mode.mode;
        next.passband = mode.passband;
      }

      if (advertised.getPtt) {
        log({ api: 'native', call: 'getPtt()' });
        next.ptt = toPttState(await rig.getPtt());
      }

      if (owns(attempt, rig)) {
        setState(next);
      }
    } catch (cause) {
      if (owns(attempt, rig)) {
        setError(asError(cause, 'refresh'));
      }
    }
  }, [log, owns]);

  /* The poll `watch()` gives the easy backend, written by hand: one read at a
   * time, and no timer at all while no rig is owned. */
  useEffect(() => {
    if (!connected) {
      return;
    }

    const timer = setInterval(() => {
      const rig = rigRef.current;

      if (rig === undefined || pollingRef.current) {
        return;
      }

      pollingRef.current = true;

      void readTelemetry(generationRef.current, rig).finally(() => {
        pollingRef.current = false;
      });
    }, POLL_MS);

    return () => {
      clearInterval(timer);
    };
  }, [connected, readTelemetry]);

  useEffect(() => {
    liveRef.current = true;

    return () => {
      /* Invalidate whatever is in flight, then release what this hook owns. */
      liveRef.current = false;
      generationRef.current += 1;
      pendingRef.current = undefined;

      const rig = rigRef.current;
      const hamlib = moduleRef.current;

      rigRef.current = undefined;
      moduleRef.current = undefined;
      modulePromiseRef.current = undefined;
      capsRef.current = NO_CAPABILITIES;
      void rig?.close();
      void hamlib?.dispose();
    };
  }, []);

  const connect = useCallback(async (
    modelId: number,
    baudRate: number | undefined,
    granted?: SerialPort,
  ): Promise<void> => {
    const attempt = generationRef.current + 1;

    generationRef.current = attempt;
    pendingRef.current = attempt;
    setConnecting(true);
    setError(undefined);

    let opened: Rig | undefined;

    try {
      /* Every await below is a boundary: the attempt re-checks that it still
       * owns the operation, and gives back what it opened when it does not. */
      const hamlib = await loadModule();

      if (!owns(attempt)) {
        await abandonModule(attempt, hamlib);
        return;
      }

      moduleRef.current = hamlib;

      log({ api: 'native', call: granted === undefined ? 'requestPort()' : 'port: <granted>' });
      const port = granted ?? await hamlib.requestPort();

      if (!owns(attempt)) {
        return;
      }

      log({
        api: 'native',
        call: `open({ modelId: ${modelId}${baudRate === undefined ? '' : `, baudRate: ${baudRate}`} })`,
      });
      const rig = await hamlib.open(
        baudRate === undefined ? { modelId, port } : { modelId, port, baudRate },
      );

      if (!owns(attempt)) {
        await rig.close();
        return;
      }

      /* Ownership publishes before telemetry: the panel gets a live rig, its
       * capabilities and a Disconnect button before the first read, so a read
       * failure below can never look like a failed port acquisition. */
      opened = rig;
      rigRef.current = rig;

      const model = hamlib.models.find((candidate) => candidate.id === modelId);
      const next = model === undefined ? NO_CAPABILITIES : capabilitiesOf(model);

      capsRef.current = next;
      setCapabilities(next);
      setConnected(true);
    } catch (cause) {
      const failure = asError(cause, 'open');

      if (owns(attempt)) {
        setError(failure);
      }

      throw failure;
    } finally {
      if (pendingRef.current === attempt) {
        pendingRef.current = undefined;
      }

      if (owns(attempt)) {
        setConnecting(false);
      }
    }

    /* `connect()` has published the rig by now, so a failure here is a
     * telemetry error and nothing more. */
    if (opened !== undefined && owns(attempt)) {
      await readTelemetry(attempt, opened);
    }
  }, [abandonModule, loadModule, log, owns, readTelemetry]);

  const disconnect = useCallback(async (): Promise<void> => {
    /* Anything in flight stops owning the hook here; it releases what it
     * opened when it notices, and republishes nothing. */
    generationRef.current += 1;
    pendingRef.current = undefined;

    const rig = rigRef.current;

    rigRef.current = undefined;
    capsRef.current = NO_CAPABILITIES;
    setState(undefined);
    setCapabilities(NO_CAPABILITIES);
    setConnected(false);
    setConnecting(false);

    await rig?.close();
  }, []);

  const write = useCallback(async <T,>(
    label: string,
    run: (rig: Rig, attempt: number) => Promise<T>,
  ): Promise<void> => {
    const rig = rigRef.current;
    const attempt = generationRef.current;

    if (rig === undefined) {
      const failure = new HamlibError('the rig is not connected', {
        code: 'RIG_CLOSED',
        operation: 'open',
      });

      if (liveRef.current) {
        setError(failure);
      }

      throw failure;
    }

    log({ api: 'native', call: label });

    const result = (actionTailRef.current ?? Promise.resolve()).then(() => {
      if (!owns(attempt, rig)) {
        throw new HamlibError('the rig is no longer connected', {
          code: 'RIG_CLOSED',
          operation: 'write',
        });
      }

      return run(rig, attempt);
    });

    /* A failed or cancelled action must not strand later commands. */
    actionTailRef.current = result.then(() => undefined, () => undefined);

    try {
      await result;
    } catch (cause) {
      /* The App discards the rejection, so a native failure has to reach
       * `error` before it is rethrown or the user never sees it. */
      const failure = asError(cause, 'write');

      if (owns(attempt, rig)) {
        setError(failure);
      }

      throw failure;
    }
  }, [log, owns]);

  return useMemo<Backend>(() => ({
    kind: 'native',
    connected,
    state,
    capabilities,
    connecting,
    error,
    connect,
    disconnect: async () => {
      log({ api: 'native', call: 'close()' });
      await disconnect();
    },
    setFrequency: (hz) => write(`setFrequency(${hz})`, (rig) => rig.setFrequency(hz)),
    setMode: (mode, passband) => write(
      `setMode('${mode}', ${passband ?? 0})`,
      async (rig) => {
        /* The 1:1 surface wants the width; the easy surface fills it in. */
        const width = passband ?? await rig.passbandNormal(mode);

        await rig.setMode(mode, width);
      },
    ),
    setPtt: (on) => write(`setPtt('${on ? 'on' : 'off'}')`, async (rig) => {
      await rig.setPtt(on ? 'on' : 'off');
    }),
    setPassband: (kind) => write(`setMode(mode, passband: '${kind}')`, async (rig) => {
      const { mode } = await rig.getMode();

      await rig.setMode(mode, await passbandWidth(rig, mode, kind));
    }),
    refresh: () => write(
      'getFrequency() + getMode()',
      (rig, attempt) => readTelemetry(attempt, rig),
    ),
  }), [connected, state, capabilities, connecting, error, connect, disconnect, write, readTelemetry, log]);
}
