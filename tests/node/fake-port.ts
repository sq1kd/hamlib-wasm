/**
 * A `SerialPortLike` double in Node, over one emulated rig.
 *
 * The Node counterpart of tests/browser/fixtures/fake-serial.ts, with the same
 * rules - a second open is refused, an opened port records its line settings,
 * a rig whose menu rate does not match stays silent, closing while a stream is
 * locked is remembered - because those are the rules the transport layer is
 * written against, not a property of Web Serial.  It is typed as the package's
 * own `SerialPortLike`, so contract drift fails `mise run typecheck`.
 */
import type {
  SerialInputSignals,
  SerialLineSettings,
  SerialOutputSignals,
  SerialPortLike,
} from 'hamlib-wasm/raw';
import { fakeRig } from './rigs.js';

/** What the double records while the package drives it. */
export interface FakePortState {
  /** The emulator behind the port. */
  readonly rig: FakeRig;
  /** Line settings the port was opened with, or null before the first open. */
  openedOptions: SerialLineSettings | null;
  openCount: number;
  closeCount: number;
  isOpen: boolean;
  /** True when `close()` found a stream the transport had not released. */
  closedWithLockedStreams: boolean;
  setSignalsCalls: number;
  /** Every signal the transport has driven, accumulated. */
  outputSignals: SerialOutputSignals;
  /** Every command the emulator decoded, without its framing. */
  readonly commands: string[];
}

export interface FakePortControl extends FakePortState {
  /** The port to hand to the package, as an injected transport would. */
  port: SerialPortLike;
  /** Inject bytes into the readable stream without a write. */
  pushRaw(text: string): void;
}

/** ASCII octets of `text`. */
function ascii(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);

  for (let index = 0; index < text.length; index++) {
    bytes[index] = text.charCodeAt(index);
  }

  return bytes;
}

class FakeSerialPort implements SerialPortLike {
  readonly #state: FakePortState;
  #readable: ReadableStream<Uint8Array> | null = null;
  #writable: WritableStream<Uint8Array> | null = null;
  #controller: ReadableStreamDefaultController<Uint8Array> | null = null;

  constructor(state: FakePortState) {
    this.#state = state;
  }

  get readable(): ReadableStream<Uint8Array> | null {
    return this.#readable;
  }

  get writable(): WritableStream<Uint8Array> | null {
    return this.#writable;
  }

  open(settings: SerialLineSettings): Promise<void> {
    if (this.#readable || this.#writable) {
      return Promise.reject(
        new DOMException('The port is already open', 'InvalidStateError'),
      );
    }

    const state = this.#state;

    state.openCount += 1;
    state.openedOptions = { ...settings };
    state.isOpen = true;
    state.rig.reset();
    state.rig.commands.length = 0;

    this.#readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.#controller = controller;
      },
      cancel: () => {
        this.#controller = null;
      },
    });

    this.#writable = new WritableStream<Uint8Array>({
      write: (chunk) => {
        this.#receive(chunk);
      },
    });

    return Promise.resolve();
  }

  close(): Promise<void> {
    if (!this.#readable || !this.#writable) {
      return Promise.reject(
        new DOMException('The port is not open', 'InvalidStateError'),
      );
    }

    if (this.#readable.locked || this.#writable.locked) {
      this.#state.closedWithLockedStreams = true;
      return Promise.reject(
        new DOMException('The port is still locked', 'InvalidStateError'),
      );
    }

    this.#controller = null;
    this.#readable = null;
    this.#writable = null;
    this.#state.isOpen = false;
    this.#state.closeCount += 1;
    return Promise.resolve();
  }

  setSignals(signals: SerialOutputSignals): Promise<void> {
    this.#state.setSignalsCalls += 1;
    this.#state.outputSignals = Object.assign({}, this.#state.outputSignals, signals);
    return Promise.resolve();
  }

  getSignals(): Promise<SerialInputSignals> {
    return Promise.resolve({
      clearToSend: true,
      dataSetReady: true,
      dataCarrierDetect: true,
      ringIndicator: false,
    });
  }

  /** Inject `text` into the readable stream, without a write. */
  pushRaw(text: string): void {
    if (!this.#controller) {
      throw new Error('the fake port is not open');
    }

    this.#controller.enqueue(ascii(text));
  }

  /** Feed host bytes to the emulator and hand its replies to the reader. */
  #receive(chunk: Uint8Array): void {
    const { rig } = this.#state;
    const opened = this.#state.openedOptions;

    /* A rig behind a real UART hears the one rate its own menu is set to.
     * Opened at any other, it stays silent - the failure a rate scan exists to
     * get past, and one no protocol-level answer can report. */
    if (rig.baudRate !== undefined && opened !== null && opened.baudRate !== rig.baudRate) {
      return;
    }

    for (const reply of rig.feed(chunk)) {
      if (rig.state.silent) { continue; }

      this.#controller?.enqueue(reply);
    }
  }
}

/**
 * One emulated rig behind a port that satisfies the package's port contract.
 *
 * The returned control object *is* the state the port mutates - not a copy of
 * it - so a spec reads the counters after the facade has driven the port.
 */
export function fakePort(rigName = 'kenwood-ts480'): FakePortControl {
  const rig = fakeRig(rigName);
  const state: FakePortState = {
    rig,
    openedOptions: null,
    openCount: 0,
    closeCount: 0,
    isOpen: false,
    closedWithLockedStreams: false,
    setSignalsCalls: 0,
    /* Modem lines the transport may drive; the double reads none of them back. */
    outputSignals: {},
    commands: rig.commands,
  };
  const port = new FakeSerialPort(state);
  const control = state as FakePortControl;

  control.port = port;
  control.pushRaw = (text: string): void => {
    port.pushRaw(text);
  };

  return control;
}
