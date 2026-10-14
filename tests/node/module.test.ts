/**
 * The package runs in Node.
 *
 * The Wasm module was linked with `-sENVIRONMENT=web,node`, and this is the
 * proof that matters: the published `dist/native/hamlib-wasm.mjs`, loaded by
 * Node's own loader, instantiates from `dist/native/hamlib-wasm.wasm` and hands
 * back the real catalogue.  No browser, no DOM shim beyond the `window` alias
 * the emulated rigs need.
 */
import { expect, test } from 'vitest';

import { createHamlib } from 'hamlib-wasm/hamlib';

test('loads the Wasm module and the rig catalogue in Node', async () => {
  const hamlib = await createHamlib();

  try {
    expect(hamlib.version).toContain('Hamlib');
    expect(hamlib.models.length).toBeGreaterThan(50);

    const ts480 = hamlib.models.find(
      (model) => model.manufacturer === 'Kenwood' && model.model === 'TS-480',
    );

    expect(ts480).toBeDefined();
    expect(ts480?.serialRateMin).toBe(4800);
    expect(ts480?.serialRateMax).toBe(115200);
  } finally {
    await hamlib.dispose();
  }
});

test('selects the Node transport when no transport is passed', async () => {
  const hamlib = await createHamlib();

  try {
    /* A path-less request is refused by the Node transport, and only by it:
     * Web Serial rejects a `path` and answers a bare request with
     * TRANSPORT_UNAVAILABLE.  So this refusal is the observable proof that the
     * runtime's own transport is the default here. */
    const failure = await hamlib.requestPort().then(
      () => null,
      (error: unknown) => error as { code?: string; operation?: string; message?: string },
    );

    expect(failure).not.toBeNull();
    expect(failure?.code).toBe('INVALID_ARGUMENT');
    expect(failure?.operation).toBe('requestPort');
    expect(failure?.message).toContain('Node transport');
    expect(failure?.message).toContain('listPorts()');
  } finally {
    await hamlib.dispose();
  }
});
