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
import type { SerialPortLike, SerialTransport } from 'hamlib-wasm/raw';

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

/**
 * A transport that never settles, which is what a dead port looks like from
 * the module's side.
 */
function neverSettles(): {
  readonly port: SerialPortLike;
  readonly closed: () => boolean;
  readonly openStarted: () => boolean;
} {
  let closed = false;
  let started = false;

  const port: SerialPortLike = {
    get readable(): null {
      return null;
    },
    get writable(): null {
      return null;
    },
    open: () => {
      started = true;
      return new Promise(() => {});
    },
    close: async () => {
      closed = true;
    },
    setSignals: async () => {},
    getSignals: async () => ({
      clearToSend: false,
      dataSetReady: false,
      dataCarrierDetect: false,
      ringIndicator: false,
    }),
  };

  return { port, closed: () => closed, openStarted: () => started };
}

afterEach(() => {
  useRealTime();
});

/* The watchdog is a timer, so this runs on virtual time: the open is bounded
 * after exactly 150 ms of it, however long the machine takes to get there. */
test('bounds a call that never settles and refuses the instance afterwards', async () => {
  useVirtualTime();

  const control = neverSettles();

  const transport: SerialTransport = {
    name: 'hung',
    isSupported: () => true,
    requestPort: async () => control.port,
  };

  const hamlib = await createRawHamlib({ transport, callTimeoutMs: 150 });

  try {
    const ts480 = hamlib.models.find(
      (model) => model.manufacturer === 'Kenwood' && model.model === 'TS-480',
    );

    if (!ts480) {
      throw new Error('the TS-480 model is missing');
    }

    const failure = await settle(hamlib.open({ modelId: ts480.id, port: control.port }).then(
      () => null,
      (error: unknown) => error as { code?: string },
    ));

    expect(control.openStarted()).toBe(true);
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

  expect(control.closed()).toBe(true);
});

test('close releases the native handle', async () => {
  const control = fakePort();

  const transport: SerialTransport = {
    name: 'test',
    isSupported: () => true,
    requestPort: async () => control.port,
  };

  const hamlib = await createRawHamlib({ transport });
  const native = (hamlib as unknown as {
    readonly native: { liveHandles(): number | Promise<number> };
  }).native;

  try {
    const ts480 = hamlib.models.find(
      (model) => model.manufacturer === 'Kenwood' && model.model === 'TS-480',
    );

    if (!ts480) {
      throw new Error('the TS-480 model is missing');
    }

    const rig = await hamlib.open({ modelId: ts480.id, port: control.port });
    expect(await native.liveHandles()).toBe(1);

    await rig.close();
    expect(await native.liveHandles()).toBe(0);
  } finally {
    await hamlib.dispose();
  }

  expect(await native.liveHandles()).toBe(0);
});
