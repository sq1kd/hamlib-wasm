/*
 * SPDX-License-Identifier: MIT
 *
 * Ambient globals and library types provided by Emscripten when a file is used
 * as a `--js-library`.
 *
 * The library file is evaluated inside Emscripten's library scope, where these
 * symbols exist but are not part of any TypeScript `lib`.  Declaring them here
 * lets the transport be written and type-checked as ordinary strict TypeScript
 * instead of raw JavaScript.
 */

declare function addToLibrary(library: Record<string, unknown>): void;

/** The current Wasm heap, byte-addressed. */
declare const HEAPU8: Uint8Array;

declare function UTF8ToString(ptr: number): string;

declare function stringToUTF8(str: string, ptr: number, maxBytesToWrite: number): void;

declare function lengthBytesUTF8(str: string): number;

/* --- transport state types ---------------------------------------------- */

/*
 * Mirrors SerialPortLike in src/transport.ts.  This file is compiled with
 * module: none and cannot import it; the guards in storePort() and both
 * transport suites fail if the two drift.
 */

/** Line settings a transport opens a port with.  Field names are Web Serial's. */
interface SerialLineSettings {
  baudRate: number;
  dataBits?: 7 | 8;
  stopBits?: 1 | 2;
  parity?: 'none' | 'even' | 'odd';
  flowControl?: 'none' | 'hardware';
  bufferSize?: number;
}

interface SerialOutputSignals {
  requestToSend?: boolean;
  dataTerminalReady?: boolean;
  break?: boolean;
}

/** Input lines.  A line a transport cannot read is reported `false`. */
interface SerialInputSignals {
  clearToSend: boolean;
  dataSetReady: boolean;
  dataCarrierDetect: boolean;
  ringIndicator: boolean;
}

/**
 * One device, as the transport layer drives it.
 *
 * The object handed to `HamlibWs.storePort()` is whatever the package's
 * transport acquired: a browser `SerialPort` in the browser
 * (`src/web-serial.ts`), the `serialport` adapter in Node (`src/node.ts`).
 */
interface SerialPortLike {
  open(settings: SerialLineSettings): Promise<void>;
  close(): Promise<void>;
  readonly readable: ReadableStream<Uint8Array> | null;
  readonly writable: WritableStream<Uint8Array> | null;
  setSignals(signals: SerialOutputSignals): Promise<void>;
  getSignals(): Promise<SerialInputSignals>;
  /**
   * Output lines this transport asserts when it opens a port, if it asserts
   * any.  Web Serial leaves both deasserted and omits this; the Node adapter
   * reports what `serialport` applies, so `ser_get_dtr()` tells the truth.
   */
  initialSignals?(): { rts: boolean; dtr: boolean };
}

type WakeReason = 'data' | 'timeout' | 'error';

interface ByteQueue {
  chunks: Uint8Array[];
  offset: number;
  length: number;
}

interface TransportFailure {
  name: string;
  message: string;
}

interface PortState {
  options: SerialLineSettings;
  queue: ByteQueue;
  waiters: ((reason: WakeReason) => void)[];
  failure: TransportFailure | null;
  closed: boolean;
  reader: ReadableStreamDefaultReader<Uint8Array> | null;
  writer: WritableStreamDefaultWriter<Uint8Array> | null;
  writeChain: Promise<number> | null;
  pumpPromise: Promise<void> | null;
  /* Bytes the pump has delivered since this state was created, i.e. since the
   * port was last opened.  A read does not clear it: it answers "did the rig
   * ever speak", which is what the facade's reachability check asks. */
  rxBytes: number;
  lastRts: number;
  lastDtr: number;
}

interface PortRecord {
  path: string;
  port: SerialPortLike;
  openCount: number;
  state: PortState | null;
}

interface HandleEntry {
  record: PortRecord;
  state: PortState;
}

interface ErrorRecord {
  name: string;
  message: string;
  context: string;
}

/**
 * The transport object Emscripten injects as `Module.HamlibWs`.
 *
 * It is the contextual type for the `$HamlibWs` object literal, so the
 * literal's methods get a typed `this`, and it is the type of the injected
 * `HamlibWs` global that the sibling library entries call.  Emscripten lifts
 * each entry out of the `--js-library` file, so entries may reference only this
 * global and other Emscripten globals - never a module-scope closure.
 */
interface HamlibWsApi {
  WS_OK: number;
  WS_ERR_IO: number;
  WS_ERR_CONF: number;
  WS_ERR_INVAL: number;
  WS_ERR_TIMEOUT: number;
  WS_ERR_ACCESS: number;
  WS_ERR_BUSY: number;

  /** Bytes the RX pump may buffer before a read is overdue and the port fails. */
  RX_QUEUE_LIMIT: number;

  /* token -> port, waiting for the facade to bind it to a logical path */
  pendingPorts: Map<number, SerialPortLike>;
  /* logical path -> record */
  ports: Map<string, PortRecord>;
  /* handle -> record + state */
  handles: Map<number, HandleEntry>;
  nextToken: number;
  nextHandle: number;
  lastError: ErrorRecord | null;

  /** Set by the TypeScript layer: every Hamlib debug line, once `setDebug` registered the callback. */
  onLog: ((level: number, message: string) => void) | null;
  /** Set by the TypeScript layer: every chunk written to or read from a port. */
  onTrace: ((direction: 'tx' | 'rx', path: string, bytes: Uint8Array) => void) | null;
  log(level: number, message: string): void;
  trace(direction: 'tx' | 'rx', path: string, bytes: Uint8Array): void;

  /**
   * Release every port from JavaScript without crossing the Wasm boundary.
   * Only used when a native call is stuck and the module cannot be re-entered.
   */
  forceCloseAll(): void;

  recordError(name: string, message: string, context?: string): void;
  fail(error: unknown, context: string): number;
  lastErrorText(): string;
  storePort(port: SerialPortLike): number;
  registerPort(path: string, token: number): number;
  unregisterPort(path: string): number;
  queuePush(queue: ByteQueue, chunk: Uint8Array): void;
  queueRead(queue: ByteQueue, heap: Uint8Array, ptr: number, max: number): number;
  queueClear(queue: ByteQueue): void;
  wake(state: PortState, reason: WakeReason): void;
  startPump(state: PortState, path: string): Promise<void>;
  makeState(options: SerialLineSettings, rts: number, dtr: number): PortState;
  allocHandle(record: PortRecord): number;
  teardown(record: PortRecord, state: PortState): Promise<number>;
  openPort(
    path: string,
    rate: number,
    dataBits: number,
    stopBits: number,
    parity: number,
    flowControl: number,
  ): Promise<number>;
  closePort(handle: number): Promise<number>;
  matchesOpenOptions(
    handle: number,
    rate: number,
    dataBits: number,
    stopBits: number,
    parity: number,
    flowControl: number,
  ): number;
  read(handle: number, ptr: number, len: number): number;
  bytesReceived(handle: number): number;
  write(handle: number, ptr: number, len: number): Promise<number>;
  waitReadable(handle: number, timeoutMs: number): Promise<number>;
  flush(handle: number): number;
  setSignals(handle: number, rts: number, dtr: number, brk: number): Promise<number>;
  getSignals(handle: number): Promise<number>;
  lastRts(handle: number): number;
  lastDtr(handle: number): number;
  writeLastError(ptr: number, len: number): number;
  clearLastError(): number;
}

declare const HamlibWs: HamlibWsApi;
