/**
 * The port contract is transport-neutral.
 *
 * Everything the facade does with a port goes through `SerialTransport` and
 * `SerialPortLike`, so an injected transport drives a whole CAT exchange over
 * a plain object.  If this passes, the Node transport in `hamlib-wasm/node` is a
 * second implementation of a contract that already works, not a special case
 * bolted into the facade.
 */
import { expect, test } from 'vitest';

import { createHamlib, webSerialTransport } from 'hamlib-wasm/hamlib';
import type { SerialTransport } from 'hamlib-wasm/hamlib';

import { fakePort } from './fake-port.js';

test('drives a rig through a caller-supplied transport and port', async () => {
  const control = fakePort();
  let requested = 0;

  const transport: SerialTransport = {
    name: 'test',
    isSupported: () => true,
    requestPort: async () => {
      requested += 1;
      return control.port;
    },
  };

  const hamlib = await createHamlib({ transport });

  try {
    const port = await hamlib.requestPort();
    expect(port).toBe(control.port);
    expect(requested).toBe(1);

    const ts480 = hamlib.models.find(
      (model) => model.manufacturer === 'Kenwood' && model.model === 'TS-480',
    );

    if (!ts480) {
      throw new Error('the TS-480 model is missing');
    }

    const rig = await hamlib.open({ modelId: ts480.id, port });

    expect(await rig.getFrequency()).toBe(14_074_000);

    await rig.setFrequency(7_074_000);
    expect(await rig.getFrequency()).toBe(7_074_000);

    await rig.setPtt('on');
    expect(control.rig.state.transmitting).toBe(true);

    await rig.setPtt('off');
    expect(control.rig.state.transmitting).toBe(false);

    expect(rig.connected).toBe(true);
    await rig.close();
    expect(rig.connected).toBe(false);
  } finally {
    await hamlib.dispose();
  }

  /* One open, one clean close, and nothing left locked. */
  expect(control.openCount).toBe(1);
  expect(control.closeCount).toBe(1);
  expect(control.isOpen).toBe(false);
  expect(control.closedWithLockedStreams).toBe(false);

  /* The rig really answered: the commands reached the emulator. */
  expect(control.commands).toContain('ID');
  expect(control.commands).toContain('FA00007074000');
  expect(control.rig.state.frequency).toBe(7_074_000);
});

test('refuses a request the Web Serial transport cannot serve', async () => {
  const hamlib = await createHamlib({ transport: webSerialTransport() });

  try {
    expect(webSerialTransport().isSupported()).toBe(false);

    const failure = await hamlib.requestPort({ path: '/dev/x' }).then(
      () => null,
      (error: unknown) => error as { code?: string; message?: string },
    );

    expect(failure?.code).toBe('TRANSPORT_UNAVAILABLE');

    /* A `path` is not a Web Serial request in any runtime: the browser chooses
     * the port, so the transport refuses the argument itself - which is why
     * this is checkable here, with no browser at all. */
    const byPath = await webSerialTransport().requestPort({ path: '/dev/x' }).then(
      () => null,
      (error: unknown) => error as { code?: string; message?: string },
    );

    expect(byPath?.code).toBe('INVALID_ARGUMENT');
    expect(byPath?.message).toContain('path');
  } finally {
    await hamlib.dispose();
  }
});
