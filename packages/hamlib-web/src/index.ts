/**
 * hamlib-web - Hamlib CAT control in the browser over Web Serial.
 *
 * The package wraps a WebAssembly build of Hamlib whose serial transport
 * talks to the Web Serial API.  The pinned release is described by
 * `packages/hamlib-web/hamlib.config.yaml`, never by a literal here.  Radio
 * backends are upstream Hamlib code and
 * are unmodified; only the common port layer is replaced.
 *
 * Every operation is asynchronous and is serialized on one internal promise
 * chain, because the Wasm module runs on the main thread and Emscripten's
 * Asyncify can only have one suspended native call at a time.  Multiple
 * {@link Rig} objects are still supported: their calls are queued in order.
 *
 * This module never exposes C pointers, Hamlib structures or Wasm memory.
 */

import createNativeModule from './native/hamlib-web.mjs';
import type { MainModule } from './native/hamlib-web.mjs';

import {
  describeLineSettingsLimitation,
  findUnusableModel,
  findVerifiedModel,
} from './browser-support.js';
import type { BrowserSupport, DeclaredLineSettings } from './browser-support.js';
import { FLAG_GATED_OPERATIONS } from './native/generated/operations.js';
import type {
  GeneratedPublicOperations,
  NativeOperations,
} from './native/generated/operations.js';
import { GeneratedRigMethods } from './native/generated/methods/index.js';

export {
  UNUSABLE_MODELS,
  VERIFIED_MODELS,
  describeLineSettingsLimitation,
} from './browser-support.js';
export type {
  BrowserSupport,
  UnusableModel,
  VerifiedModel,
} from './browser-support.js';
export type { RigConfparam } from './native/confparams.js';

type NativeModule = MainModule;

type NativeModelList = ReturnType<NativeModule['listModels']>;
type NativeModel = NonNullable<ReturnType<NativeModelList['get']>>;

/** Hamlib's RIG_OK. */
const RIG_OK = 0;

/** Human readable text for Hamlib's `enum rig_errcode_e`. */
const HAMLIB_ERROR_MESSAGES: Readonly<Record<number, string>> = {
  0: 'no error',
  1: 'invalid parameter',
  2: 'invalid configuration',
  3: 'memory shortage',
  4: 'function not implemented',
  5: 'communication timed out',
  6: 'I/O error',
  7: 'internal Hamlib error',
  8: 'protocol error',
  9: 'command rejected by the rig',
  10: 'command performed, but argument truncated',
  11: 'function not available',
  12: 'VFO not targetable',
  13: 'error talking on the bus',
  14: 'collision on the bus',
  15: 'invalid pointer parameter',
  16: 'invalid VFO',
  17: 'argument out of domain',
  18: 'function deprecated',
  19: 'security error',
  20: 'rig not powered on',
  21: 'limit exceeded',
  22: 'access denied',
};

/** Stable error codes reported by {@link HamlibError}. */
export type HamlibErrorCode =
  /** `navigator.serial` is missing (not a Web Serial capable browser). */
  | 'WEB_SERIAL_UNAVAILABLE'
  /** The user dismissed the port chooser or blocked the port. */
  | 'PORT_PERMISSION_DENIED'
  /** Web Serial raised a DOM exception. */
  | 'TRANSPORT_FAILURE'
  /** Hamlib returned a negative error code. */
  | 'HAMLIB_ERROR'
  /** A bound was violated before reaching Wasm. */
  | 'INVALID_ARGUMENT'
  /** The selected model cannot perform the requested operation. */
  | 'UNSUPPORTED_OPERATION'
  /** The rig has been closed. */
  | 'RIG_CLOSED'
  /** The Hamlib instance has been disposed. */
  | 'DISPOSED';

export interface HamlibErrorOptions {
  /** Stable machine readable code. */
  code: HamlibErrorCode;
  /** Stable operation name, e.g. `"open"` or `"getFrequency"`. */
  operation: string;
  /** Underlying DOM exception or error, when there is one. */
  cause?: unknown;
  /** Negative Hamlib error code, when `code` is `"HAMLIB_ERROR"`. */
  hamlibCode?: number;
  /** Text of the Hamlib error code. */
  hamlibMessage?: string;
}

/**
 * Every failure reported by this package is a `HamlibError`.
 *
 * Transport context is preserved: Web Serial failures keep the DOM exception
 * as `cause`, and Hamlib failures carry `hamlibCode`/`hamlibMessage`.
 */
export class HamlibError extends Error {
  readonly code: HamlibErrorCode;
  readonly operation: string;
  readonly hamlibCode?: number;
  readonly hamlibMessage?: string;

  constructor(message: string, options: HamlibErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'HamlibError';
    this.code = options.code;
    this.operation = options.operation;
    this.hamlibCode = options.hamlibCode;
    this.hamlibMessage = options.hamlibMessage;
  }
}

/** What a rig model can do over the browser transport. */
export interface RigCapabilities {
  canGetFrequency: boolean;
  canSetFrequency: boolean;
  canGetMode: boolean;
  canSetMode: boolean;
  canGetPtt: boolean;
  canSetPtt: boolean;
}

/** A rig model supported over Web Serial, sorted by manufacturer then model. */
export interface RigModel extends RigCapabilities {
  /** Hamlib model id, pass this to {@link Hamlib.open}. */
  id: number;
  manufacturer: string;
  model: string;
  /** Upstream backend version string. */
  backendVersion: string;
  /** Hamlib driver status bit field (`RIG_STATUS_*`). */
  status: number;
  /** Lowest baud rate the backend advertises. */
  serialRateMin: number;
  /** Highest baud rate the backend advertises. */
  serialRateMax: number;
  /** Serial data bits the backend declares. */
  serialDataBits: number;
  /** Serial stop bits the backend declares. */
  serialStopBits: number;
  /** Serial parity the backend declares. */
  serialParity: SerialParity;
  /** Serial flow control the backend declares. */
  serialHandshake: SerialHandshake;
  /**
   * `"verified"` when a browser test in this package drives the model through
   * the Web Serial double; `"candidate"` when only Hamlib's
   * `RIG_PORT_SERIAL` classification backs it.
   *
   * This never claims hardware testing - see {@link VERIFIED_MODELS}.
   */
  support: BrowserSupport;
  /**
   * Names of the generated operations this model implements, from its
   * `rig_caps` function pointers.  Absent means the matching generated method
   * on {@link Rig} is refused with `UNSUPPORTED_OPERATION` before reaching Wasm.
   */
  readonly capabilities: readonly string[];
  /**
   * Why the browser build cannot drive the model, when it cannot.
   *
   * Set when the backend declares line settings Web Serial cannot express - an
   * open then fails with `-RIG_ECONF` before the port is touched - or when a
   * recorded reason applies, which may instead fail during the open.  Either
   * way it fails predictably rather than half working.
   */
  limitation?: string;
}

/**
 * A Hamlib mode name, e.g. `"USB"`, `"CW"`, `"FM"`.
 *
 * The accepted set evolves with upstream Hamlib, so this is a plain string:
 * every setter value is validated by Hamlib's own `rig_parse_mode()`.
 */
export type RigMode = string;

/** Serial parity a backend declares. */
export type SerialParity = 'none' | 'odd' | 'even' | 'mark' | 'space';

/** Serial flow control a backend declares. */
export type SerialHandshake = 'none' | 'xon-xoff' | 'hardware';

/** Mode and passband as reported by the rig. */
export interface RigModeState {
  mode: RigMode;
  /** Passband width in Hz. */
  passband: number;
}

/** Options for {@link createHamlib}. */
export interface HamlibOptions {
  /**
   * Resolve an Emscripten asset name (e.g. `hamlib-web.wasm`) to a URL.
   *
   * Defaults to resolving assets next to the installed module with
   * `new URL(..., import.meta.url)`, so bundlers need no hard coded path.
   */
  locateFile?: (file: string) => string | URL;
}

/** Options for {@link Hamlib.open}. */
export interface OpenRigOptions {
  /** Model id taken from {@link RigModel.id}. */
  modelId: number;
  /** Port returned by {@link Hamlib.requestPort}, or by `navigator.serial`. */
  port: SerialPort;
  /**
   * Baud rate.  When omitted, the model's advertised default (the highest
   * rate Hamlib supports for it) is used.
   */
  baudRate?: number;
}

/**
 * A connected rig.
 *
 * Every CAT operation is a generated method (see
 * `src/native/generated/methods`); this interface only adds the ownership
 * facts the generated surface cannot know: which model was opened, whether it
 * is still open, and how to release it.
 */
export interface Rig extends GeneratedPublicOperations {
  /** The model this rig was opened with. */
  readonly model: RigModel;
  /** `false` once {@link Rig.close} has completed. */
  readonly connected: boolean;
  /** Close the rig.  Idempotent; safe to call after a failure. */
  close(): Promise<void>;
}

/** A loaded Hamlib instance. */
export interface Hamlib {
  /** Hamlib version string. */
  readonly version: string;
  /** Every rig model reachable over Web Serial. */
  readonly models: readonly RigModel[];
  /** Ask the user for a serial port.  Requires a user gesture. */
  requestPort(options?: SerialPortRequestOptions): Promise<SerialPort>;
  /** Open a rig on a previously granted port. */
  open(options: OpenRigOptions): Promise<Rig>;
  /**
   * Close every open rig, unregister every port and reject further work.
   * Idempotent.
   */
  dispose(): Promise<void>;
}

/** Shape shared by every native failure result. */
interface NativeResult {
  code: number;
  error: unknown;
}

function hamlibError(result: NativeResult, operation: string): HamlibError {
  const transport = typeof result.error === 'string' ? result.error : '';
  /* Hamlib reports failures as negative codes (-RIG_EIO); the message table is
   * keyed by the bare value. */
  const code = Math.abs(result.code);
  const description = HAMLIB_ERROR_MESSAGES[code] ?? `unknown Hamlib error ${result.code}`;
  const message = transport
    ? `${operation} failed: ${description} (${transport})`
    : `${operation} failed: ${description}`;

  return new HamlibError(message, {
    code: 'HAMLIB_ERROR',
    operation,
    hamlibCode: result.code,
    hamlibMessage: description,
  });
}

function transportError(cause: unknown, operation: string): HamlibError {
  if (cause instanceof Error && cause.name === 'NotFoundError') {
    return new HamlibError('no serial port was selected', {
      code: 'PORT_PERMISSION_DENIED',
      operation,
      cause,
    });
  }

  const detail = cause instanceof Error ? cause.message : String(cause);

  return new HamlibError(`${operation} failed: ${detail}`, {
    code: 'TRANSPORT_FAILURE',
    operation,
    cause,
  });
}

/* ------------------------------------------------------------------ */
/* serialization                                                      */
/* ------------------------------------------------------------------ */

/**
 * One promise chain per Hamlib instance.
 *
 * Emscripten's Asyncify unwinds the C stack of the single in-flight native
 * call, so native calls must never overlap.  Queueing them also guarantees a
 * call never starts while another one is suspended.
 */
class Serializer {
  #tail: Promise<unknown> = Promise.resolve();
  #closed = false;

  /** Queue work for a live instance. */
  enqueue<T>(operation: string, work: () => T | Promise<T>): Promise<T> {
    if (this.#closed) {
      return Promise.reject(
        new HamlibError('Hamlib instance has been disposed', {
          code: 'DISPOSED',
          operation,
        }),
      );
    }

    return this.#chain(work);
  }

  /** Queue cleanup work, which stays possible after disposal. */
  drain<T>(work: () => T | Promise<T>): Promise<T> {
    return this.#chain(work);
  }

  close(): void {
    this.#closed = true;
  }

  #chain<T>(work: () => T | Promise<T>): Promise<T> {
    /* Run regardless of whether the previous operation failed. */
    const result = this.#tail.then(work, work);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/* ------------------------------------------------------------------ */
/* rig                                                                */
/* ------------------------------------------------------------------ */

/** What a rig handle needs from the Hamlib instance that owns it. */
interface RigContext {
  readonly native: NativeModule;
  readonly queue: Serializer;
  forget(rig: RigHandle): void;
}

class RigHandle extends GeneratedRigMethods implements Rig {
  readonly #context: RigContext;
  readonly #path: string;
  readonly #model: RigModel;

  #handle: number;
  #closed = false;

  constructor(
    context: RigContext,
    path: string,
    model: RigModel,
    handle: number,
  ) {
    super();
    this.#context = context;
    this.#path = path;
    this.#model = model;
    this.#handle = handle;
  }

  get model(): RigModel {
    return this.#model;
  }

  get connected(): boolean {
    return !this.#closed;
  }

  /* --- plumbing the generated method classes call --------------------- */

  protected native(): NativeOperations {
    return this.#context.native;
  }

  protected handle(): number {
    return this.#handle;
  }

  protected serialized<T>(operation: string, work: () => Promise<T>): Promise<T> {
    return this.#call(operation, work);
  }

  protected available(operation: string): void {
    this.#requireCapability(
      this.#model.capabilities.includes(operation),
      operation,
      `use ${operation}`,
    );
  }

  protected failed(result: { code: number; error: unknown }, operation: string): Error {
    return hamlibError(result, operation);
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }

    this.#closed = true;
    this.#context.forget(this);

    /* Cleanup must run even when the instance is already disposed; the native
     * side releases the port even when rig_close reports an error. */
    try {
      await this.#context.queue.drain(async () => {
        const result = await this.#context.native.closeRig(this.#handle);
        this.#handle = 0;

        if (result.code !== RIG_OK) {
          throw hamlibError(result, 'close');
        }
      });
    } catch (error) {
      if (error instanceof HamlibError) {
        throw error;
      }

      throw new HamlibError(
        error instanceof Error ? error.message : String(error),
        { code: 'TRANSPORT_FAILURE', operation: 'close', cause: error },
      );
    }
  }

  get path(): string {
    return this.#path;
  }

  /**
   * Run one native call on the shared chain.
   *
   * Every bound native function is awaited: with Asyncify a call returns a
   * promise whenever it suspended, and a plain value when it did not.
   */
  #call<T>(operation: string, work: () => Promise<T>): Promise<T> {
    if (this.#closed) {
      return Promise.reject(
        new HamlibError('rig is closed', { code: 'RIG_CLOSED', operation }),
      );
    }

    return this.#context.queue.enqueue<T>(operation, () => {
      if (this.#closed) {
        throw new HamlibError('rig is closed', { code: 'RIG_CLOSED', operation });
      }

      return work();
    });
  }

  #requireCapability(allowed: boolean, operation: string, what: string): void {
    if (allowed) {
      return;
    }

    throw new HamlibError(
      `${this.#model.manufacturer} ${this.#model.model} cannot ${what}`,
      { code: 'UNSUPPORTED_OPERATION', operation },
    );
  }
}

/* ------------------------------------------------------------------ */
/* hamlib instance                                                    */
/* ------------------------------------------------------------------ */

/** The JavaScript side of the serial registry inside the Wasm module. */
interface SerialRegistry {
  storePort(port: SerialPort): number;
  isSerialSupported(): boolean;
}

function assertSerialPort(value: unknown, operation: string): asserts value is SerialPort {
  const port = value as Partial<SerialPort> | null | undefined;

  if (
    !port
    || typeof port.open !== 'function'
    || typeof port.close !== 'function'
    || typeof port.setSignals !== 'function'
    || typeof port.getSignals !== 'function'
    || typeof port.getInfo !== 'function'
  ) {
    throw new HamlibError('port must be a Web Serial SerialPort', {
      code: 'INVALID_ARGUMENT',
      operation,
    });
  }
}

function assertBaudRate(baudRate: number, model: RigModel): void {
  if (!Number.isInteger(baudRate) || baudRate <= 0) {
    throw new HamlibError(`baudRate must be a positive integer, got ${baudRate}`, {
      code: 'INVALID_ARGUMENT',
      operation: 'open',
    });
  }

  /* Some backends leave the advertised range open; only enforce a range that
   * is actually usable. */
  if (
    model.serialRateMin > 0
    && model.serialRateMax >= model.serialRateMin
    && (baudRate < model.serialRateMin || baudRate > model.serialRateMax)
  ) {
    throw new HamlibError(
      `baudRate ${baudRate} is outside the ${model.serialRateMin}-${model.serialRateMax} `
      + `range supported by ${model.manufacturer} ${model.model}`,
      { code: 'INVALID_ARGUMENT', operation: 'open' },
    );
  }
}

const SERIAL_PARITIES: readonly SerialParity[] = ['none', 'odd', 'even', 'mark', 'space'];
const SERIAL_HANDSHAKES: readonly SerialHandshake[] = ['none', 'xon-xoff', 'hardware'];

function toParity(value: unknown): SerialParity {
  const text = String(value);
  return SERIAL_PARITIES.find((parity) => parity === text) ?? 'none';
}

function toHandshake(value: unknown): SerialHandshake {
  const text = String(value);
  return SERIAL_HANDSHAKES.find((handshake) => handshake === text) ?? 'none';
}

/**
 * Work out how far a model is supported here, and why it is not when it is not.
 *
 * The line settings come from the backend's own capabilities, so a model that
 * declares something Web Serial cannot express is labelled before the caller
 * wastes a user gesture on it.
 */
function classifyModel(
  manufacturer: string,
  model: string,
  settings: DeclaredLineSettings,
): { support: BrowserSupport; limitation?: string } {
  if (findVerifiedModel(manufacturer, model)) {
    return { support: 'verified' };
  }

  const unusable = findUnusableModel(manufacturer, model);

  if (unusable) {
    return { support: 'candidate', limitation: unusable.reason };
  }

  const limitation = describeLineSettingsLimitation(settings);

  return limitation ? { support: 'candidate', limitation } : { support: 'candidate' };
}

/**
 * The generated operations a model implements.  `rig_caps` describes all but
 * the flag-gated bespoke ones: a backend that drives push-to-talk over the
 * serial RTS/DTR line declares no `get_ptt`/`set_ptt` function pointer, so the
 * catalogue entry carries that capability itself.
 */
function collectCapabilities(model: NativeModel, native: NativeModule): string[] {
  const capabilities = Array.from(native.capabilities(model.id));

  for (const [operation, flag] of FLAG_GATED_OPERATIONS) {
    if (model[flag]) {
      capabilities.push(operation);
    }
  }

  return capabilities;
}

function collectModels(list: NativeModelList, native: NativeModule): RigModel[] {
  const models: RigModel[] = [];

  try {
    for (let index = 0; index < list.size(); index++) {
      const model: NativeModel | undefined = list.get(index);

      if (!model) {
        continue;
      }

      const manufacturer = String(model.manufacturer);
      const name = String(model.model);
      const settings = {
        serialDataBits: model.serialDataBits,
        serialStopBits: model.serialStopBits,
        serialParity: toParity(model.serialParity),
        serialHandshake: toHandshake(model.serialHandshake),
      };
      const { support, limitation } = classifyModel(manufacturer, name, settings);

      models.push({
        id: model.id,
        manufacturer,
        model: name,
        backendVersion: String(model.backendVersion),
        status: model.status,
        serialRateMin: model.serialRateMin,
        serialRateMax: model.serialRateMax,
        serialDataBits: settings.serialDataBits,
        serialStopBits: settings.serialStopBits,
        serialParity: settings.serialParity,
        serialHandshake: settings.serialHandshake,
        support,
        ...(limitation === undefined ? {} : { limitation }),
        capabilities: collectCapabilities(model, native),
        canGetFrequency: model.canGetFrequency,
        canSetFrequency: model.canSetFrequency,
        canGetMode: model.canGetMode,
        canSetMode: model.canSetMode,
        canGetPtt: model.canGetPtt,
        canSetPtt: model.canSetPtt,
      });
    }
  } finally {
    /* The Embind vector owns Wasm memory. */
    list.delete();
  }

  return models;
}

class HamlibInstance implements Hamlib, RigContext {
  readonly #native: NativeModule;
  readonly #registry: SerialRegistry;
  readonly #models: RigModel[];
  readonly #modelsById: Map<number, RigModel>;
  readonly #version: string;
  readonly #rigs = new Set<RigHandle>();
  readonly #paths = new Set<string>();

  readonly queue = new Serializer();

  #portCounter = 0;
  #disposed = false;
  #disposePromise?: Promise<void>;

  private constructor(
    native: NativeModule,
    registry: SerialRegistry,
    models: RigModel[],
    version: string,
  ) {
    this.#native = native;
    this.#registry = registry;
    this.#models = models;
    this.#modelsById = new Map(models.map((model) => [model.id, model]));
    this.#version = version;
  }

  static async create(options: HamlibOptions): Promise<HamlibInstance> {
    const locate = options.locateFile
      ?? ((file: string) => new URL(`./native/${file}`, import.meta.url));

    const native = await createNativeModule({
      locateFile: (file: string) => String(locate(file)),
    });

    const registry = native.HamlibWs as SerialRegistry;

    if (typeof registry?.storePort !== 'function') {
      throw new HamlibError(
        'the WebAssembly module did not expose its serial registry',
        { code: 'TRANSPORT_FAILURE', operation: 'createHamlib' },
      );
    }

    /* Every bound native call is awaited: Asyncify returns a promise when the
     * call suspended and a plain value when it did not. */
    const initialization = await native.initialize();

    if (initialization.code !== RIG_OK) {
      throw hamlibError(initialization, 'initialize');
    }

    const models = collectModels(await native.listModels(), native);

    return new HamlibInstance(native, registry, models, await native.version());
  }

  get native(): NativeModule {
    return this.#native;
  }

  get version(): string {
    return this.#version;
  }

  get models(): readonly RigModel[] {
    return this.#models;
  }

  forget(rig: RigHandle): void {
    this.#rigs.delete(rig);
  }

  async requestPort(options?: SerialPortRequestOptions): Promise<SerialPort> {
    this.#assertLive('requestPort');

    const serial = this.#serial();

    if (!serial) {
      throw new HamlibError('Web Serial is not available in this browser', {
        code: 'WEB_SERIAL_UNAVAILABLE',
        operation: 'requestPort',
      });
    }

    try {
      return await serial.requestPort(options);
    } catch (error) {
      throw transportError(error, 'requestPort');
    }
  }

  async open(options: OpenRigOptions): Promise<Rig> {
    this.#assertLive('open');

    const { modelId, port, baudRate } = options;
    const serial = this.#serial();

    if (!serial) {
      throw new HamlibError('Web Serial is not available in this browser', {
        code: 'WEB_SERIAL_UNAVAILABLE',
        operation: 'open',
      });
    }

    const model = this.#modelsById.get(modelId);

    if (!model) {
      throw new HamlibError(
        `unknown rig model id ${String(modelId)}; use an id from hamlib.models`,
        { code: 'INVALID_ARGUMENT', operation: 'open' },
      );
    }

    if (baudRate !== undefined) {
      assertBaudRate(baudRate, model);
    }

    assertSerialPort(port, 'open');

    const path = `webserial/${++this.#portCounter}`;
    const token = this.#registry.storePort(port);

    if (token <= 0) {
      throw new HamlibError('the selected port could not be registered', {
        code: 'TRANSPORT_FAILURE',
        operation: 'open',
      });
    }

    /* Track the path before queueing so dispose() can always see and release
     * an accepted open, even when disposal races with it. */
    this.#paths.add(path);

    try {
      const rig = await this.queue.enqueue<RigHandle>('open', async () => {
        const registered = await this.#native.registerPort(path, token);

        if (registered.code !== RIG_OK) {
          throw hamlibError(registered, 'open');
        }

        const opened = await this.#native.openRig(modelId, path, baudRate ?? 0);

        if (opened.code !== RIG_OK) {
          throw hamlibError(opened, 'open');
        }

        /* Register inside the queued work: dispose() drains the chain before
         * it snapshots the live rigs, so this rig is always reachable. */
        const rig = new RigHandle(this, path, model, opened.handle);
        this.#rigs.add(rig);
        return rig;
      });

      if (this.#disposed) {
        /* Disposal was accepted while this open waited in the queue.  Hand
         * the rig over closed instead of letting an open survive it. */
        await rig.close();
        throw new HamlibError('Hamlib instance has been disposed', {
          code: 'DISPOSED',
          operation: 'open',
        });
      }

      return rig;
    } catch (error) {
      /* Opening failed: the logical path must not stay registered.  The
       * original failure is the one the caller needs. */
      try {
        await this.#releasePath(path);
      } catch {
        /* dispose() reports leftover registrations. */
      }

      throw error;
    }
  }

  dispose(): Promise<void> {
    this.#disposePromise ??= this.#dispose();
    return this.#disposePromise;
  }

  async #dispose(): Promise<void> {
    this.#disposed = true;
    this.queue.close();

    const failures: unknown[] = [];

    /* Every accepted open runs on the shared chain.  A barrier here waits for
     * them, so the snapshot below covers every rig and port they created. */
    await this.queue.drain(() => {});

    for (const rig of [...this.#rigs]) {
      try {
        await rig.close();
      } catch (error) {
        failures.push(error);
      }
    }

    for (const path of [...this.#paths]) {
      try {
        await this.#releasePath(path);
      } catch (error) {
        failures.push(error);
      }
    }

    if (failures.length > 0) {
      throw failures[0];
    }
  }

  /** Unregister one logical path; the native handle is already closed. */
  async #releasePath(path: string): Promise<void> {
    await this.queue.drain(async () => {
      const result = await this.#native.unregisterPort(path);

      if (result.code !== RIG_OK) {
        throw hamlibError(result, 'dispose');
      }

      this.#paths.delete(path);
    });
  }

  #serial(): Serial | undefined {
    if (typeof navigator === 'undefined') { return undefined; }

    return navigator.serial;
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
 * const hamlib = await createHamlib();
 * const port = await hamlib.requestPort();
 * const rig = await hamlib.open({ modelId, port });
 * ```
 */
export async function createHamlib(options: HamlibOptions = {}): Promise<Hamlib> {
  return HamlibInstance.create(options);
}
