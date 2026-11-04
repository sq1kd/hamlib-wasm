/**
 * One rig, driven through either API surface.
 *
 * The demo loads a single Hamlib module (`HamlibProvider`) and opens a single
 * `EasyRig` (`useEasyRig`).  What changes between the two modes is only which
 * calls drive the panel:
 *
 *  - `easy`: the rig's own methods, and `useRigState` polling through the
 *    library's `watch()` - one `refresh()`-style snapshot, the passband filled
 *    in from the model;
 *  - `native`: the same screen through `rig.raw`, the 1:1 `Rig` - explicit
 *    `getFrequency()`/`getMode()`/`getPtt()` reads polled by hand and an
 *    explicit passband on every `setMode()`.
 *
 * Every call is logged, so the log is the visible difference.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { HamlibError } from 'hamlib-wasm';
import type { EasyCapabilities, EasyRig, PttState, RigState, SerialPortLike } from 'hamlib-wasm';
import type { Rig } from 'hamlib-wasm/hamlib';
import { useEasyRig, useRigError, useRigState } from 'hamlib-wasm/react';

import type { PassbandKind } from './RigPanel';

export type Api = 'easy' | 'native';

export interface LogEntry {
  readonly api: Api;
  readonly call: string;
}

export type Log = (entry: LogEntry) => void;

/** How often a connected rig is re-read, in milliseconds. */
export const POLL_MS = 1000;

const NO_CAPABILITIES: EasyCapabilities = {
  getFrequency: false,
  setFrequency: false,
  getMode: false,
  setMode: false,
  getPtt: false,
  setPtt: false,
  levels: [],
};

const PTT_STATES: readonly PttState[] = ['off', 'on', 'on-mic', 'on-data'];

function asError(error: unknown, operation: string): HamlibError {
  return error instanceof HamlibError
    ? error
    : new HamlibError(error instanceof Error ? error.message : String(error), {
      code: 'TRANSPORT_FAILURE',
      operation,
      cause: error,
    });
}

/** Read what the model advertises through the 1:1 surface, and only that. */
async function readRaw(rig: EasyRig, api: Api, log: Log): Promise<RigState> {
  const raw = rig.raw;
  const next: RigState = {};

  if (rig.capabilities.getFrequency) {
    log({ api, call: 'getFrequency()' });
    next.frequency = await raw.getFrequency();
  }

  if (rig.capabilities.getMode) {
    log({ api, call: 'getMode()' });
    const { mode, passband } = await raw.getMode();

    next.mode = mode;
    next.passband = passband;
  }

  if (rig.capabilities.getPtt) {
    log({ api, call: 'getPtt()' });
    const ptt = await raw.getPtt();

    next.ptt = PTT_STATES.find((state) => state === ptt) ?? 'off';
  }

  return next;
}

/** Hamlib's own passband helper for the requested width. */
function passbandWidth(raw: Rig, mode: string, kind: PassbandKind): Promise<number> {
  switch (kind) {
    case 'narrow':
      return raw.passbandNarrow(mode);
    case 'wide':
      return raw.passbandWide(mode);
    default:
      return raw.passbandNormal(mode);
  }
}

export interface Backend {
  readonly rig: EasyRig | undefined;
  readonly state: RigState | undefined;
  readonly capabilities: EasyCapabilities;
  readonly connecting: boolean;
  readonly error: HamlibError | undefined;
  connect(modelId: number, baudRate?: number, port?: SerialPortLike): Promise<void>;
  disconnect(): Promise<void>;
  setFrequency(hz: number): void;
  setMode(mode: string): void;
  setPassband(kind: PassbandKind): void;
  setPtt(on: boolean): void;
}

export function useBackend(api: Api, log: Log): Backend {
  const { rig, connecting, error: connectError, connect, disconnect } = useEasyRig();

  /* easy: the library polls.  The demo shows meters, so it asks for levels. */
  const easyState = useRigState(api === 'easy' ? rig : undefined, {
    pollMs: POLL_MS,
    fields: ['frequency', 'mode', 'ptt', 'levels'],
  });
  const easyError = useRigError(rig);

  /* native: the app polls, and orders its own multi-call actions. */
  const [nativeState, setNativeState] = useState<RigState | undefined>(undefined);
  const [nativeError, setNativeError] = useState<HamlibError | undefined>(undefined);
  const tailRef = useRef<Promise<void>>(Promise.resolve());

  /** Queue one panel action so its calls cannot interleave with the next one's. */
  const enqueue = useCallback((label: string, run: (rig: EasyRig) => Promise<unknown>): void => {
    if (rig === undefined) {
      return;
    }

    log({ api, call: label });
    tailRef.current = tailRef.current
      .then(() => run(rig))
      .then(
        () => undefined,
        (cause: unknown) => { setNativeError(asError(cause, label)); },
      );
  }, [api, log, rig]);

  useEffect(() => {
    setNativeState(undefined);
    setNativeError(undefined);

    if (api !== 'native' || rig === undefined) {
      return;
    }

    let live = true;
    let busy = false;
    const poll = (): void => {
      if (busy) {
        return;
      }

      busy = true;
      /* Through the action queue: a poll never lands inside a two-call action. */
      tailRef.current = tailRef.current
        .then(() => readRaw(rig, api, log))
        .then(
          (next) => { if (live) { setNativeState(next); } },
          (cause: unknown) => { if (live) { setNativeError(asError(cause, 'refresh')); } },
        )
        .finally(() => { busy = false; });
    };

    poll();
    const timer = setInterval(poll, POLL_MS);

    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [api, rig, log]);

  const native = api === 'native';

  return {
    rig,
    state: native ? nativeState : easyState,
    capabilities: rig === undefined
      ? NO_CAPABILITIES
      : native ? { ...rig.capabilities, levels: [] } : rig.capabilities,
    connecting,
    error: connectError ?? (native ? nativeError : easyError),
    connect: async (modelId, baudRate, port) => {
      log({
        api,
        call: `open({ modelId: ${String(modelId)}${baudRate === undefined ? '' : `, baudRate: ${String(baudRate)}`} })`,
      });
      await connect({
        modelId,
        ...(baudRate === undefined ? {} : { baudRate }),
        ...(port === undefined ? {} : { port }),
      });

      if (!native) {
        log({ api, call: `useRigState(rig, { pollMs: ${String(POLL_MS)} })` });
      }
    },
    disconnect: async () => {
      log({ api, call: 'close()' });
      await disconnect();
    },
    setFrequency: native
      ? (hz) => { enqueue(`raw.setFrequency(${String(hz)})`, (r) => r.raw.setFrequency(hz)); }
      : (hz) => { log({ api, call: `setFrequency(${String(hz)})` }); void rig?.setFrequency(hz).catch(() => undefined); },
    setMode: native
      ? (mode) => {
        enqueue(`raw.setMode('${mode}', raw.passbandNormal('${mode}'))`, async (r) => {
          /* The 1:1 surface wants the width; the easy surface fills it in. */
          await r.raw.setMode(mode, await r.raw.passbandNormal(mode));
        });
      }
      : (mode) => { log({ api, call: `setMode('${mode}')` }); void rig?.setMode(mode).catch(() => undefined); },
    setPassband: native
      ? (kind) => {
        enqueue(`raw.getMode() + raw.setMode(mode, ${kind} width)`, async (r) => {
          const { mode } = await r.raw.getMode();

          await r.raw.setMode(mode, await passbandWidth(r.raw, mode, kind));
        });
      }
      : (kind) => { log({ api, call: `setPassband('${kind}')` }); void rig?.setPassband(kind).catch(() => undefined); },
    setPtt: native
      ? (on) => { enqueue(`raw.setPtt('${on ? 'on' : 'off'}')`, (r) => r.raw.setPtt(on ? 'on' : 'off')); }
      : (on) => { log({ api, call: `setPtt(${String(on)})` }); void rig?.setPtt(on).catch(() => undefined); },
  };
}
