// SPDX-License-Identifier: MIT

/**
 * The serial port contract this package drives.
 *
 * One device, as the facade sees it, whatever talks to it underneath: the
 * browser's Web Serial API (`src/web-serial.ts`) or the
 * `serialport` package behind `hamlib-wasm/node` (`src/node.ts`).  Everything
 * below is structural - a DOM `SerialPort` satisfies {@link SerialPortLike}
 * as it stands, so the browser transport needs no adapter - and it mirrors the
 * ambient declarations the Emscripten library compiles against
 * (`native/emscripten-globals.d.ts`, which cannot import this file).
 */

/** Line settings a transport opens a port with.  Field names are Web Serial's. */
export interface SerialLineSettings {
  baudRate: number;
  dataBits?: 7 | 8;
  stopBits?: 1 | 2;
  parity?: 'none' | 'even' | 'odd';
  flowControl?: 'none' | 'hardware';
  /** Web Serial read-buffer hint; transports without that notion ignore it. */
  bufferSize?: number;
}

export interface SerialOutputSignals {
  requestToSend?: boolean;
  dataTerminalReady?: boolean;
  break?: boolean;
}

/** Input lines.  A line a transport cannot read is reported `false`. */
export interface SerialInputSignals {
  clearToSend: boolean;
  dataSetReady: boolean;
  dataCarrierDetect: boolean;
  ringIndicator: boolean;
}

export interface SerialPortInfo {
  usbVendorId?: number;
  usbProductId?: number;
}

/**
 * One device, as this package drives it.  A Web Serial `SerialPort` satisfies
 * this structurally; so does the Node adapter in `src/node.ts`.
 */
export interface SerialPortLike {
  open(settings: SerialLineSettings): Promise<void>;
  close(): Promise<void>;
  readonly readable: ReadableStream<Uint8Array> | null;
  readonly writable: WritableStream<Uint8Array> | null;
  setSignals(signals: SerialOutputSignals): Promise<void>;
  getSignals(): Promise<SerialInputSignals>;
  getInfo?(): SerialPortInfo;
}

/** Port chooser filters, as Web Serial's `SerialPortFilter` declares them. */
export interface PortFilter {
  usbVendorId?: number;
  usbProductId?: number;
  bluetoothServiceClassId?: number | string;
}

/** What a caller can say when asking for a port.  Transport specific. */
export interface PortRequest {
  /** Web Serial only: filters for the browser's chooser. */
  filters?: readonly PortFilter[];
  /** Node only: the device path to open, e.g. `/dev/tty.usbserial-1410` or `COM3`. */
  path?: string;
}

/** Acquires ports.  Implementations: `webSerialTransport()` and `nodeSerialTransport()`; `createHamlib` selects between them by runtime. */
export interface SerialTransport {
  /** Human readable name used in error messages, e.g. `"Web Serial"`. */
  readonly name: string;
  /** True when this runtime can drive the transport. */
  isSupported(): boolean;
  /**
   * Ask the caller-visible source for a port.  Rejects with
   * `INVALID_ARGUMENT` for a request this transport cannot serve, and with
   * `TRANSPORT_UNAVAILABLE` when it cannot run here at all.
   */
  requestPort(request?: PortRequest): Promise<SerialPortLike>;
}
