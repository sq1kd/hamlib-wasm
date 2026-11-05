// SPDX-License-Identifier: MIT

/**
 * hamlib-wasm - the default, TypeScript-shaped entry point.
 *
 * This is the surface an application should reach for first: one rig object,
 * a state snapshot, events, and booleans instead of Hamlib's enums.  It is a
 * thin façade over `hamlib-wasm/raw`, which keeps a method per upstream
 * Hamlib call for anything this entry does not cover (see {@link Rig.raw}).
 *
 * What this layer adds, concretely:
 *
 *  - `refresh()` composes the reads a UI always wants (frequency, mode,
 *    passband, PTT and the levels the instance was configured for) into one
 *    awaited snapshot, and remembers it as {@link Rig.state}.
 *  - `setMode(mode)` fills in the model's normal passband through Hamlib's own
 *    `passband_normal`, so a caller does not have to know its width.
 *  - `setPtt(true)` and {@link PttState} replace the string vocabulary.
 *  - `on()`/`watch()` give a UI an event stream without polling by hand; the
 *    calls still serialize on the module's single queue.  A `watch()` declares
 *    which fields it needs, so a meter poll never drags the frequency along.
 *  - {@link Rig.capabilities} answers "can this model do X" as booleans,
 *    derived from the same `rig_caps` matrix the catalogue exposes.
 *
 * It composes; it never fakes.  A write does not invent state (Hamlib's own
 * cache decides what a following read reports), and a read the model cannot
 * perform still fails with the native `UNSUPPORTED_OPERATION` error.
 */

import { HamlibError, createRawHamlib } from './raw.js';
import type {
  DetectBaudRateOptions,
  RawHamlib,
  RawHamlibOptions,
  PortRequest,
  RawRig,
  RigMode,
  RigModeState,
  RigModel,
  SerialPortLike,
} from './raw.js';
import type { CompoundHost } from './native/seam.js';

export {
  UNUSABLE_MODELS,
  VERIFIED_MODELS,
  describeLineSettingsLimitation,
  HamlibError,
  webSerialTransport,
} from './raw.js';
export type {
  BrowserSupport,
  DetectBaudRateOptions,
  HamlibErrorCode,
  PortFilter,
  PortRequest,
  RigModelCapabilities,
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
} from './raw.js';

/** Push-to-talk states Hamlib reports and accepts. */
export type PttState = 'off' | 'on' | 'on-mic' | 'on-data';

const PTT_STATES: readonly PttState[] = ['off', 'on', 'on-mic', 'on-data'];

/** One of Hamlib's own passband helpers, selected by name. */
export type PassbandSelector = 'normal' | 'narrow' | 'wide';

/**
 * The rig levels this entry can read.
 *
 * These are Hamlib's own level names, not a translation of them: a read is
 * `rig_get_level` after `rig_parse_level`.  `RFPOWER` is the setpoint,
 * `RFPOWER_METER` the measured forward power.
 *
 * A level is only ever read when the instance was configured for it (see
 * {@link HamlibOptions.levels}) and the model advertises it, so a page that
 * shows no meters pays no CAT traffic for them.
 */
export type LevelName = 'STRENGTH' | 'SWR' | 'ALC' | 'RFPOWER' | 'RFPOWER_METER';

const LEVEL_NAMES: readonly LevelName[] = ['STRENGTH', 'SWR', 'ALC', 'RFPOWER', 'RFPOWER_METER'];

/** The telemetry a {@link Rig.watch} registration can read. */
export type RigField = 'frequency' | 'mode' | 'ptt' | 'levels';

const RIG_FIELDS: readonly RigField[] = ['frequency', 'mode', 'ptt', 'levels'];

/** What a watch registration reads when it names no fields. */
const DEFAULT_WATCH_FIELDS: readonly RigField[] = ['frequency', 'mode', 'ptt'];

/**
 * Consecutive failed reads after which a level is dropped for the session.
 *
 * One failure can be a transient, so the second one disables it; the cost of
 * retrying forever is the model's port timeout on every poll.
 */
const LEVEL_FAILURE_LIMIT = 2;

/** Narrow a Hamlib PTT string to the public union. */
function toPttState(value: string): PttState {
  return PTT_STATES.find((state) => state === value) ?? 'off';
}

/**
 * A snapshot of what the rig reported, not of what was asked of it.
 *
 * Every field is optional because a model may implement only part of the
 * telemetry surface: `refresh()` reads exactly the getters the model
 * advertises and omits the rest rather than inventing a value.  `mode` and
 * `passband` always appear together or not at all.
 *
 * {@link Rig.state} and the `state` event only ever carry a snapshot from
 * completed reads: a field whose read failed keeps the value from the previous
 * successful read, and no partial snapshot replaces the whole state.
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
  /**
   * The levels this instance is configured for and the model advertises,
   * merged across reads.  Absent until one of them has been read.
   */
  levels?: Partial<Record<LevelName, number>>;
}

/** What a model can do, as booleans a UI can test. */
export interface RigOperationCapabilities {
  getFrequency: boolean;
  setFrequency: boolean;
  getMode: boolean;
  setMode: boolean;
  getPtt: boolean;
  setPtt: boolean;
}

/** {@link RigOperationCapabilities} plus the levels this rig will read. */
export interface RigCapabilities extends RigOperationCapabilities {
  /**
   * Configured levels this model advertises, in configuration order.
   *
   * Empty when `createHamlib()` was given no `levels`, and possibly shorter than
   * the configured list when the model implements only some of them.
   */
  levels: readonly LevelName[];
}

/** The events an {@link Rig} emits. */
export interface RigEvents {
  /** A completed read, merged into the remembered snapshot. */
  state: RigState;
  frequency: number;
  mode: RigModeState;
  ptt: PttState;
  /** The levels one read produced; only the levels it actually read. */
  levels: Partial<Record<LevelName, number>>;
  /** A call that failed; the same error is thrown to its caller. */
  error: HamlibError;
}

type Listener<T> = (value: T) => void;

/**
 * Minimal typed emitter: no dependency, no wildcard, no replay.
 *
 * `emit` iterates a snapshot of the current listeners, so a listener that
 * unsubscribes another one does not disturb delivery of the event already on
 * its way.  Whether a *later* event is delivered is the publisher's decision
 * (see `RigHandle#publish`), not the emitter's.
 */
class Emitter<Events> {
  readonly #listeners = new Map<keyof Events, Set<Listener<never>>>();

  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {
    const listeners = this.#listeners.get(event) ?? new Set<Listener<never>>();

    listeners.add(listener as Listener<never>);
    this.#listeners.set(event, listeners);

    return () => {
      listeners.delete(listener as Listener<never>);
    };
  }

  emit<K extends keyof Events>(event: K, value: Events[K]): void {
    const listeners = [...(this.#listeners.get(event) ?? [])];

    for (const listener of listeners) {
      (listener as Listener<Events[K]>)(value);
    }
  }
}

/** Options for {@link createHamlib}. */
export interface HamlibOptions extends RawHamlibOptions {
  /**
   * Levels this instance may read, in the order they should be reported.
   *
   * Default: none - `refresh()` and `watch()` then issue no level reads at
   * all.  A level named here is still only read when the model advertises it;
   * see {@link RigCapabilities.levels}.
   */
  levels?: readonly LevelName[];
}

/** Options for {@link Hamlib.open}. */
export interface OpenRigOptions {
  /** Model id taken from {@link Hamlib.models}. */
  modelId: number;
  /**
   * Baud rate.  When omitted, the model's advertised default (the highest rate
   * Hamlib supports for it) is used, and the open verifies that the rig answers
   * at it; see {@link RawRig.baudRate} and {@link Hamlib.detectBaudRate} for a
   * rig whose rate is not known.
   */
  baudRate?: number;
  /**
   * An already granted port.  When omitted, {@link Hamlib.requestPort} runs
   * first, so this must be called from a user gesture.
   */
  port?: SerialPortLike;
}

/** Options for {@link Rig.watch}. */
export interface WatchOptions {
  /** Poll period in milliseconds. */
  intervalMs: number;
  /**
   * Fields this registration reads, each tick.
   *
   * Default: `['frequency', 'mode', 'ptt']`.  Only the fields named here are
   * read, so a registration that wants an S-meter alone issues one command per
   * tick, not the whole telemetry set.  Registrations with different intervals
   * run on separate timers.
   */
  fields?: readonly RigField[];
  /**
   * Levels to read; implies adding `'levels'` to `fields`.  Default: every
   * level the instance is configured for.
   */
  levels?: readonly LevelName[];
}

/**
 * A connected rig, with a state snapshot and events.
 *
 * Every method is one compound operation on the module's single call queue: a
 * multi-call method like `setMode()` or `refresh()` occupies one queue slot, so
 * nothing - a poll, a raw call, a call on another rig - can run between its
 * steps.  Order is preserved, not raced.
 */
export interface Rig {
  /** The model this rig was opened with. */
  readonly model: RigModel;
  /**
   * The baud rate this rig was opened at; see {@link RawRig.baudRate}.
   *
   * Worth keeping: passing it back to {@link Hamlib.open} skips both the
   * guess and a {@link Hamlib.detectBaudRate} scan on the next connect.
   */
  readonly baudRate: number;
  /** What this model can do, as booleans, and the levels this rig will read. */
  readonly capabilities: RigCapabilities;
  /** `false` once `close()` has been called, or the underlying rig closed. */
  readonly connected: boolean;
  /**
   * The last merged snapshot a completed read published, if any.  A failed
   * read leaves the fields it could not read at their previous values.
   */
  readonly state: RigState | undefined;
  /**
   * The underlying raw rig, for the operations this entry does not cover
   * (split, memory, antenna, clock, …).  Its methods are gated exactly as
   * `hamlib-wasm/raw` documents.
   */
  readonly raw: RawRig;

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
   * Read one level as configured for this instance.
   *
   * Throws `UNSUPPORTED_OPERATION` for a level the model does not advertise
   * and `INVALID_ARGUMENT` for one the instance was not configured for, so a
   * typo fails loudly instead of costing a CAT round trip.
   */
  level(name: LevelName): Promise<number>;
  /**
   * Read the telemetry the model advertises - frequency, mode with passband,
   * PTT when the model can, and every configured level it advertises - as one
   * compound operation, and remember it as {@link Rig.state}.  Fields the
   * model cannot read are omitted, never invented; a read that fails throws
   * and leaves the previous snapshot in place.
   */
  refresh(): Promise<RigState>;
  /** Subscribe to one event; the returned function unsubscribes. */
  on<K extends keyof RigEvents>(event: K, listener: Listener<RigEvents[K]>): () => void;
  /**
   * Poll the fields named in `options` while the returned function has not
   * been called.  Registrations compose: each interval runs its own timer,
   * removing one leaves the others polling, and removing the last stops the
   * scheduler.  A tick that arrives while that interval's previous poll is
   * still in flight is skipped, so a slow rig cannot build a queue of reads.
   *
   * A watch tick is best effort: a field that fails reports an `error` event
   * and leaves the rest of the snapshot untouched.  Use {@link refresh} when
   * all-or-nothing matters.
   */
  watch(options: WatchOptions): () => void;
  /**
   * Stop polling synchronously, then close the rig.  Idempotent; no snapshot
   * or event is published once it has been called.
   */
  close(): Promise<void>;
}

/** A loaded Hamlib instance, with the stateful rig on top. */
export interface Hamlib {
  /** Hamlib version string. */
  readonly version: string;
  /** Every rig model reachable over a serial transport, sorted by manufacturer then model. */
  readonly models: readonly RigModel[];
  /** Ask the caller-visible source for a serial port.  Requires a user gesture in the browser. */
  requestPort(options?: PortRequest): Promise<SerialPortLike>;
  /** Open a rig, optionally on an already granted port. */
  open(options: OpenRigOptions): Promise<Rig>;
  /**
   * Find the baud rate a rig answers at, before opening it.
   *
   * The same search as {@link RawHamlib.detectBaudRate}: the rates the model
   * declares are tried in turn and the first one the rig replies at is
   * returned, port closed.  Hand the result to {@link Hamlib.open}, or keep
   * it - `rig.baudRate` reports the rate a live rig was opened at, and
   * reconnecting with a known rate skips the scan.
   *
   * ```ts
   * const port = await hamlib.requestPort();
   * const baudRate = await hamlib.detectBaudRate({ modelId, port });
   * const rig = await hamlib.open({ modelId, port, baudRate });
   * ```
   *
   * Rejects with `RIG_UNRESPONSIVE` when no rate answered.
   */
  detectBaudRate(options: DetectBaudRateOptions): Promise<number>;
  /** Close every open rig and reject further work.  Idempotent. */
  dispose(): Promise<void>;
}

/**
 * Which of the operations {@link Rig} uses a model implements.
 *
 * Exported because a caller driving `hamlib-wasm/raw` directly still wants
 * the same booleans: the catalogue's `capabilities` is the raw set of generated
 * operation names, and this is the one interpretation of it this layer
 * makes.
 */
export function capabilitiesOf(model: RigModel): RigOperationCapabilities {
  return {
    getFrequency: model.capabilities.has('getFrequency'),
    setFrequency: model.capabilities.has('setFrequency'),
    getMode: model.capabilities.has('getMode'),
    setMode: model.capabilities.has('setMode'),
    getPtt: model.capabilities.has('getPtt'),
    setPtt: model.capabilities.has('setPtt'),
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
  readonly fields: ReadonlySet<RigField>;
  readonly levels: readonly LevelName[];
}

/** The timer one distinct interval drives. */
interface PollGroup {
  readonly timer: ReturnType<typeof setInterval>;
  polling: boolean;
}

/** Merge a partial read into the remembered snapshot. */
function mergeState(previous: RigState | undefined, next: RigState): RigState {
  const merged: RigState = { ...previous, ...next };

  if (previous?.levels !== undefined || next.levels !== undefined) {
    merged.levels = { ...previous?.levels, ...next.levels };
  }

  return merged;
}

/** `RawRigHandle` also implements the compound seam (`src/native/seam.ts`). */
type CompoundRig = RawRig & CompoundHost;

class RigHandle implements Rig {
  readonly #rig: CompoundRig;
  readonly #events = new Emitter<RigEvents>();
  readonly #operations: RigOperationCapabilities;
  readonly #configuredLevels: readonly LevelName[];
  readonly #advertisedLevels: readonly LevelName[];
  readonly #onClose: (rig: RigHandle) => void;
  readonly #subscriptions = new Set<PollSubscription>();
  readonly #groups = new Map<number, PollGroup>();
  /**
   * Levels whose reads keep failing, and the consecutive failure count.
   *
   * `has_get_level` describes what a backend declares, not what it answers: a
   * model can advertise a meter whose read the backend cannot complete, and
   * every attempt then costs the port timeout.  After two consecutive failures
   * the level is dropped for the session, so a broken meter cannot starve the
   * rest of the telemetry; reopening the rig re-probes it.
   */
  readonly #levelFailures = new Map<LevelName, number>();

  #state: RigState | undefined;
  #closed = false;

  constructor(
    rig: RawRig,
    configuredLevels: readonly LevelName[],
    advertisedLevels: readonly LevelName[],
    onClose: (rig: RigHandle) => void,
  ) {
    this.#rig = rig as CompoundRig;
    this.#operations = capabilitiesOf(rig.model);
    this.#configuredLevels = configuredLevels;
    this.#advertisedLevels = advertisedLevels;
    this.#onClose = onClose;
  }

  get model(): RigModel {
    return this.#rig.model;
  }

  get baudRate(): number {
    return this.#rig.baudRate;
  }

  get capabilities(): RigCapabilities {
    return { ...this.#operations, levels: this.#advertisedLevels };
  }

  get connected(): boolean {
    return !this.#closed && this.#rig.connected;
  }

  get state(): RigState | undefined {
    return this.#state;
  }

  get raw(): RawRig {
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

  async level(name: LevelName): Promise<number> {
    this.#requireLevel(name);

    return this.#call('level', () => this.#rig.runCompound('level', (operations) => (
      operations.getLevel(name)
    )));
  }

  async refresh(): Promise<RigState> {
    return this.#call('refresh', () => this.#rig.runCompound('refresh', async (operations) => {
      const state: RigState = {};

      /* Read only what the model advertises; never invent a field. */
      if (this.#operations.getFrequency) {
        state.frequency = await operations.getFrequency();
      }

      if (this.#operations.getMode) {
        const mode = await operations.getMode();

        state.mode = mode.mode;
        state.passband = mode.passband;
      }

      if (this.#operations.getPtt) {
        state.ptt = toPttState(await operations.getPtt());
      }

      if (this.#advertisedLevels.length > 0) {
        const levels: Partial<Record<LevelName, number>> = {};
        const failures: HamlibError[] = [];

        /* A meter is decoration: one level a backend advertises but answers
         * slowly or refuses must not fail the core snapshot.  The core fields
         * above stay all-or-nothing; level failures are reported as `error`
         * events after the snapshot is published. */
        for (const name of this.#advertisedLevels) {
          if (this.#unreadable(name)) {
            continue;
          }

          try {
            levels[name] = await operations.getLevel(name);
            this.#levelFailures.delete(name);
          } catch (error) {
            failures.push(this.#recordLevelFailure(name, error));
          }
        }

        if (Object.keys(levels).length > 0) {
          state.levels = levels;
        }

        this.#publish(state);

        for (const failure of failures) {
          if (this.#live()) {
            this.#events.emit('error', failure);
          }
        }

        return this.#state ?? state;
      }

      this.#publish(state);
      return this.#state ?? state;
    }));
  }

  on<K extends keyof RigEvents>(event: K, listener: Listener<RigEvents[K]>): () => void {
    return this.#events.on(event, listener);
  }

  watch(options: WatchOptions): () => void {
    if (!this.connected) {
      throw new HamlibError('rig is closed', { code: 'RIG_CLOSED', operation: 'watch' });
    }

    const { intervalMs } = options;

    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      throw new HamlibError(
        `watch interval must be a positive number of milliseconds, got ${String(intervalMs)}`,
        { code: 'INVALID_ARGUMENT', operation: 'watch' },
      );
    }

    const fields = new Set<RigField>(options.fields ?? DEFAULT_WATCH_FIELDS);

    for (const field of fields) {
      if (!RIG_FIELDS.includes(field)) {
        throw new HamlibError(
          `unknown watch field ${String(field)}; use one of ${RIG_FIELDS.join(', ')}`,
          { code: 'INVALID_ARGUMENT', operation: 'watch' },
        );
      }
    }

    /* Naming levels implies reading them. */
    const levels = options.levels === undefined
      ? [...this.#advertisedLevels]
      : [...options.levels];

    if (options.levels !== undefined) {
      fields.add('levels');
    }

    if (fields.has('levels') && levels.length === 0) {
      throw new HamlibError(
        'watch asked for levels, but this instance has none configured '
        + '(pass `levels` to createHamlib) or the model advertises none',
        { code: 'INVALID_ARGUMENT', operation: 'watch' },
      );
    }

    for (const name of levels) {
      this.#requireLevel(name);
    }

    const subscription: PollSubscription = {
      intervalMs,
      fields,
      levels: [...new Set(levels)],
    };

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
    this.#stopAll();
    this.#onClose(this);
  }

  /**
   * Publish a completed read, merged into the remembered snapshot.
   *
   * A read that started before `close()` (or before the raw rig was closed)
   * must not resurrect the wrapper: once closed, nothing is published.  A
   * listener may itself close the rig while we are dispatching, so that is
   * re-checked before every following event - the event already in flight
   * still reaches every listener that was registered for it.
   */
  #publish(partial: RigState): void {
    if (!this.#live()) {
      return;
    }

    const snapshot = mergeState(this.#state, partial);
    this.#state = snapshot;
    this.#events.emit('state', snapshot);

    if (partial.frequency !== undefined && this.#live()) {
      this.#events.emit('frequency', partial.frequency);
    }

    if (partial.mode !== undefined && partial.passband !== undefined && this.#live()) {
      this.#events.emit('mode', { mode: partial.mode, passband: partial.passband });
    }

    if (partial.ptt !== undefined && this.#live()) {
      this.#events.emit('ptt', partial.ptt);
    }

    if (partial.levels !== undefined && Object.keys(partial.levels).length > 0 && this.#live()) {
      this.#events.emit('levels', partial.levels);
    }
  }

  /** Whether this wrapper may still publish: not closed and the rig is live. */
  #live(): boolean {
    return !this.#closed && this.#rig.connected;
  }

  /**
   * Start a timer for every interval in use, stop timers nobody asked for.
   *
   * One timer per interval, not one for the smallest: a 250 ms meter poll must
   * not turn a 1 s frequency poll into four reads a second.
   */
  #configureScheduler(): void {
    if (this.#closed) {
      this.#stopAll();
      return;
    }

    const wanted = new Set<number>();

    for (const subscription of this.#subscriptions) {
      wanted.add(subscription.intervalMs);
    }

    for (const intervalMs of wanted) {
      if (this.#groups.has(intervalMs)) { continue; }

      const group: PollGroup = {
        timer: setInterval(() => {
          void this.#tick(intervalMs);
        }, intervalMs),
        polling: false,
      };

      this.#groups.set(intervalMs, group);

      /* The first registration at an interval polls straight away, as a fresh
       * watch() always has. */
      void this.#tick(intervalMs);
    }

    for (const intervalMs of [...this.#groups.keys()]) {
      if (!wanted.has(intervalMs)) {
        this.#stopGroup(intervalMs);
      }
    }
  }

  #stopGroup(intervalMs: number): void {
    const group = this.#groups.get(intervalMs);

    if (!group) { return; }

    clearInterval(group.timer);
    this.#groups.delete(intervalMs);
  }

  #stopAll(): void {
    for (const intervalMs of [...this.#groups.keys()]) {
      this.#stopGroup(intervalMs);
    }
  }

  /** One poll tick for one interval: read the union of the fields watched there. */
  async #tick(intervalMs: number): Promise<void> {
    const group = this.#groups.get(intervalMs);

    if (!group || group.polling) {
      return;
    }

    if (!this.connected) {
      /* The raw rig was closed behind the wrapper (or disposal ran): stop
       * rather than leave a scheduler retaining the handle forever. */
      this.#stopGroup(intervalMs);
      return;
    }

    const fields = new Set<RigField>();
    const levels = new Set<LevelName>();

    for (const subscription of this.#subscriptions) {
      if (subscription.intervalMs !== intervalMs) { continue; }

      for (const field of subscription.fields) {
        fields.add(field);
      }

      for (const name of subscription.levels) {
        levels.add(name);
      }
    }

    group.polling = true;

    try {
      const { partial, failures } = await this.#call('watch', () => (
        this.#rig.runCompound('watch', async (operations) => {
          const read: RigState = {};
          const errors: HamlibError[] = [];

          if (fields.has('frequency') && this.#operations.getFrequency) {
            try {
              read.frequency = await operations.getFrequency();
            } catch (error) {
              errors.push(asHamlibError(error, 'getFrequency'));
            }
          }

          if (fields.has('mode') && this.#operations.getMode) {
            try {
              const mode = await operations.getMode();

              read.mode = mode.mode;
              read.passband = mode.passband;
            } catch (error) {
              errors.push(asHamlibError(error, 'getMode'));
            }
          }

          if (fields.has('ptt') && this.#operations.getPtt) {
            try {
              read.ptt = toPttState(await operations.getPtt());
            } catch (error) {
              errors.push(asHamlibError(error, 'getPtt'));
            }
          }

          if (fields.has('levels') && levels.size > 0) {
            const values: Partial<Record<LevelName, number>> = {};

            for (const name of levels) {
              if (this.#unreadable(name)) {
                continue;
              }

              try {
                values[name] = await operations.getLevel(name);
                this.#levelFailures.delete(name);
              } catch (error) {
                errors.push(this.#recordLevelFailure(name, error));
              }
            }

            if (Object.keys(values).length > 0) {
              read.levels = values;
            }
          }

          return { partial: read, failures: errors };
        })
      ));

      this.#publish(partial);

      for (const failure of failures) {
        if (this.#live()) {
          this.#events.emit('error', failure);
        }
      }
    } catch {
      /* The compound itself failed; #call already emitted the error and the
       * timer must keep running. */
    } finally {
      const current = this.#groups.get(intervalMs);

      if (current) {
        current.polling = false;
      }
    }
  }

  /** Whether this level has been dropped after repeated failed reads. */
  #unreadable(name: LevelName): boolean {
    return (this.#levelFailures.get(name) ?? 0) >= LEVEL_FAILURE_LIMIT;
  }

  /**
   * Count one failed level read; report the underlying error, and one more
   * naming the level when it is dropped.
   */
  #recordLevelFailure(name: LevelName, error: unknown): HamlibError {
    const failure = asHamlibError(error, `getLevel(${name})`);
    const count = (this.#levelFailures.get(name) ?? 0) + 1;

    this.#levelFailures.set(name, count);

    if (count === LEVEL_FAILURE_LIMIT) {
      return new HamlibError(
        `${this.#rig.model.manufacturer} ${this.#rig.model.model} claims ${name} `
        + `but the read failed ${count} times (${failure.message}); `
        + 'polling it is disabled until the rig is reopened',
        { code: 'UNSUPPORTED_OPERATION', operation: 'getLevel', cause: failure },
      );
    }

    return failure;
  }

  /** Reject a level the instance is not configured for or the model lacks. */
  #requireLevel(name: LevelName): void {
    if (!LEVEL_NAMES.includes(name)) {
      throw new HamlibError(
        `unknown level ${String(name)}; use one of ${LEVEL_NAMES.join(', ')}`,
        { code: 'INVALID_ARGUMENT', operation: 'level' },
      );
    }

    if (this.#advertisedLevels.includes(name)) {
      return;
    }

    if (!this.#configuredLevels.includes(name)) {
      throw new HamlibError(
        `level ${name} is not configured; pass it to createHamlib({ levels: [...] })`,
        { code: 'INVALID_ARGUMENT', operation: 'level' },
      );
    }

    throw new HamlibError(
      `${this.#rig.model.manufacturer} ${this.#rig.model.model} does not report ${name}`,
      { code: 'UNSUPPORTED_OPERATION', operation: 'level' },
    );
  }

  async #call<T>(operation: string, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      const failure = asHamlibError(error, operation);

      /* A command that failed while the rig was being closed must not emit
       * after the close either; the rejection still reaches its caller. */
      if (this.#live()) {
        this.#events.emit('error', failure);
      }

      throw failure;
    }
  }
}

class HamlibInstance implements Hamlib {
  readonly #hamlib: RawHamlib;
  readonly #levels: readonly LevelName[];
  readonly #rigs = new Set<RigHandle>();

  #disposed = false;
  #disposePromise: Promise<void> | undefined;

  private constructor(hamlib: RawHamlib, levels: readonly LevelName[]) {
    this.#hamlib = hamlib;
    this.#levels = levels;
  }

  static async create(options: HamlibOptions): Promise<HamlibInstance> {
    const { levels, ...hamlibOptions } = options;

    return new HamlibInstance(
      await createRawHamlib(hamlibOptions),
      normalizeLevels(levels),
    );
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

  async open(options: OpenRigOptions): Promise<Rig> {
    this.#assertLive('open');

    const port = options.port ?? await this.requestPort();

    this.#assertLive('open');

    const rig = await this.#hamlib.open({
      modelId: options.modelId,
      port,
      baudRate: options.baudRate,
    });
    let advertised: readonly LevelName[];

    try {
      advertised = await advertisedLevels(rig, this.#levels);
    } catch (error) {
      /* The capability probe is a native call; if it fails the rig has no
       * owner yet, so close it instead of leaking the port. */
      await rig.close().catch(() => {});
      throw error;
    }

    const handle = new RigHandle(rig, this.#levels, advertised, (handle) => {
      this.#rigs.delete(handle);
    });

    if (this.#disposed) {
      /* Disposal was accepted while this open waited: hand the rig over closed
       * instead of publishing a live wrapper. */
      await handle.close();
      throw new HamlibError('Hamlib instance has been disposed', {
        code: 'DISPOSED',
        operation: 'open',
      });
    }

    this.#rigs.add(handle);
    return handle;
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

/** Deduplicate and validate the configured level list. */
function normalizeLevels(levels: readonly LevelName[] | undefined): readonly LevelName[] {
  const wanted: LevelName[] = [];

  for (const name of levels ?? []) {
    if (!LEVEL_NAMES.includes(name)) {
      throw new HamlibError(
        `unknown level ${String(name)}; use one of ${LEVEL_NAMES.join(', ')}`,
        { code: 'INVALID_ARGUMENT', operation: 'createHamlib' },
      );
    }

    if (!wanted.includes(name)) {
      wanted.push(name);
    }
  }

  return wanted;
}

/**
 * Which configured levels this model advertises.
 *
 * `hasGetLevel` reads the model's level mask - no CAT traffic - so this costs
 * one pure call per configured level, once per open.
 */
async function advertisedLevels(
  rig: RawRig,
  configured: readonly LevelName[],
): Promise<readonly LevelName[]> {
  const advertised: LevelName[] = [];

  for (const name of configured) {
    if ((await rig.hasGetLevel(name)) !== 0) {
      advertised.push(name);
    }
  }

  return advertised;
}

/**
 * Load Hamlib and read its rig model catalogue.
 *
 * ```ts
 * const hamlib = await createHamlib({ levels: ['STRENGTH', 'SWR'] });
 * const model = hamlib.models.find((entry) => entry.model === 'TS-480');
 * const rig = await hamlib.open({ modelId: model.id });   // asks for the port
 * console.log(await rig.refresh());                        // 14074000 USB 2400
 * rig.watch({ intervalMs: 500, fields: ['levels'], levels: ['STRENGTH'] });
 * await rig.setFrequency(7_074_000);
 * await rig.setPtt(true);
 * await rig.close();
 * await hamlib.dispose();
 * ```
 *
 * One instance owns one Wasm module and one call queue; a second instance is a
 * second module with its own memory.
 */
export async function createHamlib(options: HamlibOptions = {}): Promise<Hamlib> {
  return HamlibInstance.create(options);
}
