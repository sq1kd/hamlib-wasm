/**
 * The read-only session, against the rig on the desk.
 *
 * This is the run the switchable-transport change exists for: the shipped
 * `hamlib-wasm/node` entry point, the real `serialport` addon and the real Wasm
 * build, with no browser and no emulator anywhere.  It writes nothing - the
 * frequency, the mode and the PTT state are reads - and a rig that does not
 * answer fails the run instead of being assumed to work.
 *
 * Opt-in: a profile (`HAMLIB_WASM_HARDWARE_DEVICE`) or an explicit
 * `HAMLIB_WASM_HARDWARE_PORT` selects a rig, and nothing set skips the suite, so
 * the task is safe to run on a machine with no radio attached.
 */
import { describe, expect, test } from 'vitest';

import { createHamlib } from 'hamlib-wasm';
import { nodeSerialTransport } from 'hamlib-wasm/node';

import { label } from './devices.js';
import { requireDevice, resolveTarget, selectDevice } from './target.js';

const selection = selectDevice();

describe.skipIf(selection.kind === 'none')('hardware: the selected rig, read-only', () => {
  test('reads frequency, mode and PTT over the Node transport', async () => {
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

      /* The open verified that the rig answers, so this is the rate in use. */
      expect(rig.baudRate).toBe(target.baudRate);

      const state = await rig.refresh();

      /* Print before asserting: when a reading is wrong, the operator needs to
       * see what the rig actually said. */
      console.log(
        `${label(device)} · ${target.path} · ${target.baudRate} baud · `
        + `${String(state.frequency)} Hz ${state.mode ?? ''}`,
      );

      expect(Number.isInteger(state.frequency)).toBe(true);
      expect(state.frequency).toBeGreaterThan(0);
      expect(state.mode ?? '').not.toBe('');

      /* A read of a control line, never a write: a rig that advertises getPtt
       * must answer, and the answer must be one of Hamlib's own states. */
      expect(['off', 'on', 'on-mic', 'on-data']).toContain(await rig.raw.getPtt());

      await rig.close();
      expect(rig.connected).toBe(false);
    } finally {
      /* Closes the rig if an assertion above threw, and the port with it. */
      await hamlib.dispose();
    }
  });
});
