/**
 * Ambient declarations for the in-page browser fixtures.
 *
 * virtual-clock.ts, rigs.ts, fake-port.ts, fake-serial.ts and helpers.ts are
 * compiled to `generated/*.js` by the neighbouring tsconfig.json and injected
 * into the page as *text* (see tests/browser/fixtures.ts).  They are standalone
 * scripts rather than modules, so they share the page's global scope; this file
 * is the single place that says what they publish on `window`.  The spec
 * project and the Node tests read the same declarations.
 *
 * It is deliberately a global script (no imports, no exports) so that
 * `interface Window` merges with the one lib.dom declares; the package's port
 * contract comes in through type-only `import()` expressions, which keep it a
 * script (and stay clear of the Web Serial globals the spec project declares
 * under the same names).
 */

/** Every emulator carries this state, whichever protocol it speaks. */
interface FakeRigState {
  frequency: number;
  modeDigit: number;
  filterValue: number;
  transmitting: boolean;
  /** Decode and record what the host sends, but answer none of it. */
  silent: boolean;
}

/** One CAT protocol: host bytes in, reply bytes out. */
interface FakeRigProtocol {
  /** The protocol name, for diagnostics. */
  name: string;
  state: FakeRigState;
  /**
   * The rate this rig's own menu is set to, when it has one.
   *
   * Omitted (a USB CDC interface, which ignores the line rate entirely) the
   * emulator answers at whatever is asked.
   */
  baudRate?: number;
  /** Every request the emulator decoded, as readable text. */
  commands: string[];
  /** Forget the partial frame, keeping the state. */
  reset(): void;
  /** Consume a chunk of host bytes and return the reply chunks. */
  feed(chunk: Uint8Array): Uint8Array[];
}

/** One emulated radio, as returned by its factory in the registry. */
interface FakeRig extends FakeRigProtocol {
  /**
   * What the radio sends back for host bytes that arrived on a line opened at
   * `baudRate` (null before any open): nothing at a rate its menu is not set
   * to, nothing while it is silent.  The one entry point every port double
   * uses.
   */
  hear(chunk: Uint8Array, baudRate: number | null): Uint8Array[];
}

/** The emulated radios rigs.ts publishes, by protocol name. */
type FakeRigRegistry = ReturnType<typeof createFakeRigRegistry>;

type FakeRigName = keyof FakeRigRegistry;

/**
 * The control surface of one fake port over one emulated rig (fake-port.ts).
 *
 * The same object drives the browser's Web Serial double and the Node tests'
 * injected port, so every rule a double enforces is written once.
 */
interface FakePortControl {
  /** The port, as the package's own contract types it. */
  readonly port: import('hamlib-wasm/raw').SerialPortLike;
  /** The protocol currently driving the emulator. */
  rigName: FakeRigName;
  /** Line settings the port was opened with, or null before the first open. */
  openedOptions: import('hamlib-wasm/raw').SerialLineSettings | null;
  openCount: number;
  closeCount: number;
  isOpen: boolean;
  /** Set to a DOMException name to make the next open() fail. */
  failNextOpen: string | null;
  /**
   * When true, the next `open()` parks until `releaseOpen()` runs.  The
   * controlled gate a test uses instead of a sleep to hold a connection
   * attempt at its first asynchronous boundary.
   */
  holdNextOpen: boolean;
  /** True while a held `open()` is parked. */
  openPending: boolean;
  /** Release the parked `open()`, completing it.  A no-op when none is parked. */
  releaseOpen(): void;
  /**
   * Delay every emulator reply by this many milliseconds - of virtual time
   * when the clock is virtual, as it is in every browser spec.
   */
  replyDelayMs: number;
  /**
   * Split every reply into pieces of this many bytes, `fragmentGapMs` apart,
   * as a USB-serial adapter delivers them.  0 hands each reply over whole.
   */
  fragmentBytes: number;
  fragmentGapMs: number;
  /**
   * Mirror every host write straight back, as a CI-V bus or an echoing
   * interface does.  The echo comes from the line, not the radio, so it
   * arrives even when the rig is silent or opened at the wrong rate.
   */
  echo: boolean;
  /** When true, every host write is refused, as a device that rejects commands. */
  failWrites: boolean;
  /** Every `close()` call, including those the port refused. */
  closeRequests: number;
  /** True when close() found a locked stream, i.e. the transport leaked. */
  closedWithLockedStreams: boolean;
  /** Every command the emulator decoded, without its framing. */
  commands: string[];
  /** Every output line the transport has driven, accumulated; null before any. */
  outputSignals: import('hamlib-wasm/raw').SerialOutputSignals | null;
  /** `setSignals()` calls, for asserting the transport only drives what it must. */
  setSignalsCalls: number;
  /** Input modem lines reported by `getSignals()`. */
  inputSignals: import('hamlib-wasm/raw').SerialInputSignals;
  /** Emulated protocol state, exposed for assertions. */
  state: FakeRigState;
  /** Switch the emulated radio; only valid while the port is closed. */
  useRig(name: FakeRigName): void;
  /** Inject bytes into the readable stream without a write. */
  pushRaw(text: string): void;
  /** Fail the readable stream with a DOMException of `name`, as an unplug would. */
  errorReadable(name: string): void;
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
type Captured<T> = { ok: true; value: T } | { ok: false; error: HamlibErrorView };

/** The assertion helpers `window.__testHelpers` publishes. */
interface TestHelpers {
  describeError(value: unknown): HamlibErrorView;
  capture<T>(action: () => T | Promise<T>): Promise<Captured<Awaited<T>>>;
}

/** How the virtual clock moves: by itself when the page drains, or on request. */
type VirtualClockMode = 'auto' | 'manual';

/** One pending virtual timer. */
interface VirtualTimer {
  id: number;
  /** Virtual time it is due at. */
  callAt: number;
  /** Tie-break between timers due at the same instant: scheduling order. */
  sequence: number;
  /** Interval period, or 0 for a one-shot timeout. */
  period: number;
  callback: (...values: unknown[]) => void;
  args: unknown[];
}

/** The control surface `window.__virtualClock` publishes. */
interface VirtualClockView {
  /** Current virtual time, in milliseconds (what `performance.now()` reports). */
  now(): number;
  mode: VirtualClockMode;
  /** Timers and intervals still scheduled. */
  pendingTimers(): number;
  /** Let `ms` of virtual time pass, firing every timer due in it, in order. */
  advance(ms: number): Promise<void>;
  /** Fire timers, in order, until `promise` settles; resolve to its outcome. */
  settle<T>(promise: Promise<T>): Promise<T>;
  /** Fire timers, in order, until `predicate()` holds. */
  until(predicate: () => boolean): Promise<void>;
}

interface Window {
  __virtualClock: VirtualClockView;
  __fakeRigRegistry: FakeRigRegistry;
  /** A fresh fake port over `rigName`, the TS-480 when omitted. */
  __createFakePort(rigName?: FakeRigName): FakePortControl;
  /** The fake port behind the page's `navigator.serial`. */
  __fakeSerial: FakePortControl;
  __testHelpers: TestHelpers;
}
