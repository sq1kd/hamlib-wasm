/**
 * The real `serialport` dependency.
 *
 * The adapter's other specs inject a module, so this is the one that touches
 * the package an application actually installs: it must resolve under Node's
 * loader, its `SerialPort` class must satisfy the adapter's structural types
 * (checked at compile time here), and a device that does not exist must
 * surface as a `HamlibError` rather than a crash or an unhandled `'error'`
 * event.
 */
import { SerialPort } from 'serialport';
import { expect, test } from 'vitest';

import { createRawHamlib } from 'hamlib-wasm/raw';
import { nodeSerialTransport } from 'hamlib-wasm/node';
import type { SerialPortConstructorLike } from 'hamlib-wasm/node';

/** The real class must satisfy the shape the adapter constructs. */
const classConforms: SerialPortConstructorLike = SerialPort;
void classConforms;

/** A path that cannot exist on any platform this package runs on. */
const ABSENT_PATH = '/dev/hamlib-wasm-does-not-exist';

test('resolves the real dependency and reports it usable', async () => {
  const transport = nodeSerialTransport();

  expect(transport.name).toBe('serialport');
  expect(transport.isSupported()).toBe(true);
  expect(Array.isArray(await transport.listPorts())).toBe(true);
});

test('reports an absent device as a Hamlib error', async () => {
  const transport = nodeSerialTransport();
  const hamlib = await createRawHamlib({ transport });

  try {
    const model = hamlib.models.find(
      (candidate) => candidate.manufacturer === 'Kenwood' && candidate.model === 'TS-480',
    );

    if (!model) {
      throw new Error('the TS-480 model is missing');
    }

    const port = await transport.requestPort({ path: ABSENT_PATH });
    const failure = await hamlib.open({ modelId: model.id, port, baudRate: 9600 }).then(
      () => null,
      (error: unknown) => error as {
        name?: string;
        code?: string;
        hamlibCode?: number;
        operation?: string;
      },
    );

    expect(failure).not.toBeNull();
    expect(failure?.name).toBe('HamlibError');
    expect(failure?.code).toBe('HAMLIB_ERROR');
    expect(failure?.operation).toBe('open');
    expect(failure?.hamlibCode).toBeLessThan(0);
  } finally {
    await hamlib.dispose();
  }
});
