/**
 * The frequency round-trip, the one place this project writes to a rig.
 *
 * It writes back what it found, so the operator's frequency is restored before
 * the test ends, and it writes nothing else - no PTT, no mode, no level, here or
 * anywhere else in the hardware project, so a failing run can never mean an
 * accidental transmission.  CAT PTT stays covered by the browser emulator and
 * `tests/node`.
 *
 * Opt-in twice over: a selected profile *and* `HAMLIB_WASM_HARDWARE_WRITE=1`, so
 * a default run of the hardware task cannot move a dial.
 */
import { describe, expect, test } from 'vitest';

import { createHamlib } from 'hamlib-wasm';
import { nodeSerialTransport } from 'hamlib-wasm/node';

import { requireDevice, resolveTarget, selectDevice, writesEnabled } from './target.js';

const selection = selectDevice();
const writes = writesEnabled();

describe.skipIf(selection.kind === 'none' || !writes)('hardware: frequency round-trip', () => {
  test('writes the profile frequency and restores the original', async () => {
    /* A bad invocation fails here, with the ids that would work. */
    const device = requireDevice(selection);
    const transport = nodeSerialTransport();
    const target = await resolveTarget(transport, device);
    const hamlib = await createHamlib({ transport });

    try {
      const port = await transport.requestPort({ path: target.path });
      const rig = await hamlib.open({
        modelId: target.model.id,
        port,
        baudRate: target.baudRate,
      });

      const original = await rig.raw.getFrequency();
      expect(original).toBeGreaterThan(0);

      /* A rig already sitting on the profile frequency would make the write a
       * no-op, so move 1 kHz up instead - still inside the declared range. */
      const written = original === device.writeFrequency ? device.writeFrequency + 1_000 : device.writeFrequency;

      await rig.raw.setFrequency(written);
      expect(await rig.raw.getFrequency()).toBe(written);

      await rig.raw.setFrequency(original);
      const restored = await rig.raw.getFrequency();

      console.log(
        `${device.label} · ${target.path} · ${target.baudRate} baud · `
        + `${String(original)} Hz -> ${String(written)} Hz -> ${String(restored)} Hz`,
      );

      expect(restored).toBe(original);

      await rig.close();
      expect(rig.connected).toBe(false);
    } finally {
      await hamlib.dispose();
    }
  });
});
