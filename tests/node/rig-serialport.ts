/**
 * A `serialport` module backed by an emulated rig, for the Node transport spec.
 *
 * The adapter is exercised against the *real* `SerialPortStream` from
 * `@serialport/stream` - the same class `serialport`'s own `SerialPort` and
 * `SerialPortMock` build on - wired to a binding that drives the emulated rigs
 * from tests/browser/fixtures/rigs.ts.  That is what makes the assertions
 * meaningful: the queueing, the `set()` flag merging and the `Buffer`
 * expectation the adapter has to satisfy are `@serialport/stream`'s, not a
 * mock's restatement of them.
 *
 * Only two things differ from `@serialport/binding-mock`: reads resolve from
 * the emulator's replies instead of a queue a test pushes into, and the
 * emulator is silenced when the rig's own menu rate is not the rate the port
 * was opened at.
 */
import { SerialPortStream } from '@serialport/stream';
import type {
  BindingInterface,
  BindingPortInterface,
  OpenOptions,
  PortInfo,
  PortStatus,
  SetOptions,
  UpdateOptions,
} from '@serialport/bindings-interface';
import type {
  NodeSerialPortOpenOptions,
  SerialPortModuleLike,
} from 'hamlib-wasm/node';
import { fakeRig } from './rigs.js';

/** The device path the emulated rig is reachable at. */
export const FAKE_PATH = '/dev/fake-ts480';

/** The entry `list()` reports for it. */
function fakePortInfo(): PortInfo {
  return {
    path: FAKE_PATH,
    manufacturer: 'Emulated',
    serialNumber: undefined,
    pnpId: undefined,
    locationId: undefined,
    vendorId: '1a86',
    productId: '7523',
  };
}

/** One open port, as `@serialport/stream` drives it. */
class RigBindingPort implements BindingPortInterface {
  readonly openOptions: Required<OpenOptions>;
  readonly rig: FakeRig;

  isOpen = true;
  /** Every `set()` this port received, in order. */
  readonly setCalls: SetOptions[] = [];
  /** Every write this port received, as a copy. */
  readonly writes: Buffer[] = [];
  /** What `get()` reports; CTS and DCD asserted, DSR clear. */
  status: PortStatus = { cts: true, dsr: false, dcd: true };

  #replies: Buffer[] = [];
  #pendingRead: ((error?: Error) => void) | null = null;
  #unplugged = false;

  constructor(rig: FakeRig, openOptions: Required<OpenOptions>) {
    this.rig = rig;
    this.openOptions = openOptions;
  }

  /**
   * Pull the cable, as a real device does it: the pending read fails without
   * `canceled`, which `@serialport/stream` reports as a disconnect (`'close'`
   * with a `DisconnectedError`), and a write to the vanished device never
   * completes - what the macOS binding did with a QMX+ unplugged mid-poll.
   */
  unplug(): void {
    this.#unplugged = true;
    this.#pendingRead?.(new Error('device not configured'));
    this.#pendingRead = null;
  }

  async close(): Promise<void> {
    if (!this.isOpen) {
      throw new Error('Port is not open');
    }

    this.isOpen = false;
    this.#replies = [];

    /* An in-flight read has to fail with `canceled`, or the stream treats the
     * close as a disconnect. */
    this.#pendingRead?.(Object.assign(new Error('Read canceled'), { canceled: true }));
    this.#pendingRead = null;
  }

  async read(
    buffer: Buffer,
    offset: number,
    length: number,
  ): Promise<{ buffer: Buffer; bytesRead: number }> {
    if (!Buffer.isBuffer(buffer)) {
      throw new TypeError('"buffer" is not a Buffer');
    }

    if (!this.isOpen) {
      throw new Error('Port is not open');
    }

    if (this.#unplugged) {
      throw new Error('device not configured');
    }

    const head = this.#replies[0];

    if (!head) {
      return new Promise((resolve, reject) => {
        this.#pendingRead = (error?: Error): void => {
          if (error) {
            reject(error);
            return;
          }

          this.read(buffer, offset, length).then(resolve, reject);
        };
      });
    }

    const taken = Math.min(head.length, length);
    const bytesRead = head.copy(buffer, offset, 0, taken);

    if (taken === head.length) {
      this.#replies.shift();
    } else {
      this.#replies[0] = head.subarray(taken);
    }

    return { buffer, bytesRead };
  }

  async write(buffer: Buffer): Promise<void> {
    /* The adapter converts every chunk to a real `Buffer` before it gets here;
     * the real bindings reject anything else. */
    if (!Buffer.isBuffer(buffer)) {
      throw new TypeError('"buffer" is not a Buffer');
    }

    if (!this.isOpen) {
      throw new Error('Port is not open');
    }

    if (this.#unplugged) {
      return new Promise<void>(() => { /* never: the device is gone */ });
    }

    this.writes.push(Buffer.from(buffer));

    /* A rig behind a real UART hears the one rate its own menu is set to, so a
     * port opened at any other sees nothing at all. */
    const { baudRate } = this.rig;

    if (baudRate !== undefined && baudRate !== this.openOptions.baudRate) {
      return;
    }

    for (const reply of this.rig.feed(buffer)) {
      this.#deliver(Buffer.from(reply));
    }
  }

  async update(options: UpdateOptions): Promise<void> {
    this.openOptions.baudRate = options.baudRate;
  }

  async set(options: SetOptions): Promise<void> {
    this.setCalls.push({ ...options });
  }

  async get(): Promise<PortStatus> {
    return { ...this.status };
  }

  async getBaudRate(): Promise<{ baudRate: number }> {
    return { baudRate: this.openOptions.baudRate };
  }

  async flush(): Promise<void> {
    this.#replies = [];
  }

  async drain(): Promise<void> {
    /* Writes complete before they resolve; nothing is buffered here. */
  }

  #deliver(chunk: Buffer): void {
    this.#replies.push(chunk);

    const pending = this.#pendingRead;
    this.#pendingRead = null;
    pending?.();
  }
}

/** The emulated-rig binding, with the port it handed out last. */
export interface RigBinding extends BindingInterface<RigBindingPort> {
  /** Options the last `open()` was called with, as the stream passed them. */
  lastOpenOptions: OpenOptions | null;
  /** The port the last successful `open()` returned. */
  port: RigBindingPort | null;
}

/** A `serialport` binding that answers as one of the emulated rigs. */
export function rigBinding(rigName = 'kenwood-ts480'): RigBinding {
  const rig = fakeRig(rigName);

  return {
    lastOpenOptions: null,
    port: null,

    async list(): Promise<PortInfo[]> {
      return [fakePortInfo()];
    },

    async open(options: OpenOptions): Promise<RigBindingPort> {
      if (!options || typeof options !== 'object' || Array.isArray(options)) {
        throw new TypeError('"options" is not an object');
      }

      if (!options.path) {
        throw new TypeError('"path" is not a valid port');
      }

      if (!options.baudRate) {
        throw new TypeError('"baudRate" is not a valid baudRate');
      }

      const port = new RigBindingPort(rig, {
        dataBits: 8,
        lock: true,
        stopBits: 1,
        parity: 'none',
        rtscts: false,
        xon: false,
        xoff: false,
        xany: false,
        hupcl: true,
        ...options,
      });

      this.lastOpenOptions = { ...options };
      this.port = port;
      return port;
    },
  };
}

/** A `serialport` module whose ports drive the emulated rig. */
export interface RigSerialPortModule extends SerialPortModuleLike {
  /** The binding behind every port the module hands out. */
  readonly binding: RigBinding;
  /** The options each constructed port was built with. */
  readonly constructed: NodeSerialPortOpenOptions[];
}

/**
 * The `serialport` module surface, backed by {@link rigBinding}.
 *
 * Structurally a `serialport` module - `SerialPort` is a real
 * `SerialPortStream` subclass that injects the binding, exactly as
 * `serialport`'s own class injects the detected one - with the records a spec
 * needs to see what the adapter actually asked for.
 */
export function rigSerialPortModule(rigName = 'kenwood-ts480'): RigSerialPortModule {
  const binding = rigBinding(rigName);
  const constructed: NodeSerialPortOpenOptions[] = [];

  class RigSerialPort extends SerialPortStream<RigBinding> {
    static list(): Promise<readonly PortInfo[]> {
      return binding.list();
    }

    constructor(options: NodeSerialPortOpenOptions, openCallback?: (error?: Error | null) => void) {
      /* The adapter never passes `binding`: the class injects its own, the way
       * `serialport`'s `SerialPort` injects the detected binding. */
      constructed.push({ ...options });
      super({ ...options, binding }, openCallback);
    }
  }

  return { SerialPort: RigSerialPort, binding, constructed };
}
