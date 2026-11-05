/**
 * The stubbed package boundary the hook unit tests run against.
 *
 * `vi.mock` replaces `hamlib-wasm`'s built entry point with this module, so the
 * real `hamlib-wasm/react` hooks run against a `Hamlib` whose every promise
 * this file hands out.  That is what the browser specs cannot express: they
 * drive one rig over one emulated port, so they can cancel an attempt but not
 * interleave two and choose which one settles last.
 *
 * Only the surface the hooks touch is implemented; the casts in `createHamlib`
 * say so out loud, and anything else the real interfaces carry is absent.
 */
import type { Hamlib, Rig, OpenRigOptions, RigModel, RigState, WatchOptions } from 'hamlib-wasm';

/** The `HamlibError` the hooks construct and test with. */
export class HamlibError extends Error {
  readonly code: string;
  readonly operation: string;

  constructor(
    message: string,
    options: { code: string; operation: string; cause?: unknown },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'HamlibError';
    this.code = options.code;
    this.operation = options.operation;
  }
}

/** The one model the stub catalogue carries. */
export const MODEL: RigModel = {
  id: 1,
  manufacturer: 'Kenwood',
  model: 'TS-480',
  backendVersion: 'stub',
  status: 0,
  serialRateMin: 4800,
  serialRateMax: 115200,
  serialDataBits: 8,
  serialStopBits: 1,
  serialParity: 'none',
  serialHandshake: 'none',
  support: 'verified',
  capabilities: new Set(['getFrequency', 'setFrequency', 'getMode', 'setMode', 'getPtt', 'setPtt']),
  canGetFrequency: true,
  canSetFrequency: true,
  canGetMode: true,
  canSetMode: true,
  canGetPtt: true,
  canSetPtt: true,
};

type StubEvent = 'state' | 'error';

/** The rig surface the hooks touch, plus the handles the tests drive. */
export interface StubRig {
  readonly model: RigModel;
  readonly state: RigState | undefined;
  readonly connected: boolean;
  readonly closed: boolean;
  on(event: StubEvent, listener: (value: unknown) => void): () => void;
  watch(options: WatchOptions): () => void;
  close(): Promise<void>;
  /** Publish a snapshot, the way a poll or a refresh would. */
  emitState(state: RigState): void;
  emitError(error: HamlibError): void;
}

/** One `open()` a hook started, and the handles that settle it. */
export interface StubAttempt {
  readonly options: OpenRigOptions;
  readonly promise: Promise<Rig>;
  /** Resolve with a prepared rig, or with a fresh one. */
  resolve(rig?: StubRig): void;
  reject(error: unknown): void;
}

/** A rig the tests hand to an attempt. */
export function newRig(): StubRig {
  const listeners = new Map<StubEvent, Set<(value: unknown) => void>>();
  let state: RigState | undefined;
  let connected = true;
  let closed = false;
  const rig: StubRig = {
    model: MODEL,
    get state(): RigState | undefined {
      return state;
    },
    get connected(): boolean {
      return connected;
    },
    get closed(): boolean {
      return closed;
    },
    on(event: StubEvent, listener: (value: unknown) => void): () => void {
      const set = listeners.get(event) ?? new Set<(value: unknown) => void>();

      set.add(listener);
      listeners.set(event, set);

      return () => {
        set.delete(listener);
      };
    },
    watch(_options: WatchOptions): () => void {
      return () => {};
    },
    async close(): Promise<void> {
      closed = true;
      connected = false;
    },
    emitState(next: RigState): void {
      state = next;

      for (const listener of listeners.get('state') ?? []) {
        listener(next);
      }
    },
    emitError(error: HamlibError): void {
      for (const listener of listeners.get('error') ?? []) {
        listener(error);
      }
    },
  };

  stub.rigs.push(rig);
  return rig;
}

export const stub = {
  /** Every attempt, in the order the hooks started them. */
  attempts: [] as StubAttempt[],
  /** Every rig the tests created, in creation order. */
  rigs: [] as StubRig[],
  /** How often a provider disposed its instance. */
  disposed: 0,
  reset(): void {
    stub.attempts.length = 0;
    stub.rigs.length = 0;
    stub.disposed = 0;
  },
};

/** The fake the mocked entry point exposes as `createHamlib`. */
export async function createHamlib(): Promise<Hamlib> {
  const instance = {
    version: 'Hamlib stub',
    models: [MODEL],
    requestPort(): Promise<never> {
      /* The hooks never request a port; the caller's connect passes one. */
      return Promise.reject(new Error('the hook tests never request a port'));
    },
    open(options: OpenRigOptions): Promise<Rig> {
      const deferred = Promise.withResolvers<Rig>();

      stub.attempts.push({
        options,
        promise: deferred.promise,
        resolve(rig?: StubRig): void {
          deferred.resolve((rig ?? newRig()) as unknown as Rig);
        },
        reject(error: unknown): void {
          deferred.reject(error);
        },
      });

      return deferred.promise;
    },
    async dispose(): Promise<void> {
      stub.disposed += 1;
    },
  };

  return instance as unknown as Hamlib;
}
