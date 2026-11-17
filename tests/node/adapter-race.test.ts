/**
 * The adapter's own lifecycle rules, through the emulated-rig `serialport`
 * module.
 *
 * What is under test is the adapter's ordering - in particular that a close
 * which races an open waits for it instead of returning early and leaving the
 * opened port with no owner.  The binding holds the open at a gate, so the
 * race is set up exactly rather than by timing.
 */
import { expect, test } from 'vitest';

import { nodeSerialTransport } from 'hamlib-wasm/node';

import { rigSerialPortModule } from './rig-serialport.js';

test('a close that races the open waits for it and still closes the port', async () => {
  const module = rigSerialPortModule();
  const transport = nodeSerialTransport({ serialport: module });
  const port = await transport.requestPort({ path: module.path });

  module.binding.holdNextOpen();

  const opening = port.open({ baudRate: 9600 });
  const closing = port.close();

  module.binding.releaseOpen();
  await opening;
  await closing;

  /* The port was opened after the close had already started; the close must
   * still have run instead of returning early with `#port` still null.  A
   * second close of the binding port would have thrown. */
  expect(module.binding.port).not.toBeNull();
  expect(module.binding.port?.isOpen).toBe(false);
});

test('reports the lines the bindings assert on open', async () => {
  const module = rigSerialPortModule();
  const transport = nodeSerialTransport({ serialport: module });
  const port = await transport.requestPort({ path: module.path });

  await port.open({ baudRate: 9600 });

  /* `serialport` raises DTR and RTS as it opens; the transport reports that so
   * `ser_get_dtr()`/`ser_get_rts()` agree with the device. */
  expect(port.initialSignals?.()).toEqual({ rts: true, dtr: true });

  await port.close();
});
