// SPDX-License-Identifier: MIT

/**
 * hamlib-wasm/node - the `serialport` transport, for Node and Electron.
 *
 * The same package, the same Hamlib build and the same catalogue as the
 * browser entries, with a transport that opens an operating system device
 * instead of asking a page for one.  This is the entry point an Electron main
 * process, a CLI or a test uses; a browser (and an Electron renderer, which is
 * one) keeps the default Web Serial transport.
 *
 * `serialport` is an optional peer dependency and is imported lazily: at the
 * first {@link NodeSerialTransport.requestPort} or
 * {@link NodeSerialTransport.listPorts} call, never at module load, so a
 * browser bundler never sees it and an application that only runs in a page
 * installs nothing.  Nothing in the emitted declarations mentions the package
 * either - the adapter's shapes are this file's own.
 *
 * ```ts
 * import { createHamlib } from 'hamlib-wasm/hamlib';
 * import { nodeSerialTransport } from 'hamlib-wasm/node';
 *
 * const transport = nodeSerialTransport();
 * const hamlib = await createHamlib({ transport });
 * const port = await transport.requestPort({ path: '/dev/tty.usbserial-1410' });
 * const rig = await hamlib.open({ modelId, port, baudRate: 9600 });
 * ```
 *
 * The default `serialport` version is `13`; `nodeSerialTransport({ serialport })`
 * takes any module with a compatible `SerialPort` class, which is the seam for
 * a different binding or a replacement implementation.
 */

import { HamlibError } from './errors.js';
import type {
  PortRequest,
  SerialInputSignals,
  SerialLineSettings,
  SerialOutputSignals,
  SerialPortLike,
  SerialTransport,
} from './transport.js';

/* ------------------------------------------------------------------ */
/* shapes the adapter asks of `serialport`                             */
/* ------------------------------------------------------------------ */

/** One entry of `serialport`'s `SerialPort.list()`, as this package reports it. */
export interface NodeSerialPortListEntry {
  path: string;
  manufacturer?: string;
  serialNumber?: string;
  pnpId?: string;
  locationId?: string;
  vendorId?: string;
  productId?: string;
}

/**
 * Options a port is constructed with.  `serialport`'s own `OpenOptions`.
 *
 * `parity` is the transport contract's narrower set: the platform bindings
 * accept nothing else outside Windows, and the package never asks for
 * mark/space parity anyway (see `ws_validate_config`).
 */
export interface NodeSerialPortOpenOptions {
  path: string;
  baudRate: number;
  dataBits?: 5 | 6 | 7 | 8;
  stopBits?: 1 | 1.5 | 2;
  parity?: 'none' | 'even' | 'odd';
  rtscts?: boolean;
  autoOpen?: boolean;
}

/** Control flags one `set()` call applies.  Every flag is set on every call. */
export interface NodeSetOptions {
  brk?: boolean;
  cts?: boolean;
  dsr?: boolean;
  dtr?: boolean;
  rts?: boolean;
}

/** Input lines `get()` reports.  There is no RI, so the package reports `false`. */
export interface NodeModemStatus {
  cts: boolean;
  dsr: boolean;
  dcd: boolean;
}

/**
 * One `serialport` port, as far as this adapter uses it.
 *
 * Every method takes a callback; without one `serialport` reports through an
 * `'error'` event instead, which would be an unhandled error in the middle of
 * a CAT transaction.
 */
export interface NodeSerialPortLike {
  on(event: 'data', listener: (chunk: Uint8Array) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'close', listener: (error?: Error | null) => void): unknown;
  off(event: 'data', listener: (chunk: Uint8Array) => void): unknown;
  off(event: 'error', listener: (error: Error) => void): unknown;
  off(event: 'close', listener: (error?: Error | null) => void): unknown;
  open(callback: (error?: Error | null) => void): unknown;
  close(callback: (error?: Error | null) => void): unknown;
  write(chunk: Uint8Array, callback: (error?: Error | null) => void): unknown;
  set(options: NodeSetOptions, callback: (error?: Error | null) => void): unknown;
  /** The status is optional in `serialport`'s own callback type. */
  get(callback: (error: Error | null, status?: NodeModemStatus) => void): unknown;
}

/** The `SerialPort` class, as this adapter constructs and enumerates it. */
export interface SerialPortConstructorLike {
  new (options: NodeSerialPortOpenOptions): NodeSerialPortLike;
  list(): Promise<readonly NodeSerialPortListEntry[]>;
}

/** What `hamlib-wasm/node` needs from the `serialport` module. */
export interface SerialPortModuleLike {
  SerialPort: SerialPortConstructorLike;
}

export interface NodeSerialTransportOptions {
  /**
   * Override the `serialport` module (tests, a different binding).
   * Defaults to `await import('serialport')`.
   */
  serialport?: SerialPortModuleLike;
}

export interface NodeSerialTransport extends SerialTransport {
  /** Ports the operating system reports, as `serialport`'s `SerialPort.list()`. */
  listPorts(): Promise<readonly NodeSerialPortListEntry[]>;
}

/* ------------------------------------------------------------------ */
/* module loading                                                      */
/* ------------------------------------------------------------------ */

/**
 * Load `serialport`, or the caller's replacement.
 *
 * Deliberately a function and a dynamic import: the module is loaded on the
 * first port request, so `hamlib-wasm/node` itself imports under any runtime and
 * a missing optional dependency is a clear error at the call that needed it.
 */
async function loadSerialPortModule(
  options: NodeSerialTransportOptions,
): Promise<SerialPortModuleLike> {
  if (options.serialport) {
    return options.serialport;
  }

  let imported: {
    SerialPort?: SerialPortConstructorLike;
    default?: { SerialPort?: SerialPortConstructorLike };
  };

  try {
    /* `serialport` 13 is CommonJS without an export map, so under Node's ESM
     * loader the class appears both as the module's own `SerialPort` and as
     * `default.SerialPort`; accept either. */
    imported = (await import('serialport')) as unknown as typeof imported;
  } catch (cause) {
    throw new HamlibError(
      "the 'serialport' package is required for the Node transport; "
      + 'install it with `npm install serialport`',
      { code: 'TRANSPORT_UNAVAILABLE', operation: 'requestPort', cause },
    );
  }

  const SerialPort = imported.SerialPort ?? imported.default?.SerialPort;

  if (!SerialPort) {
    throw new HamlibError(
      "the 'serialport' package does not export a SerialPort class",
      { code: 'TRANSPORT_UNAVAILABLE', operation: 'requestPort' },
    );
  }

  return { SerialPort };
}

/* ------------------------------------------------------------------ */
/* the port adapter                                                    */
/* ------------------------------------------------------------------ */

/** An error a callback reports, before it is mapped to a `HamlibError`. */
type NodeError = Error & { readonly code?: unknown };

function toHamlibError(error: NodeError, context: string): Error {
  const message = error.message || String(error);
  const code = typeof error.code === 'string' ? error.code : undefined;

  /* `$HamlibWs.fail()` classifies failures by `name` and turns them into
   * Hamlib codes, so the name is what has to carry the meaning here:
   * NotFoundError → -RIG_EINVAL, SecurityError → -RIG_EACCESS,
   * TypeError → -RIG_ECONF, anything else → -RIG_EIO. */
  let name = error.name;

  if (code === 'ENOENT' || code === 'ENXIO') {
    name = 'NotFoundError';
  } else if (code === 'EACCES' || code === 'EPERM' || code === 'EBUSY') {
    name = 'SecurityError';
  } else if (code === 'EINVAL') {
    name = 'TypeError';
  }

  /* A new error, not the original: the original's `name` may still be read by
   * a caller that only sees `cause`. */
  return Object.assign(new Error(`${context} failed: ${message}`), {
    name,
    cause: error,
  });
}

/** The port's event listeners, kept so they can be removed again. */
interface PortListeners {
  readonly data: (chunk: Uint8Array) => void;
  readonly error: (failure: Error) => void;
  readonly close: (failure?: Error | null) => void;
}

/**
 * One `serialport` port behind the package's port contract.
 *
 * The device is opened by `open()`, not by construction, because the line
 * settings come from the rig the caller is about to open.  A `serialport` port
 * cannot be reopened after `close()`, so each open builds a fresh one - which
 * is also what makes Hamlib's own baud-rate reconfiguration (close + open)
 * work.
 */
class NodeSerialPortAdapter implements SerialPortLike {
  readonly #path: string;
  readonly #SerialPort: SerialPortConstructorLike;

  #port: NodeSerialPortLike | null = null;
  #readable: ReadableStream<Uint8Array> | null = null;
  #writable: WritableStream<Uint8Array> | null = null;
  #listeners: PortListeners | null = null;
  /** The in-flight open, so a concurrent close waits for it instead of no-oping. */
  #opening: Promise<void> | null = null;
  /** The complete output state `set()` applies; `serialport` resets the flags a
   * call leaves out, so every flag is always sent.  These are also what the
   * adapter asserts on open, which is what `initialSignals()` reports. */
  #output: NodeSetOptions = { brk: false, cts: false, dtr: true, rts: true };

  constructor(path: string, SerialPort: SerialPortConstructorLike) {
    this.#path = path;
    this.#SerialPort = SerialPort;
  }

  /** The device path this adapter was asked for.  For diagnostics only. */
  get path(): string {
    return this.#path;
  }

  get readable(): ReadableStream<Uint8Array> | null {
    return this.#readable;
  }

  get writable(): WritableStream<Uint8Array> | null {
    return this.#writable;
  }

  async open(settings: SerialLineSettings): Promise<void> {
    if (this.#port || this.#opening) {
      throw new HamlibError('the port is already open', {
        code: 'INVALID_ARGUMENT',
        operation: 'open',
      });
    }

    const port = new this.#SerialPort({
      path: this.#path,
      baudRate: settings.baudRate,
      dataBits: settings.dataBits ?? 8,
      stopBits: settings.stopBits ?? 1,
      parity: settings.parity ?? 'none',
      rtscts: settings.flowControl === 'hardware',
      /* The package decides when the port is open: it has to attach the stream
       * listeners before any byte can arrive. */
      autoOpen: false,
    });

    const opening = this.#call<void>((callback) => port.open(callback), 'open').then(() => {
      this.#port = port;
      this.#output = { brk: false, cts: false, dtr: true, rts: true };
      this.#attach(port);
    });

    this.#opening = opening;

    try {
      await opening;
    } finally {
      if (this.#opening === opening) {
        this.#opening = null;
      }
    }
  }

  async close(): Promise<void> {
    /* A close that races the open must not be a no-op: without this wait the
     * opened port would be assigned after the early return and leak. */
    const opening = this.#opening;

    if (opening) {
      try {
        await opening;
      } catch {
        /* The open failed; there is no port to close. */
      }
    }

    const port = this.#port;

    if (!port) {
      return;
    }

    this.#detach(port);
    this.#port = null;

    try {
      await this.#call<void>((callback) => port.close(callback), 'close');
    } finally {
      /* A closed `serialport` port cannot be reopened, so the streams that fed
       * it are released even when the close reported an error. */
      this.#readable = null;
      this.#writable = null;
    }
  }

  /**
   * The lines `serialport` asserts as it opens.
   *
   * `serialport`'s bindings raise DTR and RTS on open; reporting that is what
   * makes `ser_get_dtr()`/`ser_get_rts()` agree with the device instead of
   * claiming both deasserted.
   */
  initialSignals(): { rts: boolean; dtr: boolean } {
    return { rts: this.#output.rts === true, dtr: this.#output.dtr === true };
  }

  async setSignals(signals: SerialOutputSignals): Promise<void> {
    const port = this.#require('setSignals');

    if (signals.requestToSend !== undefined) {
      this.#output.rts = signals.requestToSend;
    }

    if (signals.dataTerminalReady !== undefined) {
      this.#output.dtr = signals.dataTerminalReady;
    }

    if (signals.break !== undefined) {
      this.#output.brk = signals.break;
    }

    await this.#call<void>(
      (callback) => port.set({ ...this.#output }, callback),
      'setSignals',
    );
  }

  async getSignals(): Promise<SerialInputSignals> {
    const port = this.#require('getSignals');
    const status = await this.#call<NodeModemStatus | undefined>(
      (callback) => port.get(callback),
      'getSignals',
    );

    return {
      clearToSend: Boolean(status?.cts),
      dataSetReady: Boolean(status?.dsr),
      dataCarrierDetect: Boolean(status?.dcd),
      /* `serialport` reports CTS, DSR and DCD only; there is no ring indicator
       * to read, so the contract's "false when a line cannot be read" applies. */
      ringIndicator: false,
    };
  }

  /* --- internals ------------------------------------------------------ */

  #require(operation: string): NodeSerialPortLike {
    if (!this.#port) {
      throw new HamlibError('the port is not open', {
        code: 'INVALID_ARGUMENT',
        operation,
      });
    }

    return this.#port;
  }

  /**
   * Wire the port's events to the stream halves.
   *
   * The listeners are attached once, directly after a successful open, and are
   * removed by {@link #detach} before the port is closed - so closing a port
   * the library has stopped reading cannot push an error into a stream nobody
   * is holding any more.  The readable half is fed from `'data'`; the writable
   * half converts every chunk to a real `Buffer`, which is what the bindings
   * require.
   */
  #attach(port: NodeSerialPortLike): void {
    /* `ReadableStream` runs `start` synchronously, so `controller` is available
     * before the listeners below can fire. */
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    let live = true;

    const data = (chunk: Uint8Array): void => {
      if (!live) { return; }

      controller?.enqueue(chunk);
    };
    const error = (failure: Error): void => {
      if (!live) { return; }

      live = false;
      controller?.error(failure);
    };
    const close = (failure?: Error | null): void => {
      if (!live) { return; }

      live = false;

      if (failure) {
        controller?.error(failure);
      } else {
        controller?.close();
      }
    };

    const readable = new ReadableStream<Uint8Array>({
      start: (streamController) => {
        controller = streamController;
      },
      cancel: () => {
        /* The library cancels the reader before it closes the port, so nothing
         * here may touch the port: it only stops feeding the stream. */
        live = false;
      },
    });

    const writable = new WritableStream<Uint8Array>({
      write: async (chunk) => {
        await this.#call<void>(
          (callback) => port.write(Buffer.from(chunk), callback),
          'write',
        );
      },
    });

    port.on('data', data);
    port.on('error', error);
    port.on('close', close);

    this.#listeners = { data, error, close };
    this.#readable = readable;
    this.#writable = writable;
  }

  /** Remove the listeners this adapter installed on `port`, if any. */
  #detach(port: NodeSerialPortLike): void {
    const listeners = this.#listeners;
    this.#listeners = null;

    if (!listeners) { return; }

    port.off('data', listeners.data);
    port.off('error', listeners.error);
    port.off('close', listeners.close);
  }

  /**
   * Run one callback-style `serialport` call as a promise.
   *
   * The callback is always provided: without one `serialport` reports the
   * failure on the port's `'error'` event, which is an unhandled error unless
   * somebody happens to be listening.
   */
  #call<T>(
    invoke: (callback: (error: Error | null | undefined, value?: T) => void) => unknown,
    context: string,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      invoke((error, value) => {
        if (error) {
          reject(toHamlibError(error, context));
          return;
        }

        resolve(value as T);
      });
    });
  }
}

/* ------------------------------------------------------------------ */
/* the transport                                                       */
/* ------------------------------------------------------------------ */

/** The Node transport: ports come from the `serialport` package. */
export function nodeSerialTransport(
  options: NodeSerialTransportOptions = {},
): NodeSerialTransport {
  /** Resolved once, so a module failure is reported at the call that needed it. */
  let modulePromise: Promise<SerialPortModuleLike> | null = null;

  const module = (): Promise<SerialPortModuleLike> => {
    modulePromise ??= loadSerialPortModule(options);
    return modulePromise;
  };

  return {
    name: 'serialport',

    isSupported(): boolean {
      return typeof process === 'object' && typeof process.versions?.node === 'string';
    },

    async requestPort(request?: PortRequest): Promise<SerialPortLike> {
      const path = request?.path;

      if (path === undefined || path === '') {
        throw new HamlibError(
          'the Node transport opens the path it is given; pass requestPort({ path }) '
          + 'with one of listPorts()',
          { code: 'INVALID_ARGUMENT', operation: 'requestPort' },
        );
      }

      const { SerialPort } = await module();

      return new NodeSerialPortAdapter(path, SerialPort);
    },

    async listPorts(): Promise<readonly NodeSerialPortListEntry[]> {
      const { SerialPort } = await module();

      return SerialPort.list();
    },
  };
}
