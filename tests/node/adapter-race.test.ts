/**
 * The adapter's own lifecycle rules, with a stubbed `serialport` module.
 *
 * The real bindings are exercised elsewhere; what is under test here is the
 * adapter's ordering - in particular that a close which races an open waits for
 * it instead of returning early and leaving the opened port with no owner.
 */
import { expect, test } from 'vitest';

import { nodeSerialTransport } from 'hamlib-wasm/node';
import type {
  NodeSerialPortOpenOptions,
  SerialPortConstructorLike,
  SerialPortModuleLike,
} from 'hamlib-wasm/node';

/** A `serialport` port whose open completes only when the test says so. */
class DeferredPort {
  static readonly instances: DeferredPort[] = [];

  readonly options: NodeSerialPortOpenOptions;
  closeCalls = 0;
  #completeOpen: ((error?: Error | null) => void) | undefined;

  constructor(options: NodeSerialPortOpenOptions) {
    this.options = options;
    DeferredPort.instances.push(this);
  }

  on(): this {
    return this;
  }

  off(): this {
    return this;
  }

  open(callback: (error?: Error | null) => void): void {
    this.#completeOpen = callback;
  }

  /** Let the pending `open()` callback run. */
  finishOpen(): void {
    this.#completeOpen?.(null);
  }

  close(callback: (error?: Error | null) => void): void {
    this.closeCalls += 1;
    callback(null);
  }

  write(_chunk: Uint8Array, callback: (error?: Error | null) => void): void {
    callback(null);
  }

  set(_options: unknown, callback: (error?: Error | null) => void): void {
    callback(null);
  }

  get(callback: (error: Error | null, status?: { cts: boolean; dsr: boolean; dcd: boolean }) => void): void {
    callback(null, { cts: false, dsr: false, dcd: false });
  }

  static async list(): Promise<readonly []> {
    return [];
  }
}

const module: SerialPortModuleLike = {
  SerialPort: DeferredPort as unknown as SerialPortConstructorLike,
};

test('a close that races the open waits for it and still closes the port', async () => {
  DeferredPort.instances.length = 0;

  const transport = nodeSerialTransport({ serialport: module });
  const port = await transport.requestPort({ path: '/dev/deferred' });
  const opening = port.open({ baudRate: 9600 });
  const closing = port.close();

  const instance = DeferredPort.instances[0];

  if (!instance) {
    throw new Error('the adapter did not construct a port');
  }

  instance.finishOpen();
  await opening;
  await closing;

  /* The port was opened after the close had already started; the close must
   * still have run instead of returning early with `#port` still null. */
  expect(instance.closeCalls).toBe(1);
});

test('reports the lines the bindings assert on open', async () => {
  DeferredPort.instances.length = 0;

  const transport = nodeSerialTransport({ serialport: module });
  const port = await transport.requestPort({ path: '/dev/deferred' });
  const opening = port.open({ baudRate: 9600 });

  DeferredPort.instances[0]?.finishOpen();
  await opening;

  /* `serialport` raises DTR and RTS as it opens; the transport reports that so
   * `ser_get_dtr()`/`ser_get_rts()` agree with the device. */
  expect(port.initialSignals?.()).toEqual({ rts: true, dtr: true });

  await port.close();
});
