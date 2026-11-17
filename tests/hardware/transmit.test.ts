/**
 * Transmitting, into a dummy load.
 *
 * PTT keys the rig and unkeys it, as the rig itself reports; where the profile
 * names a carrier mode and the backend reads a forward-power meter, the meter
 * has to show the carrier too, so a PTT state that only Hamlib's cache believes
 * cannot pass.
 *
 * Opt-in three times over: a selected profile, `HAMLIB_WASM_HARDWARE_TRANSMIT`
 * set to `dummy-load`, and nothing else in this project transmits.  The test
 * lowers the power where the model can set it, keys for one second at most,
 * and restores PTT first, then the mode and the power, whatever fails.
 *
 * Morse is not here: no profile's backend sends it today (see Notes from real radios
 * on the Supported rigs page), and a test that cannot pass on any connected rig proves nothing.
 */
import { describe, expect, test } from 'vitest';

import { createHamlib } from 'hamlib-wasm';
import type { Rig } from 'hamlib-wasm';
import { nodeSerialTransport } from 'hamlib-wasm/node';

import { CACHE_LAPSE_MS } from '../hamlib-constants.js';
import { label } from './devices.js';
import { requireDevice, resolveTarget, selectDevice, selectTransmit } from './target.js';

const selection = selectDevice();
const transmit = selectTransmit();

/** Power while keyed, where the model can set it: a tenth of its maximum. */
const TEST_POWER = 0.1;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

/** Mode and power as found, put back whatever the test did in between. */
async function preserving(rig: Rig, work: () => Promise<void>): Promise<void> {
  const mode = rig.capabilities.getMode ? await rig.raw.getMode() : undefined;
  const setsPower = await rig.raw.hasSetLevel('RFPOWER');
  const power = setsPower ? await rig.raw.getLevel('RFPOWER') : undefined;

  try {
    if (setsPower) {
      await rig.raw.setLevel('RFPOWER', TEST_POWER);
    }

    await work();
  } finally {
    await rig.setPtt(false);

    if (mode !== undefined) {
      await rig.raw.setMode(mode.mode, mode.passband);
    }

    if (power !== undefined) {
      await rig.raw.setLevel('RFPOWER', power);
    }
  }
}

describe.skipIf(selection.kind === 'none' || transmit.kind === 'off')('hardware: transmitting into a dummy load', () => {
  test('keys and unkeys PTT, and the meter sees the carrier where it can', async () => {
    if (transmit.kind === 'invalid') {
      throw new Error(transmit.reason);
    }

    const device = requireDevice(selection);
    const transport = nodeSerialTransport();
    const target = await resolveTarget(transport, device);
    const hamlib = await createHamlib({ transport, levels: ['RFPOWER_METER'] });

    try {
      const port = await transport.requestPort({ path: target.path });
      const rig = await hamlib.open({ modelId: target.model.id, port, baudRate: target.baudRate });

      expect(rig.capabilities.setPtt).toBe(true);

      /* A carrier to measure, and a meter to measure it with. */
      const carrierMode = rig.capabilities.levels.includes('RFPOWER_METER') ? device.carrierMode : undefined;
      const metered = carrierMode !== undefined;
      let idle = 0;
      let keyed = 0;
      let during: string | undefined;

      await preserving(rig, async () => {
        if (carrierMode !== undefined) {
          await rig.setMode(carrierMode);
          idle = await rig.level('RFPOWER_METER');
        }

        await rig.setPtt(true);
        await sleep(CACHE_LAPSE_MS);
        during = await rig.raw.getPtt();

        if (metered) {
          keyed = await rig.level('RFPOWER_METER');
        }
      });

      await sleep(CACHE_LAPSE_MS);
      const after = await rig.raw.getPtt();

      console.log(
        `${label(device)} · PTT ${String(during)} -> ${after}`
        + (metered ? ` · forward ${idle.toFixed(3)} idle, ${keyed.toFixed(3)} keyed` : ' · no meter'),
      );

      expect(during).toBe('on');
      expect(after).toBe('off');

      if (metered) {
        expect(keyed).toBeGreaterThan(idle);
      }

      await rig.close();
    } finally {
      await hamlib.dispose();
    }
  });
});
