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
 * Either way the panel polls and writes as on the landing page
 * (`../radio/polling.ts`), and every call is logged, so the log is the
 * visible difference.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type { PassbandSelector, RigCapabilities, Rig, RigMode, RigState, SerialPortLike } from 'hamlib-wasm';
import type { RawRig } from 'hamlib-wasm/raw';
import { useRig, useRigError, useRigState } from 'hamlib-wasm/react';

import { failureMessage } from '../radio/errors';
import { NO_CAPABILITIES } from '../radio/format';
import { metered, POLL_MS, TELEMETRY, writeAndRead } from '../radio/polling';

export type Api = 'rig' | 'raw';

export interface LogEntry {
  readonly api: Api;
  readonly call: string;
}

export type Log = (entry: LogEntry) => void;

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
function passbandWidth(raw: RawRig, mode: RigMode, kind: PassbandSelector): Promise<number> {
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
  /** What the panel says about the last failure. */
  readonly error: string | undefined;
  connect(modelId: number, baudRate?: number, port?: SerialPortLike): Promise<void>;
  disconnect(): Promise<void>;
  setFrequency(hz: number): void;
  setMode(mode: RigMode): void;
  setPassband(kind: PassbandSelector): void;
  setPtt(on: boolean): void;
}

export function useBackend(api: Api, log: Log): Backend {
  const { rig, connecting, error: connectError, connect, disconnect } = useRig();

  /* rig: the library polls; both registrations publish into the one
   * snapshot each hook returns. */
  const rigState = useRigState(api === 'rig' ? rig : undefined, {
    pollMs: POLL_MS.telemetry,
    fields: [...TELEMETRY],
  });

  useRigState(api === 'rig' && rig !== undefined && metered(rig.capabilities) ? rig : undefined, {
    pollMs: POLL_MS.meter,
    fields: ['levels'],
  });
  const rigError = useRigError(rig);

  /* raw: the app polls, and orders its own multi-call actions. */
  const [rawState, setRawState] = useState<RigState | undefined>(undefined);
  const [rawError, setRawError] = useState<unknown>(undefined);
  const tailRef = useRef<Promise<void>>(Promise.resolve());

  /** Queue one panel action, then its read-back, so their calls cannot interleave with the next one's. */
  const enqueue = useCallback((label: string, run: (rig: Rig) => Promise<unknown>): void => {
    if (rig === undefined) {
      return;
    }

    log({ api, call: label });
    tailRef.current = tailRef.current
      .then(async () => {
        await run(rig);
        setRawState(await readRaw(rig, api, log));
      })
      .then(
        () => undefined,
        (cause: unknown) => { setRawError(cause); },
      );
  }, [api, log, rig]);

  /** A write through the rig, then its read-back. */
  const write = useCallback((label: string, run: (rig: Rig) => Promise<unknown>): void => {
    if (rig === undefined) {
      return;
    }

    log({ api, call: label });
    log({ api, call: 'refresh()' });
    /* A failure reaches the panel through useRigError. */
    void writeAndRead(rig, run).catch(() => undefined);
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
          (cause: unknown) => { if (live) { setRawError(cause); } },
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
  const failure: unknown = connectError ?? (isRaw ? rawError : rigError);

  return {
    rig,
    state: isRaw ? rawState : rigState,
    capabilities: rig === undefined
      ? NO_CAPABILITIES
      : isRaw ? { ...rig.capabilities, levels: [] } : rig.capabilities,
    connecting,
    error: failure === undefined ? undefined : failureMessage(failure),
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
      : (hz) => { write(`setFrequency(${String(hz)})`, (r) => r.setFrequency(hz)); },
    setMode: isRaw
      ? (mode) => {
        enqueue(`raw.setMode('${mode}', raw.passbandNormal('${mode}'))`, async (r) => {
          /* The raw surface wants the width; Rig fills it in. */
          await r.raw.setMode(mode, await r.raw.passbandNormal(mode));
        });
      }
      : (mode) => { write(`setMode('${mode}')`, (r) => r.setMode(mode)); },
    setPassband: isRaw
      ? (kind) => {
        enqueue(`raw.getMode() + raw.setMode(mode, ${kind} width)`, async (r) => {
          const { mode } = await r.raw.getMode();

          await r.raw.setMode(mode, await passbandWidth(r.raw, mode, kind));
        });
      }
      : (kind) => { write(`setPassband('${kind}')`, (r) => r.setPassband(kind)); },
    setPtt: isRaw
      ? (on) => { enqueue(`raw.setPtt('${on ? 'on' : 'off'}')`, (r) => r.raw.setPtt(on ? 'on' : 'off')); }
      : (on) => { write(`setPtt(${String(on)})`, (r) => r.setPtt(on)); },
  };
}
