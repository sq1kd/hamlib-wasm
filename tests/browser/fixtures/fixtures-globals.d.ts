/**
 * Ambient declarations for the in-page browser fixtures.
 *
 * rigs.ts, fake-serial.ts and helpers.ts are compiled to `generated/*.js` by
 * the neighbouring tsconfig.json and injected into the page as *text* (see
 * tests/browser/fixtures.ts).  They are standalone scripts rather than modules,
 * so they share the page's global scope; this file is the single place that
 * says what they publish on `window`.
 *
 * It is deliberately a global script (no imports, no exports) so that
 * `interface Window` merges with the one lib.dom declares.  The browser spec
 * project excludes this directory because its own declarations for
 * `__hamlibHarness`, `__testHelpers` and `__fakeSerial` are richer (they know
 * `Hamlib`, `MainModule` and `SerialPort`); these types describe the fixture
 * scripts themselves, which only know the plain DOM.
 */

/** Every emulator carries this state, whichever protocol it speaks. */
interface FakeRigState {
  frequency: number;
  modeDigit: number;
  filterValue: number;
  transmitting: boolean;
  silent: boolean;
}

/** One emulated radio, as returned by its factory in the registry. */
interface FakeRig {
  /** The protocol name, for diagnostics. */
  name: string;
  state: FakeRigState;
  /**
   * The rate this rig's own menu is set to, when it has one.
   *
   * A rig behind a real UART hears one rate only: opened at any other, it
   * receives framing errors and stays silent rather than answering with an
   * error.  Emulators that set this are silent at every other rate - which is
   * what a scan has to cope with.  Omitted (a USB CDC interface, which ignores
   * the line rate entirely) the emulator answers at whatever is asked.
   */
  baudRate?: number;
  /** Every request the emulator decoded, as readable text. */
  commands: string[];
  /** Forget the partial frame, keeping the state. */
  reset(): void;
  /** Consume a chunk of host bytes and return the reply chunks. */
  feed(chunk: Uint8Array): Uint8Array[];
}

/**
 * The emulated radios `window.__fakeRigRegistry` publishes.
 *
 * The known keys are listed so a factory result and a protocol name are checked
 * where they meet; the index signature is what `useRig(name)` looks up, and it
 * is `| undefined` because an unknown name is a runtime error there.
 */
interface FakeRigRegistry {
  'kenwood-ts480': () => FakeRig;
  'icom-ic703': () => FakeRig;
  'icom-ic746': () => FakeRig;
  'yaesu-ft710': () => FakeRig;
  'yaesu-ft757gx2': () => FakeRig;
  'yaesu-frg100': () => FakeRig;
  [name: string]: (() => FakeRig) | undefined;
}

/** The subset of `SerialOptions` the fake transport records and replays. */
interface FakeSerialOptions {
  baudRate: number;
  dataBits: number;
  stopBits: number;
  parity: string;
  flowControl: string;
}

/** The subset of `SerialOutputSignals` the fake port accepts. */
interface FakeOutputSignals {
  dataTerminalReady?: boolean | undefined;
  requestToSend?: boolean | undefined;
  break?: boolean | undefined;
}

/** The input modem lines the fake port reports. */
interface FakeInputSignals {
  clearToSend: boolean;
  dataSetClearToSend: boolean;
  dataSetReady: boolean;
  dataCarrierDetect: boolean;
  ringIndicator: boolean;
}

/**
 * The port surface the fake transport implements.
 *
 * It is a deliberate subset of the DOM's `SerialPort`: the fixtures provide
 * `lib: DOM` only, and the specs see the fixture through the richer
 * `SerialPort` declaration in tests/browser/fixtures.ts.
 */
interface FakePort {
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
  open(options: FakeSerialOptions): Promise<void>;
  close(): Promise<void>;
  setSignals(signals: FakeOutputSignals): Promise<void>;
  getSignals(): Promise<FakeInputSignals>;
  getInfo(): { usbVendorId: number; usbProductId: number };
}

/**
 * The constructor of the prototype-built fake port.
 *
 * TypeScript cannot infer a construct signature for the function expression
 * that builds `FakePort`, and this is the shape the fixtures assert it to.
 */
interface FakePortConstructor {
  new (): FakePort;
  prototype: FakePort;
}

/**
 * The control surface the fake transport publishes, minus the members that are
 * only attached once the transport exists.
 */
interface FakeSerialControlBase {
  /** The protocol currently driving the emulator. */
  rigName: string;
  /** Options handed to `SerialPort.open()`, or null. */
  openedOptions: FakeSerialOptions | null;
  openCount: number;
  closeCount: number;
  isOpen: boolean;
  /** Set to a DOMException name to make the next open() fail. */
  failNextOpen: string | null;
  /**
   * When true, the next `open()` parks until `releaseOpen()` runs.  The
   * controlled gate a spec uses instead of a sleep to hold a connection
   * attempt at its first asynchronous boundary.
   */
  holdNextOpen: boolean;
  /** True while a held `open()` is parked. */
  openPending: boolean;
  /** Release the parked `open()`, completing it. */
  releaseOpen(): void;
  /** Delay applied to every emulator reply, in milliseconds. */
  replyDelayMs: number;
  /** When true, every host write is refused. */
  failWrites: boolean;
  /** True when close() found a locked stream, i.e. the transport leaked. */
  closedWithLockedStreams: boolean;
  /** Every command the emulator decoded, without its framing. */
  commands: string[];
  /** Last value passed to `setSignals()`. */
  outputSignals: FakeOutputSignals | null;
  /** `setSignals()` calls, for asserting the transport only drives what it must. */
  setSignalsCalls: number;
  /** Input modem lines reported by `getSignals()`. */
  inputSignals: FakeInputSignals;
  /** Emulated protocol state, exposed for assertions. */
  state: FakeRigState;
}

/**
 * The whole control surface, as the specs drive it through
 * `window.__fakeSerial`.
 */
interface FakeSerialControl extends FakeSerialControlBase {
  /** The single fake device the fixture exposes. */
  port: FakePort;
  /** Switch the emulated radio; only valid while the port is closed. */
  useRig(name: string): void;
  /** Remove `navigator.serial` so the unavailable path can be exercised. */
  removeWebSerial(): void;
  /** Inject bytes into the readable stream without a write. */
  pushRaw(text: string): void;
  /** Fail the readable stream, as a device unplug would. */
  errorReadable(name: string): void;
}

/**
 * The slice of the harness page the helpers reach for.
 *
 * It is read as `window.__hamlibHarness`, which the harness page publishes on
 * load, so it is absent while `addInitScript` runs.
 */
interface HamlibHarnessView {
  isHamlibError(value: unknown): boolean;
}

/** A structured-clone-safe view of a `HamlibError`. */
interface HamlibErrorView {
  name: string | null;
  message: string;
  code: string | null;
  operation: string | null;
  hamlibCode: number | null;
  hamlibMessage: string | null;
  /** `name: message` of the wrapped cause, when there is one. */
  cause: string | null;
  isHamlibError: boolean;
}

/** The outcome of an in-page action, normalised for Playwright. */
type CapturedView<T> = { ok: true; value: T } | { ok: false; error: HamlibErrorView };

/** The assertion helpers `window.__testHelpers` publishes. */
interface TestHelpersView {
  describeError(value: unknown): HamlibErrorView;
  capture<T>(action: () => T | Promise<T>): Promise<CapturedView<Awaited<T>>>;
  sleep(ms: number): Promise<void>;
}

interface Window {
  __fakeRigRegistry: FakeRigRegistry;
  __fakeSerial: FakeSerialControl;
  __hamlibHarness: HamlibHarnessView | undefined;
  __testHelpers: TestHelpersView;
}
