/**
 * hamlib-wasm - the default, TypeScript-shaped entry point.
 *
 * This is the surface an application should reach for first: one rig object,
 * a state snapshot, events, and booleans instead of Hamlib's enums.  It is a
 * thin façade over `hamlib-wasm/hamlib`, which keeps a method per upstream
 * Hamlib call for anything this entry does not cover (see {@link EasyRig.raw}).
 *
 * What "easy" means here, concretely:
 *
 *  - `refresh()` composes the reads a UI always wants (frequency, mode,
 *    passband, and PTT when the model reports it) into one awaited snapshot,
 *    and remembers it as {@link EasyRig.state}.
 *  - `setMode(mode)` fills in the model's normal passband through Hamlib's own
 *    `passband_normal`, so a caller does not have to know its width.
 *  - `setPtt(true)` and {@link PttState} replace the string vocabulary.
 *  - `on()`/`watch()` give a UI an event stream without polling by hand; the
 *    calls still serialize on the module's single queue.
 *  - {@link EasyRig.capabilities} answers "can this model do X" as booleans,
 *    derived from the same `rig_caps` matrix the catalogue exposes.
 *
 * It composes; it never fakes.  A write does not invent state (Hamlib's own
 * cache decides what a following read reports), and a read the model cannot
 * perform still fails with the native `UNSUPPORTED_OPERATION` error.
 */

import { HamlibError, createHamlib } from './hamlib.js';
import type {
  DetectBaudRateOptions,
  Hamlib,
  HamlibOptions,
  PortRequest,
  Rig,
  RigMode,
  RigModeState,
  RigModel,
  SerialPortLike,
} from './hamlib.js';
import type { CompoundHost } from './native/seam.js';

export {
  UNUSABLE_MODELS,
  VERIFIED_MODELS,
  describeLineSettingsLimitation,
  HamlibError,
  webSerialTransport,
} from './hamlib.js';
export type {
  BrowserSupport,
  DetectBaudRateOptions,
  HamlibErrorCode,
  HamlibOptions,
  PortFilter,
  PortRequest,
  RigCapabilities,
  RigConfparam,
  RigMode,
  RigModeState,
  RigModel,
  SerialHandshake,
  SerialInputSignals,
  SerialLineSettings,
  SerialOutputSignals,
  SerialParity,
  SerialPortInfo,
  SerialPortLike,
  SerialTransport,
  UnusableModel,
  VerifiedModel,
} from './hamlib.js';

/** Push-to-talk states Hamlib reports and accepts. */
export type PttState = 'off' | 'on' | 'on-mic' | 'on-data';

const PTT_STATES: readonly PttState[] = ['off', 'on', 'on-mic', 'on-data'];

/**
 * One of Hamlib's own passband helpers, selected by name.
 *
 * `normal` is the width the model advertises for a mode; `narrow` and `wide`
 * are the backend's own narrower and wider choices.
 */
export type PassbandSelector = 'normal' | 'narrow' | 'wide';

/** Narrow a Hamlib PTT string to the public union. */
function toPttState(value: string): PttState {
  return PTT_STATES.find((state) => state === value) ?? 'off';
}

/**
 * A snapshot of what the rig reported, not of what was asked of it.
 *
 * Every field is optional because a model may implement only part of the easy
 * telemetry surface: `refresh()` reads exactly the getters the model
 * advertises and omits the rest rather than inventing a value.  `mode` and
 * `passband` always appear together or not at all.
 *
 * {@link EasyRig.state} and the `state` event only ever carry a snapshot from a
 * *completed* refresh: when a supported read fails, the previous successful
 * snapshot stays in place and no partial one is published.
 */
export interface RigState {
  /** Frequency in Hz; absent when the model cannot read frequency. */
  frequency?: number;
  /** Mode; absent (together with `passband`) when the model cannot read mode. */
  mode?: RigMode;
  /** Passband width in Hz; present exactly when `mode` is. */
  passband?: number;
  /** Present only when the model can read PTT. */
  ptt?: PttState;
}

/** The operations a model supports, as booleans a UI can test. */
export interface EasyCapabilities {
  getFrequency: boolean;
  setFrequency: boolean;
  getMode: boolean;
  setMode: boolean;
  getPtt: boolean;
  setPtt: boolean;
}

/** The events an {@link EasyRig} emits. */
export interface EasyRigEvents {
  /** A completed {@link EasyRig.refresh}. */
  state: RigState;
  frequency: number;
  mode: RigModeState;
  ptt: PttState;
  /** A call that failed; the same error is thrown to its caller. */
  error: HamlibError;
}

type Listener<T> = (value: T) => void;

/** Minimal typed emitter: no dependency, no wildcard, no replay. */
class Emitter<Events> {
  readonly #listeners = new Map<keyof Events, Set<Listener<never>>>();
  readonly #live: () => boolean;

  constructor(live: () => boolean) {
    this.#live = live;
  }

  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {
    const listeners = this.#listeners.get(event) ?? new Set<Listener<never>>();

    listeners.add(listener as Listener<never>);
    this.#listeners.set(event, listeners);

    return () => {
      listeners.delete(listener as Listener<never>);
    };
  }

  emit<K extends keyof Events>(event: K, value: Events[K]): void {
    for (const listener of this.#listeners.get(event) ?? []) {
      if (!this.#live()) {
        return;
      }

      (listener as Listener<Events[K]>)(value);
    }
  }
}

/** Options for {@link EasyHamlib.open}. */
export interface OpenEasyRigOptions {
  /** Model id taken from {@link EasyHamlib.models}. */
  modelId: number;
  /**
   * Baud rate.  When omitted, the model's advertised default (the highest rate
   * Hamlib supports for it) is used, and the open verifies that the rig answers
   * at it; see {@link Rig.baudRate} and {@link EasyHamlib.detectBaudRate} for a
   * rig whose rate is not known.
   */
  baudRate?: number;
  /**
   * An already granted port.  When omitted, {@link EasyHamlib.requestPort} runs
   * first, so this must be called from a user gesture.
   */
  port?: SerialPortLike;
}

/**
 * A connected rig, with a state snapshot and events.
 *
 * Every method is one compound operation on the module's single call queue: a
 * multi-call method like `setMode()` or `refresh()` occupies one queue slot, so
 * nothing - a poll, a raw call, a call on another rig - can run between its
 * steps.  Order is preserved, not raced.
 */
export interface EasyRig {
  /** The model this rig was opened with. */
  readonly model: RigModel;
  /**
   * The baud rate this rig was opened at; see {@link Rig.baudRate}.
   *
   * Worth keeping: passing it back to {@link EasyHamlib.open} skips both the
   * guess and a {@link EasyHamlib.detectBaudRate} scan on the next connect.
   */
  readonly baudRate: number;
  /** What this model can do, as booleans. */
  readonly capabilities: EasyCapabilities;
  /** `false` once `close()` has been called, or the underlying rig closed. */
  readonly connected: boolean;
  /**
   * The last snapshot a completed `refresh()` published, if any.  A failed
   * refresh leaves it unchanged.
   */
  readonly state: RigState | undefined;
  /**
   * The underlying 1:1 rig, for the operations this entry does not cover
   * (split, levels, memory, antenna, clock, …).  Its methods are gated exactly
   * as `hamlib-wasm/hamlib` documents.
   */
  readonly raw: Rig;

  /** Set the frequency in Hz. */
  setFrequency(hz: number): Promise<void>;
  /**
   * Set the mode, filling in the model's normal passband when `passband` is
   * omitted.  At that point `passband` is the value the call actually used.
   */
  setMode(mode: RigMode, passband?: number): Promise<void>;
  /**
   * Read the current mode, apply one of Hamlib's own passband helpers for it,
   * and write the mode and width back as one compound operation, so a mode
   * change issued afterwards cannot be undone by the older passband action.
   */
  setPassband(kind: PassbandSelector): Promise<void>;
  /** Set push-to-talk to on (`true`) or off (`false`). */
  setPtt(on: boolean): Promise<void>;
  /**
   * Read the telemetry the model advertises - frequency, mode with passband,
   * and PTT when the model can - as one compound operation, and remember it as
   * {@link EasyRig.state}.  Fields the model cannot read are omitted, never
   * invented; a read that fails throws and leaves the previous snapshot in
   * place.
   */
  refresh(): Promise<RigState>;
  /** Subscribe to one event; the returned function unsubscribes. */
  on<K extends keyof EasyRigEvents>(event: K, listener: Listener<EasyRigEvents[K]>): () => void;
  /**
   * Poll every `intervalMs` while the returned function has not been called.
   * Registrations compose: the smallest requested interval wins, removing one
   * leaves the others polling, and removing the last stops the scheduler.  A
   * tick that arrives while the previous poll is still in flight is skipped,
   * so a slow rig cannot build a queue of reads.
   */
  watch(intervalMs: number): () => void;
  /**
   * Stop polling synchronously, then close the rig.  Idempotent; no snapshot
   * or event is published once it has been called.
   */
  close(): Promise<void>;
}

/** A loaded Hamlib instance, with the easy rig on top. */
export interface EasyHamlib {
  /** Hamlib version string. */
  readonly version: string;
  /** Every rig model reachable over a serial transport, sorted by manufacturer then model. */
  readonly models: readonly RigModel[];
  /** Ask the caller-visible source for a serial port.  Requires a user gesture in the browser. */
  requestPort(options?: PortRequest): Promise<SerialPortLike>;
  /** Open a rig, optionally on an already granted port. */
  open(options: OpenEasyRigOptions): Promise<EasyRig>;
  /**
   * Find the baud rate a rig answers at, before opening it.
   *
   * The same search as {@link Hamlib.detectBaudRate}: the rates the model
   * declares are tried in turn and the first one the rig replies at is
   * returned, port closed.  Hand the result to {@link EasyHamlib.open}, or keep
   * it - `easyRig.baudRate` reports the rate a live rig was opened at, and
   * reconnecting with a known rate skips the scan.
   *
   * ```ts
   * const port = await easy.requestPort();
   * const baudRate = await easy.detectBaudRate({ modelId, port });
   * const rig = await easy.open({ modelId, port, baudRate });
   * ```
   *
   * Rejects with `RIG_UNRESPONSIVE` when no rate answered.
   */
  detectBaudRate(options: DetectBaudRateOptions): Promise<number>;
  /** Close every open rig and reject further work.  Idempotent. */
  dispose(): Promise<void>;
}

/**
 * Which of the operations {@link EasyRig} uses a model implements.
 *
 * Exported because a caller driving `hamlib-wasm/hamlib` directly still wants
 * the same booleans: the catalogue's `capabilities` is the raw list of
 * generated operation names, and this is the one interpretation of it the easy
 * layer makes.
 */
export function capabilitiesOf(model: RigModel): EasyCapabilities {
  const supported = new Set(model.capabilities);

  return {
    getFrequency: supported.has('getFrequency'),
    setFrequency: supported.has('setFrequency'),
    getMode: supported.has('getMode'),
    setMode: supported.has('setMode'),
    getPtt: supported.has('getPtt'),
    setPtt: supported.has('setPtt'),
  };
}

/** Wrap a thrown value as a `HamlibError`; the native layer always throws one. */
function asHamlibError(error: unknown, operation: string): HamlibError {
  if (error instanceof HamlibError) {
    return error;
  }

  return new HamlibError(
    error instanceof Error ? error.message : String(error),
    { code: 'TRANSPORT_FAILURE', operation, cause: error },
  );
}

/** One live polling registration; its identity is the unsubscribe handle. */
interface PollSubscription {
  readonly intervalMs: number;
}

/** `RigHandle` also implements the compound seam (`src/native/seam.ts`). */
type CompoundRig = Rig & CompoundHost;

class EasyRigHandle implements EasyRig {
  readonly #rig: CompoundRig;
  readonly #events = new Emitter<EasyRigEvents>(() => this.#live());
  readonly #capabilities: EasyCapabilities;
  readonly #onClose: (rig: EasyRigHandle) => void;
  readonly #subscriptions = new Set<PollSubscription>();

  #state: RigState | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #intervalMs = 0;
  #polling = false;
  #closed = false;

  constructor(rig: Rig, onClose: (rig: EasyRigHandle) => void) {
    this.#rig = rig as CompoundRig;
    this.#capabilities = capabilitiesOf(rig.model);
    this.#onClose = onClose;
  }

  get model(): RigModel {
    return this.#rig.model;
  }

  get baudRate(): number {
    return this.#rig.baudRate;
  }

  get capabilities(): EasyCapabilities {
    return this.#capabilities;
  }

  get connected(): boolean {
    return !this.#closed && this.#rig.connected;
  }

  get state(): RigState | undefined {
    return this.#state;
  }

  get raw(): Rig {
    return this.#rig;
  }

  async setFrequency(hz: number): Promise<void> {
    return this.#call('setFrequency', () => this.#rig.runCompound('setFrequency', async (operations) => {
      await operations.setFrequency(hz);
    }));
  }

  async setMode(mode: RigMode, passband?: number): Promise<void> {
    return this.#call('setMode', () => this.#rig.runCompound('setMode', async (operations) => {
      const width = passband ?? await operations.passbandNormal(mode);

      await operations.setMode(mode, width);
    }));
  }

  async setPtt(on: boolean): Promise<void> {
    return this.#call('setPtt', () => this.#rig.runCompound('setPtt', async (operations) => {
      await operations.setPtt(on ? 'on' : 'off');
    }));
  }

  async setPassband(kind: PassbandSelector): Promise<void> {
    return this.#call('setPassband', () => this.#rig.runCompound('setPassband', async (operations) => {
      /* The mode read, the width lookup and the write share this one queue
       * slot, so a later mode selection cannot land between them and be
       * overwritten by the older passband action. */
      const { mode } = await operations.getMode();
      const width = kind === 'narrow'
        ? await operations.passbandNarrow(mode)
        : kind === 'wide'
          ? await operations.passbandWide(mode)
          : await operations.passbandNormal(mode);

      await operations.setMode(mode, width);
    }));
  }

  async refresh(): Promise<RigState> {
    return this.#call('refresh', () => this.#rig.runCompound('refresh', async (operations) => {
      const state: RigState = {};

      /* Read only what the model advertises; never invent a field. */
      if (this.#capabilities.getFrequency) {
        state.frequency = await operations.getFrequency();
      }

      if (this.#capabilities.getMode) {
        const mode = await operations.getMode();

        state.mode = mode.mode;
        state.passband = mode.passband;
      }

      if (this.#capabilities.getPtt) {
        state.ptt = toPttState(await operations.getPtt());
      }

      this.#publish(state);
      return state;
    }));
  }

  on<K extends keyof EasyRigEvents>(event: K, listener: Listener<EasyRigEvents[K]>): () => void {
    return this.#events.on(event, listener);
  }

  watch(intervalMs: number): () => void {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      throw new HamlibError(
        `watch interval must be a positive number of milliseconds, got ${String(intervalMs)}`,
        { code: 'INVALID_ARGUMENT', operation: 'watch' },
      );
    }

    const subscription: PollSubscription = { intervalMs };

    this.#subscriptions.add(subscription);
    this.#configureScheduler();

    return () => {
      /* Removing only this registration, once: another consumer's watcher and
       * a repeated call of this function are both no-ops. */
      if (this.#subscriptions.delete(subscription)) {
        this.#configureScheduler();
      }
    };
  }

  async close(): Promise<void> {
    this.#shutdown();
    await this.#rig.close();
  }

  /** Stop polling and publication without touching the port (disposal path). */
  abandon(): void {
    this.#shutdown();
  }

  #shutdown(): void {
    this.#closed = true;
    this.#subscriptions.clear();
    this.#stopScheduler();
    this.#onClose(this);
  }

  /**
   * Publish a completed snapshot.
   *
   * A read that started before `close()` (or before the raw rig was closed)
   * must not resurrect the wrapper: once closed, nothing is published.  A
   * listener may itself close the rig while we are dispatching, so every
   * delivery re-checks - no event follows a close.
   */
  #publish(state: RigState): void {
    if (!this.#live()) {
      return;
    }

    this.#state = state;
    this.#events.emit('state', state);

    if (state.frequency !== undefined) {
      this.#events.emit('frequency', state.frequency);
    }

    if (state.mode !== undefined && state.passband !== undefined) {
      this.#events.emit('mode', { mode: state.mode, passband: state.passband });
    }

    if (state.ptt !== undefined) {
      this.#events.emit('ptt', state.ptt);
    }
  }

  /** Whether this wrapper may still publish: not closed and the rig is live. */
  #live(): boolean {
    return !this.#closed && this.#rig.connected;
  }

  /** Drive the one scheduler from the registrations currently held. */
  #configureScheduler(): void {
    if (this.#closed || !this.#rig.connected || this.#subscriptions.size === 0) {
      this.#stopScheduler();
      return;
    }

    let intervalMs = Number.POSITIVE_INFINITY;

    for (const subscription of this.#subscriptions) {
      intervalMs = Math.min(intervalMs, subscription.intervalMs);
    }

    if (this.#timer !== undefined && this.#intervalMs === intervalMs) {
      return;
    }

    const starting = this.#timer === undefined;

    this.#stopScheduler();
    this.#intervalMs = intervalMs;
    this.#timer = setInterval(() => {
      void this.#tick();
    }, intervalMs);

    /* The first registration polls straight away, as a fresh watch() did. */
    if (starting) {
      void this.#tick();
    }
  }

  #stopScheduler(): void {
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  /** One poll tick: skip when the previous refresh has not settled yet. */
  async #tick(): Promise<void> {
    if (this.#polling) {
      return;
    }

    if (this.#closed || !this.#rig.connected) {
      /* The raw rig was closed behind the wrapper (or disposal ran): stop
       * rather than leave a scheduler retaining the handle forever. */
      this.#stopScheduler();
      return;
    }

    this.#polling = true;

    try {
      await this.refresh();
    } catch {
      /* refresh() already emitted the error; the timer must keep running. */
    } finally {
      this.#polling = false;
    }
  }

  async #call<T>(operation: string, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      const failure = asHamlibError(error, operation);

      /* A command that failed while the rig was being closed must not emit
       * after the close either; the rejection still reaches its caller. */
      this.#events.emit('error', failure);

      throw failure;
    }
  }
}

class EasyHamlibInstance implements EasyHamlib {
  readonly #hamlib: Hamlib;
  readonly #rigs = new Set<EasyRigHandle>();

  #disposed = false;
  #disposePromise: Promise<void> | undefined;

  private constructor(hamlib: Hamlib) {
    this.#hamlib = hamlib;
  }

  static async create(options: HamlibOptions): Promise<EasyHamlibInstance> {
    return new EasyHamlibInstance(await createHamlib(options));
  }

  get version(): string {
    return this.#hamlib.version;
  }

  get models(): readonly RigModel[] {
    return this.#hamlib.models;
  }

  requestPort(options?: PortRequest): Promise<SerialPortLike> {
    this.#assertLive('requestPort');
    return this.#hamlib.requestPort(options);
  }

  detectBaudRate(options: DetectBaudRateOptions): Promise<number> {
    this.#assertLive('detectBaudRate');
    return this.#hamlib.detectBaudRate(options);
  }

  async open(options: OpenEasyRigOptions): Promise<EasyRig> {
    this.#assertLive('open');

    const port = options.port ?? await this.requestPort();

    this.#assertLive('open');

    const rig = await this.#hamlib.open({
      modelId: options.modelId,
      port,
      baudRate: options.baudRate,
    });
    const easy = new EasyRigHandle(rig, (handle) => {
      this.#rigs.delete(handle);
    });

    if (this.#disposed) {
      /* Disposal was accepted while this open waited: hand the rig over closed
       * instead of publishing a live wrapper. */
      await easy.close();
      throw new HamlibError('Hamlib instance has been disposed', {
        code: 'DISPOSED',
        operation: 'open',
      });
    }

    this.#rigs.add(easy);
    return easy;
  }

  dispose(): Promise<void> {
    this.#disposePromise ??= this.#dispose();
    return this.#disposePromise;
  }

  async #dispose(): Promise<void> {
    this.#disposed = true;

    /* Stop every scheduler and invalidate publication *before* delegating the
     * native cleanup, so nothing this layer owns can publish afterwards. */
    for (const rig of [...this.#rigs]) {
      rig.abandon();
    }

    this.#rigs.clear();
    await this.#hamlib.dispose();
  }

  #assertLive(operation: string): void {
    if (this.#disposed) {
      throw new HamlibError('Hamlib instance has been disposed', {
        code: 'DISPOSED',
        operation,
      });
    }
  }
}

/**
 * Load Hamlib and read its rig model catalogue.
 *
 * ```ts
 * const hamlib = await createEasy();
 * const model = hamlib.models.find((entry) => entry.model === 'TS-480');
 * const rig = await hamlib.open({ modelId: model.id });   // asks for the port
 * console.log(await rig.refresh());                        // 14074000 USB 2400
 * await rig.setFrequency(7_074_000);
 * await rig.setPtt(true);
 * await rig.close();
 * await hamlib.dispose();
 * ```
 *
 * One instance owns one Wasm module and one call queue; a second instance is a
 * second module with its own memory.
 */
export async function createEasy(options: HamlibOptions = {}): Promise<EasyHamlib> {
  return EasyHamlibInstance.create(options);
}
