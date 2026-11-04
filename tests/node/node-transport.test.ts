/**
 * The `serialport` adapter, driven through the real `SerialPortStream`.
 *
 * The module under test is `hamlib-wasm/node`'s own adapter; what it is wired
 * to is `@serialport/stream`'s real class (via
 * `tests/node/rig-serialport.ts`), so the queueing, the option plumbing, the
 * `set()` flag merging and the `Buffer` requirement are exercised as they are,
 * not as a double restates them.
 */
import { afterEach, expect, test } from 'vitest';

import { createHamlib } from 'hamlib-wasm/hamlib';
import type { Hamlib, SerialTransport } from 'hamlib-wasm/hamlib';
import { nodeSerialTransport } from 'hamlib-wasm/node';

import { FAKE_PATH, rigSerialPortModule } from './rig-serialport.js';
import { settle, useRealTime, useVirtualTime } from './virtual-time.js';

/** The model id of a catalogue entry, or a failure that names what is missing. */
function modelIdOf(hamlib: Hamlib, manufacturer: string, model: string): number {
  const entry = hamlib.models.find(
    (candidate) => candidate.manufacturer === manufacturer && candidate.model === model,
  );

  if (!entry) {
    throw new Error(`the ${manufacturer} ${model} model is missing`);
  }

  return entry.id;
}

test('refuses a port request without a path', async () => {
  const transport = nodeSerialTransport({ serialport: rigSerialPortModule() });

  const failure = await transport.requestPort().then(
    () => null,
    (error: unknown) => error as { code?: string; operation?: string; message?: string },
  );

  expect(failure?.code).toBe('INVALID_ARGUMENT');
  expect(failure?.operation).toBe('requestPort');
  expect(failure?.message).toContain('listPorts()');
});

test('lists the ports the module reports', async () => {
  const transport = nodeSerialTransport({ serialport: rigSerialPortModule() });

  expect(await transport.listPorts()).toEqual([
    {
      path: FAKE_PATH,
      manufacturer: 'Emulated',
      serialNumber: undefined,
      pnpId: undefined,
      locationId: undefined,
      vendorId: '1a86',
      productId: '7523',
    },
  ]);
});

test('opens the requested path at the rig settings and reads the rig', async () => {
  const module = rigSerialPortModule();
  const transport = nodeSerialTransport({ serialport: module });
  const hamlib = await createHamlib({ transport });

  try {
    const modelId = modelIdOf(hamlib, 'Kenwood', 'TS-480');
    const port = await transport.requestPort({ path: FAKE_PATH });
    const rig = await hamlib.open({ modelId, port, baudRate: 9600 });

    expect(await rig.getFrequency()).toBe(14_074_000);
    expect(rig.baudRate).toBe(9600);
    await rig.close();
  } finally {
    await hamlib.dispose();
  }

  /* What the adapter asked the port constructor for. */
  expect(module.constructed).toEqual([
    {
      path: FAKE_PATH,
      baudRate: 9600,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      rtscts: false,
      autoOpen: false,
    },
  ]);

  /* And what reached the binding: the stream strips `binding` and `autoOpen`
   * before it forwards the open options. */
  expect(module.binding.lastOpenOptions).toEqual({
    path: FAKE_PATH,
    baudRate: 9600,
    dataBits: 8,
    stopBits: 1,
    parity: 'none',
    rtscts: false,
  });

  /* The exchange really happened: the emulator decoded Hamlib's own sequence,
   * and every byte arrived through a real `Buffer` write. */
  expect(module.binding.port?.writes.length).toBeGreaterThan(0);

  const commands = module.binding.port?.rig.commands ?? [];

  expect(commands).toContain('ID');
  expect(commands).toContain('FA');
});

test('maps hardware flow control onto the binding option', async () => {
  const module = rigSerialPortModule();
  const transport = nodeSerialTransport({ serialport: module });
  const port = await transport.requestPort({ path: FAKE_PATH });

  await port.open({
    baudRate: 9600,
    dataBits: 8,
    stopBits: 1,
    parity: 'none',
    flowControl: 'hardware',
  });

  expect(module.binding.lastOpenOptions?.rtscts).toBe(true);

  await port.close();
});

test('sends the complete output state on every setSignals call', async () => {
  const module = rigSerialPortModule();
  const transport = nodeSerialTransport({ serialport: module });
  const port = await transport.requestPort({ path: FAKE_PATH });

  await port.open({ baudRate: 9600 });

  /* `serialport` fills every flag a `set()` call leaves out with its own
   * defaults (`dtr` and `rts` true), so a partial update would silently reset
   * the lines the rig still needs.  The adapter therefore sends all four. */
  await port.setSignals({ requestToSend: true });
  await port.setSignals({ dataTerminalReady: false });

  expect(module.binding.port?.setCalls).toEqual([
    { brk: false, cts: false, dtr: true, rts: true },
    { brk: false, cts: false, dtr: false, rts: true },
  ]);

  await port.close();
});

test('maps the modem lines the binding reports', async () => {
  const module = rigSerialPortModule();
  const transport = nodeSerialTransport({ serialport: module });
  const port = await transport.requestPort({ path: FAKE_PATH });

  await port.open({ baudRate: 9600 });

  const opened = module.binding.port;

  if (!opened) {
    throw new Error('the binding did not open a port');
  }

  opened.status = { cts: true, dsr: false, dcd: true };

  expect(await port.getSignals()).toEqual({
    clearToSend: true,
    dataSetReady: false,
    dataCarrierDetect: true,
    /* `serialport` cannot read a ring indicator at all. */
    ringIndicator: false,
  });

  await port.close();
});

test('refuses to open a port twice, and opens a fresh port after close', async () => {
  const module = rigSerialPortModule();
  const transport = nodeSerialTransport({ serialport: module });
  const port = await transport.requestPort({ path: FAKE_PATH });

  await port.open({ baudRate: 9600 });

  const failure = await port.open({ baudRate: 9600 }).then(
    () => null,
    (error: unknown) => error as { code?: string; message?: string },
  );

  expect(failure?.code).toBe('INVALID_ARGUMENT');
  expect(failure?.message).toContain('already open');

  /* Close is idempotent, and a closed port can be opened again: that is the
   * shape Hamlib's own baud-rate reconfiguration needs. */
  await port.close();
  await port.close();
  await port.open({ baudRate: 9600 });
  await port.close();

  expect(module.constructed).toHaveLength(2);
});

test('surfaces a device that cannot be opened as a Hamlib error, not a crash', async () => {
  const module = rigSerialPortModule();

  /* A binding whose open always fails, as a held or absent device does. */
  module.binding.open = async () => {
    throw Object.assign(new Error(`cannot open ${FAKE_PATH}`), { code: 'ENOENT' });
  };

  const transport: SerialTransport = nodeSerialTransport({ serialport: module });
  const hamlib = await createHamlib({ transport });

  try {
    const modelId = modelIdOf(hamlib, 'Kenwood', 'TS-480');
    const port = await transport.requestPort({ path: FAKE_PATH });
    const failure = await hamlib.open({ modelId, port }).then(
      () => null,
      (error: unknown) => error as { code?: string; hamlibCode?: number; message?: string },
    );

    expect(failure).not.toBeNull();
    expect(failure?.code).toBe('HAMLIB_ERROR');
    /* `ENOENT` maps to NotFoundError, which the transport layer turns into
     * -RIG_EINVAL: never a crash, never an unhandled 'error' event. */
    expect(failure?.hamlibCode).toBe(-1);
    expect(failure?.message).toContain('open failed');
  } finally {
    await hamlib.dispose();
  }
});

afterEach(() => {
  useRealTime();
});

/* A silent probe costs Hamlib's own open timeout, and this rig answers at the
 * third rate the model declares.  On virtual time those timeouts cost exactly
 * their budget of it and nothing on the wall clock, so no reply can lose a race
 * against a loaded machine. */
test('finds the rate a rig answers at through the adapter', async () => {
  useVirtualTime();

  const module = rigSerialPortModule('yaesu-ft710');
  const transport = nodeSerialTransport({ serialport: module });
  const hamlib = await createHamlib({ transport });

  try {
    const modelId = modelIdOf(hamlib, 'Yaesu', 'FT-710');
    const port = await transport.requestPort({ path: FAKE_PATH });
    const baudRate = await settle(hamlib.detectBaudRate({ modelId, port }));

    /* The FT-710 emulator is silent at every rate but 38400 - the rate its own
     * menu is set to - so the search can only succeed by finding it, and the
     * probe closes whatever it opened. */
    expect(baudRate).toBe(38_400);
    expect(module.binding.port?.isOpen).toBe(false);
  } finally {
    await settle(hamlib.dispose());
  }
});
