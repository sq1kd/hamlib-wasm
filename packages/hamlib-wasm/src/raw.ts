// SPDX-License-Identifier: MIT

/**
 * hamlib-wasm/raw - Hamlib CAT control over a switchable serial transport.
 *
 * This is the low-level entry point: a method per upstream Hamlib call, named
 * after the call it binds.  It adds no convenience wrappers of its own.  The
 * package's default entry point is the stateful, TypeScript-shaped facade in
 * `src/index.ts`, which is built on top of this one.
 *
 * The package wraps a WebAssembly build of Hamlib whose serial transport
 * talks to whatever {@link SerialTransport} the caller passes: the browser's
 * Web Serial API by default (`src/web-serial.ts`), the `serialport` package
 * through `hamlib-wasm/node` (`src/node.ts`) wherever there is no browser.  The
 * pinned release is described by
 * `packages/hamlib-wasm/hamlib.config.yaml`, never by a literal here.  Radio
 * backends are upstream Hamlib code and
 * are unmodified; only the common port layer is replaced.
 *
 * Every operation is asynchronous and is serialized on one internal promise
 * chain, because the Wasm module runs on the main thread and Emscripten's
 * Asyncify can only have one suspended native call at a time.  Multiple
 * {@link RawRig} objects are still supported: their calls are queued in order.
 *
 * This module never exposes C pointers, Hamlib structures or Wasm memory.
 *
 * @packageDocumentation
 */

import createNativeModule from './native/hamlib-wasm.mjs';
import type { MainModule, RigModelInfo } from './native/hamlib-wasm.mjs';

import {
  describeLineSettingsLimitation,
  findUnusableModel,
  findVerifiedModel,
} from './browser-support.js';
import type { BrowserSupport, DeclaredLineSettings } from './browser-support.js';
import { confKeysPttLine, encodeConf } from './conf.js';
import type { RigConf } from './conf.js';
import { DiagnosticsRecorder, debugLevelValue } from './diagnostics.js';
import { drainVector } from './embind.js';
import type { DebugOptions, Diagnostics, DiagnosticsRig } from './diagnostics.js';
import {
  HamlibError,
  HAMLIB_ERROR_MESSAGES,
  asHamlibError,
  closedError,
  compoundError,
  disposedError,
  hungError,
} from './errors.js';
import { bytesToHex, formatUsbId, hexToBytes } from './hex.js';
import { selectTransport } from './transport-select.js';
import type {
  PortRequest,
  SerialPortInfo,
  SerialPortLike,
  SerialTransport,
} from './transport.js';
import { FLAG_GATED_OPERATIONS } from './native/generated/operations.js';
import type {
  GeneratedPublicOperations,
  NativeOperations,
} from './native/generated/operations.js';
import { GeneratedRigMethods } from './native/generated/methods/index.js';
import type { GeneratedCallResult } from './native/generated/methods/base.js';
import { bindCompoundHost } from './native/seam.js';
import type { CompoundOperations } from './native/seam.js';
import { operationCapabilities } from './catalogue.js';
import type { DetectBaudRateOptions, RigModel } from './catalogue.js';

export { HamlibError } from './errors.js';
export type { HamlibErrorCode, HamlibErrorOptions } from './errors.js';
export { webSerialTransport } from './web-serial.js';
export type {
  PortFilter,
  PortRequest,
  SerialInputSignals,
  SerialLineSettings,
  SerialOutputSignals,
  SerialPortInfo,
  SerialPortLike,
  SerialTransport,
} from './transport.js';

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
export type { RigConf } from './conf.js';
export {
  FUNCS,
  LEVELS,
  PARMS,
  POWER_STATUSES,
  PTT_STATES,
  RESET_KINDS,
  RIG_ERRCODES,
  RIG_MODES,
  RPTR_SHIFTS,
  SCAN_OPS,
  VFOS,
  VFO_OPS,
} from './native/generated/names.js';
import { RIG_ERRCODES, SERIAL_HANDSHAKES, SERIAL_PARITIES } from './native/generated/names.js';
export type {
  Func,
  Level,
  Parm,
  PowerStatus,
  PttState,
  ResetKind,
  RigErrcode,
  RptrShift,
  ScanOp,
  Vfo,
  VfoOp,
} from './native/generated/names.js';
export type {
  DebugLevel,
  DebugOptions,
  Diagnostics,
  DiagnosticsRig,
  ErrorEntry,
  LogEntry,
  TraceEntry,
} from './diagnostics.js';
export type {
  DetectBaudRateOptions,
  RigMode,
  RigModeState,
  RigModel,
  RigModelCapabilities,
  SerialHandshake,
  SerialParity,
} from './catalogue.js';

type NativeModule = MainModule;
type NativeModel = RigModelInfo;

/** The one asset the pinned Emscripten build loads. */
const WASM_ASSET_NAME = 'hamlib-wasm.wasm';

/**
 * The wasm binary sitting next to the installed module.
 *
 * Deliberately the static `new URL('./...', import.meta.url)` shape: that is
 * the form a bundler rewrites into the asset it emits, and the form a plain
 * browser resolves relative to this module's own URL.  A *template* literal
 * (`./native/${file}`) is read by Vite as a glob, which it resolves to a module
 * import of every file in the directory - the wasm among them, as a JavaScript
 * stub - leaving the dev server unable to instantiate the module.
 */
const WASM_ASSET = new URL('./native/hamlib-wasm.wasm', import.meta.url);

/**
 * Resolve an Emscripten asset name to its URL.
 *
 * The pinned build loads exactly one asset, referenced above.  Any other name
 * keeps the generic shape - a `.data` file or a worker would need it - written
 * with string concatenation so no bundler turns the lookup into a directory
 * glob.
 */
function locateAsset(file: string): string | URL {
  return file === WASM_ASSET_NAME
    ? WASM_ASSET
    // biome-ignore lint/style/useTemplate: a template literal here becomes a Vite directory glob.
    : new URL('./native/' + file, import.meta.url);
}

/**
 * How long one native call may hold the queue by default.
 *
 * Hamlib's own command timeouts are seconds; this only catches a transport
 * promise that never settles, so it is generous enough not to fire on a slow
 * CAT exchange and short enough that a UI learns about a dead port.
 */
const DEFAULT_CALL_TIMEOUT_MS = 30_000;

function normalizeCallTimeout(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_CALL_TIMEOUT_MS;
  }

  if (!Number.isFinite(value) || value < 0) {
    throw new HamlibError(
      `callTimeoutMs must be a non-negative number, got ${String(value)}`,
      { code: 'INVALID_ARGUMENT', operation: 'createRawHamlib' },
    );
  }

  return Math.floor(value);
}

/** Options for {@link createRawHamlib}. */
export interface RawHamlibOptions {
  /**
   * Resolve an Emscripten asset name (e.g. `hamlib-wasm.wasm`) to a URL.
   *
   * Defaults to resolving assets next to the installed module with
   * `new URL(..., import.meta.url)`, so bundlers need no hard coded path.
   */
  locateFile?: (file: string) => string | URL;
  /**
   * Transport that acquires ports.  Omitted, the runtime selects its own
   * (`src/transport-select.ts`): Web Serial where it exists, the `serialport`
   * transport in Node.  Pass one explicitly - `nodeSerialTransport()` from
   * `hamlib-wasm/node`, or any object implementing {@link SerialTransport} -
   * and import `hamlib-wasm/node` for `listPorts()` and its options.
   */
  transport?: SerialTransport;
  /**
   * How long one native call may occupy the module's call queue before it is
   * declared stuck, in milliseconds.  `0` disables the watchdog.
   *
   * Hamlib's own timeouts bound CAT traffic, so this only fires when the layer
   * underneath it never settles - a transport whose promise is never resolved.
   * Emscripten's Asyncify cannot unwind a suspended C stack, so a stuck call
   * cannot be cancelled: the caller's promise is rejected with `RIG_TIMEOUT`,
   * every later call on the instance fails with `RIG_HUNG`, and the instance
   * must be disposed and replaced.
   */
  callTimeoutMs?: number;
  /**
   * Hamlib's debug output: the level, and a hook for every line.  The lines
   * also go into {@link RawHamlib.diagnostics}.  Omitted, only Hamlib's error
   * lines are kept, for diagnostics; Hamlib never writes to the console.
   *
   * Hamlib's level is global to the module, so it applies to every rig the
   * instance opens.
   */
  debug?: DebugOptions;
}

/** Options for {@link RawHamlib.open}. */
export interface OpenRawRigOptions {
  /** Model id taken from {@link RigModel.id}. */
  modelId: number;
  /** Port returned by {@link RawHamlib.requestPort}. */
  port: SerialPortLike;
  /**
   * Baud rate to open the port at.
   *
   * Omitted, Hamlib's own default applies: the highest rate the model
   * advertises ({@link RigModel.serialRateMax}).  A rig behind a real UART
   * answers at one rate only - the one its own menu is set to - and a wrong
   * rate produces silence, not an error, so an omitted rate is a guess.  The
   * open verifies it: a model whose backend reads the rig state while opening
   * (`get_freq`) has to have sent something back by the time `rig_open()`
   * returns, and an open that received nothing at all is rejected instead of
   * handing back a rig that cannot be read.  Where the rate is unknown, find it
   * with {@link RawHamlib.detectBaudRate} and pass the result here - or keep it
   * and reuse it on the next connect.
   */
  baudRate?: number;
  /**
   * Hamlib configuration tokens to set before the rig opens: the frontend
   * ones (`write_delay`, `post_write_delay`, `timeout`, `retry`, `ptt_type`,
   * `rts_state`, `dtr_state`, ...) and the backend's own (`civaddr` on Icom),
   * as {@link RawRig.tokenForeach} lists them.
   *
   * Refused with `INVALID_ARGUMENT`: the tokens hamlib-wasm sets itself
   * (`rig_pathname`, `serial_speed` - use `baudRate`, `poll_interval`, ...)
   * and the ones that need a second port or a device this build cannot
   * reach (`ptt_pathname`, a parallel/CM108/GPIO `ptt_type`).  A name the
   * model does not know, or a value it refuses, fails the open with
   * `HAMLIB_ERROR`.
   */
  conf?: RigConf;
}

/** Options for {@link RawRig.sendRaw}. */
export interface SendRawOptions {
  /**
   * Read the reply up to and including this byte.  `0xfd` reads one Icom
   * CI-V frame, skipping the echo.  At most 200 bytes are read.
   */
  terminator?: number;
  /** Without a terminator: read exactly this many bytes (at most 200). */
  replyLength?: number;
}

/**
 * A connected rig.
 *
 * Every CAT operation is a generated method (see
 * `src/native/generated/methods`); this interface only adds the ownership
 * facts the generated surface cannot know: which model was opened, whether it
 * is still open, and how to release it.
 */
export interface RawRig extends GeneratedPublicOperations {
  /** The model this rig was opened with. */
  readonly model: RigModel;
  /**
   * The baud rate this rig's port was opened at.
   *
   * The rate that was asked for - the caller's `baudRate`, the rate
   * {@link RawHamlib.detectBaudRate} found, or the model's advertised maximum
   * when the caller left it out - and, because the open verifies the link, one
   * the rig demonstrably answered at.  Keep it if the connection will be made
   * again: reconnecting with it skips both the guess and the scan.
   */
  readonly baudRate: number;
  /**
   * `false` once {@link RawRig.close} has completed, or once the port stopped
   * delivering - an unplugged device.  A lost rig still has to be closed.
   */
  readonly connected: boolean;
  /**
   * Send `text` as Morse through the rig's keyer.  The rig must be in CW or
   * CWR mode.
   *
   * Hamlib's `rig_send_morse()` queues for a worker thread this build does
   * not start, so the text goes to the backend's own `send_morse` in chunks
   * of what the model accepts at once, each chunk its own call: other calls
   * run between chunks, and {@link RawRig.stopMorse} drops the rest.
   * Resolves once the rig has accepted the last chunk, which may be before
   * it has finished keying it.
   *
   * Rejects with `UNSUPPORTED_OPERATION` when the backend cannot send Morse.
   */
  sendMorse(text: string): Promise<void>;
  /**
   * Drop the chunks {@link RawRig.sendMorse} has not sent yet, and stop the
   * rig keying when the backend can (`model.capabilities.has('stopMorse')`).
   */
  stopMorse(): Promise<void>;
  /**
   * Write bytes to the rig as they are and, when asked, read its reply.
   *
   * The escape hatch for a vendor command no Hamlib call covers.  Hamlib
   * keeps no state about what it sends, so a command that changes the rig
   * leaves the cache stale until the next read.  Without `terminator` or
   * `replyLength` nothing is read and an empty array is returned.
   *
   * ```ts
   * // Kenwood: read the frequency of VFO A
   * const reply = await rig.sendRaw(new TextEncoder().encode('FA;'), { terminator: 0x3b });
   * ```
   */
  sendRaw(bytes: Uint8Array, options?: SendRawOptions): Promise<Uint8Array>;
  /** Close the rig.  Idempotent; safe to call after a failure. */
  close(): Promise<void>;
}

/** A loaded Hamlib instance. */
export interface RawHamlib {
  /** Hamlib version string. */
  readonly version: string;
  /** Every rig model reachable over a serial transport. */
  readonly models: readonly RigModel[];
  /** Ask the caller-visible source for a serial port.  Requires a user gesture in the browser. */
  requestPort(options?: PortRequest): Promise<SerialPortLike>;
  /** Open a rig on a previously granted port. */
  open(options: OpenRawRigOptions): Promise<RawRig>;
  /**
   * Find the baud rate a rig answers at, by trying the rates its model
   * declares.
   *
   * Opens the port at each candidate in turn and keeps the first rate the rig
   * replies at, then closes it again - the caller opens the rig for real with
   * the returned number.  Use it when the rate is not known, and keep the
   * result: {@link RawRig.baudRate} reports the rate a rig in use was opened at,
   * so a reconnect can pass it straight to {@link RawHamlib.open}.
   *
   * ```ts
   * const port = await hamlib.requestPort();
   * const baudRate = await hamlib.detectBaudRate({ modelId, port });
   * const rig = await hamlib.open({ modelId, port, baudRate });
   * ```
   *
   * Rejects with `RIG_UNRESPONSIVE` when no candidate answered.
   */
  detectBaudRate(options: DetectBaudRateOptions): Promise<number>;
  /**
   * A snapshot for a bug report: versions, runtime, the open rigs, the
   * latest errors and port traffic, and Hamlib's debug lines when
   * {@link RawHamlibOptions.debug} is set.  Plain JSON; nothing is sent
   * anywhere.
   */
  diagnostics(): Diagnostics;
  /**
   * Close every open rig, unregister every port and reject further work.
   * Idempotent.
   */
  dispose(): Promise<void>;
}

function hamlibError(result: GeneratedCallResult, operation: string): HamlibError {
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

/** `result`, or the {@link HamlibError} for `operation` when Hamlib reported a failure. */
function checked<T extends GeneratedCallResult>(result: T, operation: string): T {
  if (result.code !== RIG_ERRCODES.OK) {
    throw hamlibError(result, operation);
  }

  return result;
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
 *
 * A watchdog bounds how long one queued call may hold the chain.  It cannot
 * interrupt the native call - Asyncify has no way to unwind a suspended C
 * stack - so a call that overruns is abandoned: the caller is rejected with
 * `RIG_TIMEOUT`, the instance is marked hung, and every later call fails with
 * `RIG_HUNG` instead of queueing behind a stack that will never return.
 */
class Serializer {
  readonly #timeoutMs: number;

  #tail: Promise<unknown> = Promise.resolve();
  #closed = false;
  #hung = false;

  readonly #onError: (operation: string, error: unknown) => void;

  constructor(timeoutMs: number, onError: (operation: string, error: unknown) => void) {
    this.#timeoutMs = timeoutMs;
    this.#onError = onError;
  }

  /** Whether a call overran and the native stack can no longer be driven. */
  get hung(): boolean {
    return this.#hung;
  }

  /** Queue work for a live instance. */
  enqueue<T>(operation: string, work: () => T | Promise<T>): Promise<T> {
    if (this.#closed) {
      return Promise.reject(disposedError(operation));
    }

    if (this.#hung) {
      return Promise.reject(hungError(operation));
    }

    return this.#chain(operation, work);
  }

  /** Queue cleanup work, which stays possible after disposal. */
  drain<T>(operation: string, work: () => T | Promise<T>): Promise<T> {
    if (this.#hung) {
      /* Nothing may re-enter the module: the suspended call still owns the
       * C stack.  Disposal handles a hung instance on the JavaScript side. */
      return Promise.reject(hungError(operation));
    }

    return this.#chain(operation, work);
  }

  close(): void {
    this.#closed = true;
  }

  #chain<T>(operation: string, work: () => T | Promise<T>): Promise<T> {
    const settled = this.#bounded(operation, work);

    settled.catch((error: unknown) => {
      this.#onError(operation, error);
    });

    return settled;
  }

  #bounded<T>(operation: string, work: () => T | Promise<T>): Promise<T> {
    /* Run regardless of whether the previous operation failed. */
    const result = this.#tail.then(work, work);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );

    if (this.#timeoutMs <= 0) {
      return result;
    }

    const { promise, resolve, reject } = Promise.withResolvers<T>();
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) { return; }

      settled = true;
      this.#hung = true;
      reject(
        new HamlibError(
          `${operation} did not settle within ${this.#timeoutMs} ms; `
          + 'the Hamlib instance is unusable and must be disposed',
          { code: 'RIG_TIMEOUT', operation },
        ),
      );
    }, this.#timeoutMs);

    result.then(
      (value) => {
        if (settled) { return; }

        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) { return; }

        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );

    return promise;
  }
}

/* ------------------------------------------------------------------ */
/* rig                                                                */
/* ------------------------------------------------------------------ */

/** The longest reply rig_send_raw() reads: its own buffer. */
const MAX_RAW_REPLY = 200;

/** What a rig handle needs from the Hamlib instance that owns it. */
interface RigContext {
  readonly native: NativeModule;
  readonly queue: Serializer;
  forget(rig: RawRigHandle): void;
  record(operation: string, error: unknown): void;
  portLost(path: string): boolean;
}

/**
 * The generated surface a compound body drives while the owning rig holds the
 * queue slot.
 *
 * It exists because the queue cannot be inferred from a flag: a concurrent call
 * on the same rig, issued while a compound body is awaiting, must still queue
 * normally, and only the body's own calls may run directly.  This object is
 * handed to exactly one body and deactivated when that body settles, so a
 * reference that escapes cannot start native work later, while every external
 * call keeps going through {@link RawRigHandle}.
 */
class CompoundScope extends GeneratedRigMethods {
  #active = false;

  constructor(
    private readonly rigNative: () => NativeOperations,
    private readonly rigHandle: () => number,
    private readonly rigAvailable: (operation: string) => void,
  ) {
    super();
  }

  activate(): void {
    this.#active = true;
  }

  deactivate(): void {
    this.#active = false;
  }

  protected native(): NativeOperations {
    this.#assertActive();
    return this.rigNative();
  }

  protected handle(): number {
    this.#assertActive();
    return this.rigHandle();
  }

  protected available(operation: string): void {
    this.#assertActive();
    this.rigAvailable(operation);
  }

  protected serialized<T>(_operation: string, work: () => Promise<T>): Promise<T> {
    /* The queue slot is already held: running the work directly is what keeps
     * the whole compound operation inside that one slot. */
    this.#assertActive();
    return work();
  }

  protected failed(result: GeneratedCallResult, operation: string): Error {
    this.#assertActive();
    return hamlibError(result, operation);
  }

  #assertActive(): void {
    if (!this.#active) {
      throw new HamlibError('compound operation is no longer active', {
        code: 'RIG_CLOSED',
        operation: 'compound',
      });
    }
  }
}

class RawRigHandle extends GeneratedRigMethods implements RawRig {
  readonly #context: RigContext;
  readonly #path: string;
  readonly #model: RigModel;
  readonly #baudRate: number;
  readonly #scope: CompoundScope;
  /** Operations this rig gained from its `conf`, beyond the model's own. */
  readonly #gained: ReadonlySet<string>;
  readonly #port: SerialPortLike;

  #handle: number;
  #closed = false;
  /** Bumped by stopMorse(), so a sendMorse() loop knows to drop the rest. */
  #morseGeneration = 0;

  constructor(
    context: RigContext,
    path: string,
    model: RigModel,
    handle: number,
    baudRate: number,
    port: SerialPortLike,
    gained: ReadonlySet<string>,
  ) {
    super();
    this.#context = context;
    this.#path = path;
    this.#model = model;
    this.#handle = handle;
    this.#baudRate = baudRate;
    this.#gained = gained;
    this.#port = port;
    this.#scope = new CompoundScope(
      () => this.#context.native,
      () => this.#handle,
      (operation) => {
        this.available(operation);
      },
    );
    bindCompoundHost(this, {
      runCompound: (operation, body) => this.#runCompound(operation, body),
      can: (operation) => this.#can(operation),
      record: (operation, error) => {
        this.#context.record(operation, error);
      },
    });
  }

  get model(): RigModel {
    return this.#model;
  }

  get baudRate(): number {
    return this.#baudRate;
  }

  get connected(): boolean {
    return !this.#closed && !this.#context.portLost(this.#path);
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
    if (this.#can(operation)) {
      return;
    }

    throw new HamlibError(
      `${this.#model.manufacturer} ${this.#model.model} cannot use ${operation}`,
      { code: 'UNSUPPORTED_OPERATION', operation },
    );
  }

  /** Whether `operation` is available on this rig, `conf` included. */
  #can(operation: string): boolean {
    return this.#model.capabilities.has(operation) || this.#gained.has(operation);
  }

  /* --- hand-written operations ---------------------------------------- */

  async sendMorse(text: string): Promise<void> {
    this.available('sendMorse');

    if (typeof text !== 'string') {
      throw new HamlibError('sendMorse text must be a string', {
        code: 'INVALID_ARGUMENT',
        operation: 'sendMorse',
      });
    }

    const generation = this.#morseGeneration;
    let rest = text;
    let first = true;

    while (rest.length > 0 && generation === this.#morseGeneration) {
      const checkMode = first;
      const chunk = rest;
      const sent = await this.#call('sendMorse', async () => {
        const result = await this.#context.native.sendMorse(this.#handle, chunk, checkMode);

        return checked(result, 'sendMorse').value;
      });

      /* A backend that accepted nothing would loop forever. */
      if (sent <= 0) { break; }

      rest = rest.slice(sent);
      first = false;
    }
  }

  async stopMorse(): Promise<void> {
    this.available('sendMorse');
    this.#morseGeneration++;

    if (!this.#can('stopMorse')) { return; }

    await this.#call('stopMorse', async () => {
      checked(await this.#context.native.stopMorse(this.#handle), 'stopMorse');
    });
  }

  async sendRaw(bytes: Uint8Array, options: SendRawOptions = {}): Promise<Uint8Array> {
    const { terminator, replyLength } = options;
    const invalid = (message: string): HamlibError =>
      new HamlibError(message, { code: 'INVALID_ARGUMENT', operation: 'sendRaw' });

    if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
      throw invalid('sendRaw needs a non-empty Uint8Array');
    }

    if (terminator !== undefined && !(Number.isInteger(terminator) && terminator >= 0 && terminator <= 0xff)) {
      throw invalid(`terminator must be a byte value, got ${String(terminator)}`);
    }

    if (
      replyLength !== undefined
      && !(Number.isInteger(replyLength) && replyLength >= 0 && replyLength <= MAX_RAW_REPLY)
    ) {
      throw invalid(`replyLength must be an integer from 0 to ${MAX_RAW_REPLY}, got ${String(replyLength)}`);
    }

    /* Encoded now: the caller may reuse the buffer while the call queues. */
    const hex = bytesToHex(bytes);
    const reply = await this.#call('sendRaw', async () => {
      const result = await this.#context.native.sendRaw(
        this.#handle,
        hex,
        terminator ?? -1,
        terminator === undefined ? (replyLength ?? 0) : 0,
      );

      return String(checked(result, 'sendRaw').value);
    });

    return hexToBytes(reply);
  }

  protected failed(result: GeneratedCallResult, operation: string): Error {
    return hamlibError(result, operation);
  }

  /* --- the compound seam (src/native/seam.ts) ------------------------- */

  /**
   * Run `body` as one unit on the module's call queue.
   *
   * The default surface composes its multi-call operations here: the whole body
   * occupies one queue slot, so a raw call, a call on another rig and a later
   * `Rig` call all wait until it finishes.  Package-internal: reached only
   * through `compoundHostOf()`.
   */
  #runCompound<T>(
    operation: string,
    body: (operations: CompoundOperations) => Promise<T>,
  ): Promise<T> {
    return this.#call(operation, async () => {
      this.#scope.activate();

      try {
        return await body(this.#scope);
      } catch (error) {
        throw compoundError(error, operation);
      } finally {
        this.#scope.deactivate();
      }
    });
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
      await this.#context.queue.drain('close', async () => {
        const result = await this.#context.native.closeRig(this.#handle);
        this.#handle = 0;
        checked(result, 'close');
      });
    } catch (error) {
      throw asHamlibError(error, 'close');
    }
  }

  get path(): string {
    return this.#path;
  }

  /** What the port says about itself, for diagnostics; a throwing getInfo() is ignored. */
  portInfo(): SerialPortInfo | undefined {
    try {
      return this.#port.getInfo?.();
    } catch {
      return undefined;
    }
  }

  /**
   * Run one native call on the shared chain.
   *
   * Every bound native function is awaited: with Asyncify a call returns a
   * promise whenever it suspended, and a plain value when it did not.
   */
  #call<T>(operation: string, work: () => Promise<T>): Promise<T> {
    if (this.#closed) {
      return Promise.reject(closedError(operation));
    }

    return this.#context.queue.enqueue<T>(operation, () => {
      if (this.#closed) {
        throw closedError(operation);
      }

      return work();
    });
  }
}

/* ------------------------------------------------------------------ */
/* hamlib instance                                                    */
/* ------------------------------------------------------------------ */

/** The JavaScript side of the serial registry inside the Wasm module. */
interface SerialRegistry {
  storePort(port: SerialPortLike): number;
  onLog: ((level: number, message: string) => void) | null;
  onTrace: ((direction: 'tx' | 'rx', path: string, bytes: Uint8Array) => void) | null;
  /** Whether the port at `path` stopped delivering (an unplugged device). */
  portLost(path: string): boolean;
  /**
   * Close every registered port from the JavaScript side, ignoring errors.
   *
   * Only used when the instance is hung: the native stack still owns the
   * module, so nothing may be called through Embind, but the port objects are
   * plain JavaScript and can still be released.
   */
  forceCloseAll?(): void;
}

function assertSerialPort(value: unknown, operation: string): asserts value is SerialPortLike {
  const port = value as Partial<SerialPortLike> | null | undefined;

  if (
    !port
    || typeof port.open !== 'function'
    || typeof port.close !== 'function'
    || typeof port.setSignals !== 'function'
    || typeof port.getSignals !== 'function'
  ) {
    throw new HamlibError('port must be a serial port (SerialPortLike)', {
      code: 'INVALID_ARGUMENT',
      operation,
    });
  }
}

/**
 * Rates a serial rig is normally configured to, lowest first.
 *
 * A backend declares a range - `serial_rate_min`/`serial_rate_max` in its
 * `rig_caps`, surfaced as {@link RigModel.serialRateMin} and
 * {@link RigModel.serialRateMax} - not the list of rates it accepts, and
 * nothing at all about the rate its own menu is set to.  A search therefore has
 * to synthesise the candidates from a ladder like this one.
 */
const BAUD_RATE_LADDER: readonly number[] = [
  300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600,
];

/**
 * Probe failures that end the search instead of moving to the next rate.
 *
 * Silence is what a wrong rate looks like, so a timeout keeps trying.  A
 * configuration or permission refusal is about the port, not the rate, so
 * trying the remaining candidates would only repeat it.
 */
const FATAL_PROBE_CODES: ReadonlySet<number> = new Set([RIG_ERRCODES.ECONF, RIG_ERRCODES.EACCESS]);

/**
 * The rate range `model` declares, when it declares a usable one: some
 * backends leave it zero or inverted, and that range constrains nothing.
 */
function declaredRange(model: RigModel): { min: number; max: number } | undefined {
  const { serialRateMin: min, serialRateMax: max } = model;

  return min > 0 && max >= min ? { min, max } : undefined;
}

/**
 * The rates {@link RawHamlib.detectBaudRate} tries for `model` when it is
 * given no `rates`, in the order it tries them: the standard UART rates inside
 * the model's declared range, highest first.
 *
 * The declared maximum leads because that is the rate Hamlib itself defaults
 * to, so a model whose default already works is answered immediately.  A
 * declared range that is not usable (some backends leave it zero) leaves the
 * whole ladder in place rather than turning into an empty search.
 *
 * A UI that searches one rate at a time - to show progress, or to try a
 * remembered rate first - takes its list from here and passes single rates
 * as `rates`.
 */
export function baudRateCandidates(model: RigModel): number[] {
  const range = declaredRange(model);
  const inRange = (rate: number): boolean =>
    range === undefined || (rate >= range.min && rate <= range.max);

  return [...new Set([model.serialRateMax, ...BAUD_RATE_LADDER.filter(inRange)])]
    .filter((rate) => Number.isInteger(rate) && rate > 0)
    .sort((left, right) => right - left);
}

function assertBaudRate(baudRate: number, model: RigModel): void {
  if (!Number.isInteger(baudRate) || baudRate <= 0) {
    throw new HamlibError(`baudRate must be a positive integer, got ${baudRate}`, {
      code: 'INVALID_ARGUMENT',
      operation: 'open',
    });
  }

  const range = declaredRange(model);

  if (range !== undefined && (baudRate < range.min || baudRate > range.max)) {
    throw new HamlibError(
      `baudRate ${baudRate} is outside the ${range.min}-${range.max} `
      + `range supported by ${model.manufacturer} ${model.model}`,
      { code: 'INVALID_ARGUMENT', operation: 'open' },
    );
  }
}

/**
 * A declared line setting by its Hamlib name.  The facade names every value
 * Hamlib defines; one it has no name for reads as `'none'`.
 */
function declaredSetting<T extends string>(names: readonly T[], value: unknown): T | 'none' {
  const text = String(value);
  return names.find((name) => name === text) ?? 'none';
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
function collectCapabilities(model: NativeModel, native: NativeModule): ReadonlySet<string> {
  const capabilities = new Set(drainVector(native.capabilities(model.id), String));

  for (const [operation, flag] of FLAG_GATED_OPERATIONS) {
    if (model[flag]) {
      capabilities.add(operation);
    }
  }

  return capabilities;
}

function describeModel(model: NativeModel, native: NativeModule): RigModel {
  const manufacturer = String(model.manufacturer);
  const name = String(model.model);
  const settings = {
    serialDataBits: model.serialDataBits,
    serialStopBits: model.serialStopBits,
    serialParity: declaredSetting(SERIAL_PARITIES, model.serialParity),
    serialHandshake: declaredSetting(SERIAL_HANDSHAKES, model.serialHandshake),
  };
  const { support, limitation } = classifyModel(manufacturer, name, settings);
  const capabilities = collectCapabilities(model, native);
  const operations = operationCapabilities((operation) => capabilities.has(operation));

  return {
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
    capabilities,
    canGetFrequency: operations.getFrequency,
    canSetFrequency: operations.setFrequency,
    canGetMode: operations.getMode,
    canSetMode: operations.setMode,
    canGetPtt: operations.getPtt,
    canSetPtt: operations.setPtt,
  };
}

class RawHamlibInstance implements RawHamlib, RigContext {
  readonly #native: NativeModule;
  readonly #registry: SerialRegistry;
  readonly #transport: SerialTransport;
  readonly #models: RigModel[];
  readonly #modelsById: Map<number, RigModel>;
  readonly #version: string;
  readonly #rigs = new Set<RawRigHandle>();
  readonly #paths = new Set<string>();
  readonly #recorder: DiagnosticsRecorder;

  readonly queue: Serializer;

  #portCounter = 0;
  #disposed = false;
  #disposePromise?: Promise<void>;

  private constructor(
    native: NativeModule,
    registry: SerialRegistry,
    transport: SerialTransport,
    models: RigModel[],
    version: string,
    callTimeoutMs: number,
    recorder: DiagnosticsRecorder,
  ) {
    this.#native = native;
    this.#registry = registry;
    this.#transport = transport;
    this.#models = models;
    this.#modelsById = new Map(models.map((model) => [model.id, model]));
    this.#version = version;
    this.#recorder = recorder;
    this.queue = new Serializer(callTimeoutMs, (operation, error) => {
      recorder.error(operation, error);
    });
  }

  static async create(options: RawHamlibOptions): Promise<RawHamlibInstance> {
    /* Without `debug`, Hamlib's error lines are still kept for diagnostics(). */
    const level = options.debug === undefined ? 'err' : (options.debug.level ?? 'verbose');
    const debugLevel = debugLevelValue(level, 'createRawHamlib');
    const callTimeoutMs = normalizeCallTimeout(options.callTimeoutMs);
    const recorder = new DiagnosticsRecorder(level, options.debug?.onLog);
    const native = await createNativeModule({
      locateFile: (file: string) => String((options.locateFile ?? locateAsset)(file)),
    });

    const registry = native.HamlibWs as SerialRegistry;

    if (typeof registry?.storePort !== 'function') {
      throw new HamlibError(
        'the WebAssembly module did not expose its serial registry',
        { code: 'TRANSPORT_FAILURE', operation: 'createRawHamlib' },
      );
    }

    /* Every bound native call is awaited: Asyncify returns a promise when the
     * call suspended and a plain value when it did not. */
    checked(await native.initialize(), 'initialize');

    registry.onTrace = (direction, path, bytes) => {
      recorder.trace(direction, path, bytes);
    };

    /* Hamlib's own output never reaches the console: a library embedded in a
     * page or a process must not write there, and failures already reach the
     * caller as a HamlibError.  Every line goes to the recorder instead, and
     * on to `debug.onLog`.  Set after the backends registered: their
     * announcements are noise. */
    registry.onLog = (lineLevel, message) => {
      recorder.log(lineLevel, message);
    };

    checked(await native.setDebug(debugLevel), 'initialize');

    const models = drainVector(await native.listModels(), (model) => describeModel(model, native));

    return new RawHamlibInstance(
      native,
      registry,
      await selectTransport(options.transport),
      models,
      await native.version(),
      callTimeoutMs,
      recorder,
    );
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

  forget(rig: RawRigHandle): void {
    this.#rigs.delete(rig);
  }

  record(operation: string, error: unknown): void {
    this.#recorder.error(operation, error);
  }

  portLost(path: string): boolean {
    return this.#registry.portLost(path);
  }

  async requestPort(options?: PortRequest): Promise<SerialPortLike> {
    this.#assertLive('requestPort');
    this.#assertTransport('requestPort');

    return this.#transport.requestPort(options);
  }

  async open(options: OpenRawRigOptions): Promise<RawRig> {
    this.#assertLive('open');
    this.#assertTransport('open');

    const { modelId, port, baudRate } = options;
    const conf = encodeConf(options.conf, 'open');
    const model = this.#requireModel(modelId, 'open');

    if (baudRate !== undefined) {
      assertBaudRate(baudRate, model);
    }

    /* The rig keeps the path it was opened on. */
    const rig = await this.#withBorrowedPort('open', port, { keep: true }, async (path) => {
      const opened = checked(await this.#native.openRig(modelId, path, baudRate ?? 0, conf), 'open');

      /* Register inside the queued work: dispose() drains the chain before it
       * snapshots the live rigs, so this rig is always reachable. */
      const rig = new RawRigHandle(
        this,
        path,
        model,
        opened.handle,
        /* The rate the port was actually opened at: Hamlib's default is the
         * model's declared maximum (src/rig.c sets `serial_rate_max`), and the
         * facade has just verified the rig answers at it. */
        baudRate ?? model.serialRateMax,
        port,
        /* PTT moved onto the port's RTS/DTR line works whatever the backend
         * declares. */
        confKeysPttLine(options.conf) ? new Set(['getPtt', 'setPtt']) : new Set(),
      );
      this.#rigs.add(rig);
      return rig;
    });

    if (this.#disposed) {
      /* Disposal was accepted while this open waited in the queue.  Hand the
       * rig over closed instead of letting an open survive it; dispose()
       * releases its path with the others. */
      await rig.close();
      throw disposedError('open');
    }

    return rig;
  }

  async detectBaudRate(options: DetectBaudRateOptions): Promise<number> {
    this.#assertLive('detectBaudRate');
    this.#assertTransport('detectBaudRate');

    const { modelId, port, rates } = options;
    const conf = encodeConf(options.conf, 'detectBaudRate');
    const model = this.#requireModel(modelId, 'detectBaudRate');
    const candidates = rates === undefined ? baudRateCandidates(model) : [...new Set(rates)];

    if (candidates.length === 0) {
      throw new HamlibError(
        `no baud rate to try for ${model.manufacturer} ${model.model}`,
        { code: 'INVALID_ARGUMENT', operation: 'detectBaudRate' },
      );
    }

    /* The port is only borrowed for the search: the caller opens the rig for
     * real, and dispose() must not inherit a leftover registration. */
    return this.#withBorrowedPort('detectBaudRate', port, { keep: false }, async (path) => {
      /* Each candidate is a complete open under a shortened port budget: the
       * facade reports success only when the rig answered, and closes again
       * whatever it opened, so a silent rate simply moves on.  A refusal that
       * is not silence - a setting the port rejects, a port the OS denies -
       * ends the search instead of being retried at every rate. */
      let lastFailure: GeneratedCallResult | undefined;

      for (const rate of candidates) {
        const probed = await this.#native.probeBaudRate(modelId, path, rate, conf);

        if (probed.code === RIG_ERRCODES.OK) {
          return rate;
        }

        if (FATAL_PROBE_CODES.has(Math.abs(probed.code))) {
          throw hamlibError(probed, `detectBaudRate(${rate})`);
        }

        lastFailure ??= probed;
      }

      const detail = typeof lastFailure?.error === 'string' && lastFailure.error
        ? ` (last failure: ${lastFailure.error})`
        : '';

      throw new HamlibError(
        `${model.manufacturer} ${model.model} did not answer at any of `
        + `${candidates.join(', ')} baud${detail}`,
        {
          code: 'RIG_UNRESPONSIVE',
          operation: 'detectBaudRate',
          ...(lastFailure === undefined ? {} : { cause: lastFailure }),
        },
      );
    });
  }

  diagnostics(): Diagnostics {
    const rigs: DiagnosticsRig[] = [...this.#rigs].map((rig) => {
      const info = rig.portInfo();

      return {
        path: rig.path,
        modelId: rig.model.id,
        manufacturer: rig.model.manufacturer,
        model: rig.model.model,
        backendVersion: rig.model.backendVersion,
        baudRate: rig.baudRate,
        connected: rig.connected,
        ...(info?.usbVendorId !== undefined && info.usbProductId !== undefined
          ? { usb: { vendorId: formatUsbId(info.usbVendorId), productId: formatUsbId(info.usbProductId) } }
          : {}),
      };
    });

    return this.#recorder.report({
      hamlibVersion: this.#version,
      transport: this.#transport.name,
      hung: this.queue.hung,
      rigs,
    });
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
     * them, so the snapshot below covers every rig and port they created.  On a
     * hung instance the barrier itself fails with RIG_HUNG; that is the state
     * the caller already knows about, not a cleanup failure, so it is not
     * reported twice. */
    try {
      await this.queue.drain('dispose', () => {});
    } catch (error) {
      if (!this.queue.hung) {
        failures.push(error);
      }
    }

    if (this.queue.hung) {
      /* The suspended native call still owns the module: nothing may cross
       * Embind again, but the port objects are plain JavaScript and can be
       * released.  The instance is dead either way. */
      try {
        this.#registry.forceCloseAll?.();
      } catch (error) {
        failures.push(error);
      }

      this.#rigs.clear();
      this.#paths.clear();

      if (failures.length > 0) { throw failures[0]; }

      return;
    }

    for (const rig of [...this.#rigs]) {
      try {
        await rig.close();
      } catch (error) {
        failures.push(error);
      }
    }

    for (const path of [...this.#paths]) {
      try {
        await this.#releasePath(path, 'dispose');
      } catch (error) {
        failures.push(error);
      }
    }

    /* Releases the native handle map and the JavaScript registry.  Wasm
     * memory itself is reclaimed when the module is collected: Emscripten
     * offers no unload, so this is the deterministic part. */
    try {
      await this.queue.drain('destroy', () => this.#native.destroy());
    } catch (error) {
      failures.push(error);
    }

    if (failures.length > 0) {
      throw failures[0];
    }
  }

  /** The catalogue entry for `modelId`, or `INVALID_ARGUMENT`. */
  #requireModel(modelId: number, operation: string): RigModel {
    const model = this.#modelsById.get(modelId);

    if (!model) {
      throw new HamlibError(
        `unknown rig model id ${String(modelId)}; use an id from hamlib.models`,
        { code: 'INVALID_ARGUMENT', operation },
      );
    }

    return model;
  }

  /**
   * Run `work` on the queue with `port` registered under a fresh logical path.
   *
   * The path is tracked before queueing, so dispose() can always see and
   * release an accepted operation, even when disposal races with it.  It is
   * released again when the work fails, and when it succeeds unless `keep`
   * says the path was handed on - an opened rig keeps it.
   */
  async #withBorrowedPort<T>(
    operation: string,
    port: SerialPortLike,
    { keep }: { readonly keep: boolean },
    work: (path: string) => Promise<T>,
  ): Promise<T> {
    assertSerialPort(port, operation);

    const path = `serial/${++this.#portCounter}`;
    const token = this.#registry.storePort(port);

    if (token <= 0) {
      throw new HamlibError('the selected port could not be registered', {
        code: 'TRANSPORT_FAILURE',
        operation,
      });
    }

    this.#paths.add(path);

    let kept = false;

    try {
      const result = await this.queue.enqueue<T>(operation, async () => {
        checked(await this.#native.registerPort(path, token), operation);

        return work(path);
      });

      kept = keep;
      return result;
    } finally {
      if (!kept) {
        /* The work's own outcome is the one the caller needs; dispose()
         * reports leftover registrations. */
        await this.#releasePath(path, operation).catch(() => {});
      }
    }
  }

  /**
   * Unregister one logical path; the native handle is already closed.  A
   * failure is reported under `operation`, the call that let the path go.
   */
  async #releasePath(path: string, operation: string): Promise<void> {
    await this.queue.drain(operation, async () => {
      checked(await this.#native.unregisterPort(path), operation);

      this.#paths.delete(path);
    });
  }

  /** Every port-using operation needs a transport that can run here. */
  #assertTransport(operation: string): void {
    if (this.#transport.isSupported()) { return; }

    throw new HamlibError(
      `${this.#transport.name} is not available in this runtime; pass a transport to createRawHamlib()`,
      { code: 'TRANSPORT_UNAVAILABLE', operation },
    );
  }

  #assertLive(operation: string): void {
    if (this.#disposed) {
      throw disposedError(operation);
    }
  }
}

/**
 * Load Hamlib and read its rig model catalogue.
 *
 * ```ts
 * const hamlib = await createRawHamlib();
 * const port = await hamlib.requestPort();
 * const rig = await hamlib.open({ modelId, port });
 * ```
 */
export async function createRawHamlib(options: RawHamlibOptions = {}): Promise<RawHamlib> {
  return RawHamlibInstance.create(options);
}
