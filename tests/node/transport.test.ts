/**
 * The port contract is transport-neutral.
 *
 * Everything the facade does with a port goes through `SerialTransport` and
 * `SerialPortLike`, so an injected transport drives a whole CAT exchange over
 * a plain object.  If this passes, the Node transport in `hamlib-wasm/node` is a
 * second implementation of a contract that already works, not a special case
 * bolted into the facade.
 */
import { afterEach, expect, test } from 'vitest';

import { createRawHamlib, webSerialTransport } from 'hamlib-wasm/raw';
import type { SerialTransport } from 'hamlib-wasm/raw';

import { catalogueModel } from './catalogue.js';
import { fakePort } from './fake-port.js';
import { settle, useRealTime, useVirtualTime } from './virtual-time.js';

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

  const hamlib = await createRawHamlib({ transport });

  try {
    const port = await hamlib.requestPort();
    expect(port).toBe(control.port);
    expect(requested).toBe(1);

    const ts480 = catalogueModel(hamlib.models, 'Kenwood', 'TS-480');

    const rig = await hamlib.open({ modelId: ts480.id, port });

    expect(await rig.getFrequency()).toBe(14_074_000);

    await rig.setFrequency(7_074_000);
    expect(await rig.getFrequency()).toBe(7_074_000);

    await rig.setPtt('on');
    expect(control.state.transmitting).toBe(true);

    await rig.setPtt('off');
    expect(control.state.transmitting).toBe(false);

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
  expect(control.state.frequency).toBe(7_074_000);
});

test('refuses a request the Web Serial transport cannot serve', async () => {
  const hamlib = await createRawHamlib({ transport: webSerialTransport() });

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

afterEach(() => {
  useRealTime();
});

/* The watchdog is a timer, so this runs on virtual time: the open is bounded
 * after exactly 150 ms of it, however long the machine takes to get there. */
test('bounds a call that never settles and refuses the instance afterwards', async () => {
  useVirtualTime();

  /* An open that never settles is what a dead port looks like from the
   * module's side. */
  const control = fakePort();
  control.holdNextOpen = true;

  const transport: SerialTransport = {
    name: 'hung',
    isSupported: () => true,
    requestPort: async () => control.port,
  };

  const hamlib = await createRawHamlib({ transport, callTimeoutMs: 150 });

  try {
    const ts480 = catalogueModel(hamlib.models, 'Kenwood', 'TS-480');

    const failure = await settle(hamlib.open({ modelId: ts480.id, port: control.port }).then(
      () => null,
      (error: unknown) => error as { code?: string },
    ));

    expect(control.openPending).toBe(true);
    expect(failure?.code).toBe('RIG_TIMEOUT');

    /* The suspended native stack cannot be re-entered: the next call fails
     * fast instead of queueing behind it. */
    const after = await settle(hamlib.open({ modelId: ts480.id, port: control.port }).then(
      () => null,
      (error: unknown) => error as { code?: string },
    ));

    expect(after?.code).toBe('RIG_HUNG');
  } finally {
    /* dispose must settle even though the native stack is still suspended,
     * and must release the port from the JavaScript side. */
    await settle(hamlib.dispose());
  }

  expect(control.closeRequests).toBe(1);
});

test('close releases the rig and its port, which then opens again', async () => {
  const control = fakePort();

  const transport: SerialTransport = {
    name: 'test',
    isSupported: () => true,
    requestPort: async () => control.port,
  };

  const hamlib = await createRawHamlib({ transport });

  try {
    const ts480 = catalogueModel(hamlib.models, 'Kenwood', 'TS-480');

    const rig = await hamlib.open({ modelId: ts480.id, port: control.port });
    expect(hamlib.diagnostics().rigs).toHaveLength(1);
    expect(control.isOpen).toBe(true);

    await rig.close();
    expect(hamlib.diagnostics().rigs).toEqual([]);
    expect(control.isOpen).toBe(false);
    expect(control.closeCount).toBe(1);
    expect(control.closedWithLockedStreams).toBe(false);

    /* Nothing of the first rig holds the port: the same instance opens it again. */
    const again = await hamlib.open({ modelId: ts480.id, port: control.port });
    expect(await again.getFrequency()).toBe(14_074_000);
    await again.close();
  } finally {
    await hamlib.dispose();
  }

  expect(control.openCount).toBe(2);
  expect(control.isOpen).toBe(false);
});

test('close unregisters the port path, so connect cycles leave nothing behind', async () => {
  const control = fakePort();

  const transport: SerialTransport = {
    name: 'test',
    isSupported: () => true,
    requestPort: async () => control.port,
  };

  const hamlib = await createRawHamlib({ transport });

  try {
    const ts480 = catalogueModel(hamlib.models, 'Kenwood', 'TS-480');

    for (let cycle = 0; cycle < 3; cycle++) {
      const rig = await hamlib.open({ modelId: ts480.id, port: control.port });
      expect(hamlib.diagnostics().ports).toHaveLength(1);

      await rig.close();
      expect(hamlib.diagnostics().ports).toEqual([]);
    }
  } finally {
    await hamlib.dispose();
  }

  expect(control.openCount).toBe(3);
});
