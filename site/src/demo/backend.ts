/**
 * One rig, driven through either API surface.
 *
 * The demo loads a single Hamlib module (`HamlibProvider`) and opens a single
 * `Rig` (`useRig`).  What changes between the two modes is only which
 * calls drive the panel:
 *
 *  - `rig`: the rig's own methods, and `useRigState` polling through the
 *    library's `watch()` - one `refresh()`-style snapshot, the passband filled
 *    in from the model - with the S-meter on a second, faster registration;
 *  - `raw`: the same screen through `rig.raw`, the `RawRig` - explicit
 *    `getFrequency()`/`getMode()`/`getPtt()` reads polled by hand and an
 *    explicit passband on every `setMode()`.
 *
 * Every call is logged, so the log is the visible difference.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { HamlibError } from 'hamlib-wasm';
import type { RigCapabilities, Rig, RigMode, RigState, SerialPortLike } from 'hamlib-wasm';
import type { RawRig } from 'hamlib-wasm/raw';
import { useRig, useRigError, useRigState } from 'hamlib-wasm/react';

import { NO_CAPABILITIES, POLL_MS } from '../radio/format';
import type { PassbandKind } from '../radio/RadioPanel';

export type Api = 'rig' | 'raw';

export interface LogEntry {
  readonly api: Api;
  readonly call: string;
}

export type Log = (entry: LogEntry) => void;

function asError(error: unknown, operation: string): HamlibError {
  return error instanceof HamlibError
    ? error
    : new HamlibError(error instanceof Error ? error.message : String(error), {
      code: 'TRANSPORT_FAILURE',
      operation,
      cause: error,
    });
}

/** Read what the model advertises through the raw surface, and only that. */
async function readRaw(rig: Rig, api: Api, log: Log): Promise<RigState> {
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
    next.ptt = await raw.getPtt();
  }

  return next;
}

/** Hamlib's own passband helper for the requested width. */
function passbandWidth(raw: RawRig, mode: RigMode, kind: PassbandKind): Promise<number> {
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
  readonly rig: Rig | undefined;
  readonly state: RigState | undefined;
  readonly capabilities: RigCapabilities;
  readonly connecting: boolean;
  readonly error: HamlibError | undefined;
  connect(modelId: number, baudRate?: number, port?: SerialPortLike): Promise<void>;
  disconnect(): Promise<void>;
  setFrequency(hz: number): void;
  setMode(mode: RigMode): void;
  setPassband(kind: PassbandKind): void;
  setPtt(on: boolean): void;
}

export function useBackend(api: Api, log: Log): Backend {
  const { rig, connecting, error: connectError, connect, disconnect } = useRig();

  /* rig: the library polls - frequency, mode and PTT once a second, and the
   * S-meter on its own faster timer, so it moves while the slower reads wait.
   * Both registrations publish into the one snapshot each hook returns. */
  const rigState = useRigState(api === 'rig' ? rig : undefined, {
    pollMs: POLL_MS.telemetry,
    fields: ['frequency', 'mode', 'ptt'],
  });
  const metered = api === 'rig' && rig !== undefined && rig.capabilities.levels.length > 0;

  useRigState(metered ? rig : undefined, { pollMs: POLL_MS.meter, fields: ['levels'] });
  const rigError = useRigError(rig);

  /* raw: the app polls, and orders its own multi-call actions. */
  const [rawState, setRawState] = useState<RigState | undefined>(undefined);
  const [rawError, setRawError] = useState<HamlibError | undefined>(undefined);
  const tailRef = useRef<Promise<void>>(Promise.resolve());

  /** Queue one panel action so its calls cannot interleave with the next one's. */
  const enqueue = useCallback((label: string, run: (rig: Rig) => Promise<unknown>): void => {
    if (rig === undefined) {
      return;
    }

    log({ api, call: label });
    tailRef.current = tailRef.current
      .then(() => run(rig))
      .then(
        () => undefined,
        (cause: unknown) => { setRawError(asError(cause, label)); },
      );
  }, [api, log, rig]);

  useEffect(() => {
    setRawState(undefined);
    setRawError(undefined);

    if (api !== 'raw' || rig === undefined) {
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
          (next) => { if (live) { setRawState(next); } },
          (cause: unknown) => { if (live) { setRawError(asError(cause, 'refresh')); } },
        )
        .finally(() => { busy = false; });
    };

    poll();
    const timer = setInterval(poll, POLL_MS.telemetry);

    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [api, rig, log]);

  const isRaw = api === 'raw';

  return {
    rig,
    state: isRaw ? rawState : rigState,
    capabilities: rig === undefined
      ? NO_CAPABILITIES
      : isRaw ? { ...rig.capabilities, levels: [] } : rig.capabilities,
    connecting,
    error: connectError ?? (isRaw ? rawError : rigError),
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

      if (!isRaw) {
        log({ api, call: `useRigState(rig, { pollMs: ${String(POLL_MS.telemetry)} })` });
        log({ api, call: `useRigState(rig, { pollMs: ${String(POLL_MS.meter)}, fields: ['levels'] })` });
      }
    },
    disconnect: async () => {
      log({ api, call: 'close()' });
      await disconnect();
    },
    setFrequency: isRaw
      ? (hz) => { enqueue(`raw.setFrequency(${String(hz)})`, (r) => r.raw.setFrequency(hz)); }
      : (hz) => { log({ api, call: `setFrequency(${String(hz)})` }); void rig?.setFrequency(hz).catch(() => undefined); },
    setMode: isRaw
      ? (mode) => {
        enqueue(`raw.setMode('${mode}', raw.passbandNormal('${mode}'))`, async (r) => {
          /* The raw surface wants the width; Rig fills it in. */
          await r.raw.setMode(mode, await r.raw.passbandNormal(mode));
        });
      }
      : (mode) => { log({ api, call: `setMode('${mode}')` }); void rig?.setMode(mode).catch(() => undefined); },
    setPassband: isRaw
      ? (kind) => {
        enqueue(`raw.getMode() + raw.setMode(mode, ${kind} width)`, async (r) => {
          const { mode } = await r.raw.getMode();

          await r.raw.setMode(mode, await passbandWidth(r.raw, mode, kind));
        });
      }
      : (kind) => { log({ api, call: `setPassband('${kind}')` }); void rig?.setPassband(kind).catch(() => undefined); },
    setPtt: isRaw
      ? (on) => { enqueue(`raw.setPtt('${on ? 'on' : 'off'}')`, (r) => r.raw.setPtt(on ? 'on' : 'off')); }
      : (on) => { log({ api, call: `setPtt(${String(on)})` }); void rig?.setPtt(on).catch(() => undefined); },
  };
}
