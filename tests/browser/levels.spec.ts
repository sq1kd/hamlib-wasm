/**
 * Configurable levels, and scoped watching.
 *
 * The default surface reads a level only when the instance was configured for it
 * and the model advertises it, and a watch registration reads only the fields
 * it named - so a UI that shows an S-meter does not pay for a frequency read
 * per meter tick, and a page with no meters pays nothing.
 */

import { expect, expectOk, test } from './fixtures';

test('reads only the configured levels the model advertises', async ({ harnessPage: page }) => {
  const captured = await page.evaluate(() => window.__testHelpers.capture(async () => {
    const hamlib = await window.__hamlibHarness.createHamlib({
      levels: ['STRENGTH', 'SWR'],
    });
    const model = hamlib.models.find((candidate) => candidate.model === 'TS-480');

    if (!model) { throw new Error('the TS-480 is missing from the catalogue'); }

    const rig = await hamlib.open({ modelId: model.id, baudRate: model.serialRateMax });
    const advertised = [...rig.capabilities.levels];
    const state = await rig.refresh();

    /* A one-shot read of a configured, advertised level. */
    const strength = await rig.level('STRENGTH');

    const refusal = await window.__testHelpers.capture(() => rig.level('ALC'));

    await rig.close();
    await hamlib.dispose();

    return {
      advertised,
      levels: state.levels ?? {},
      strength,
      refusal,
    };
  }));

  const result = expectOk(captured);

  /* The TS-480 declares both; ALC is not configured, so it is neither
   * advertised nor read.  The S-meter value goes through the model's own
   * calibration table, so only its plausibility is asserted. */
  expect(result.advertised).toEqual(['STRENGTH', 'SWR']);
  /* Raw 11 is the 0 dB point of the TS-480 S-meter table, raw 4 the 1.5 point
   * of its SWR table, so both decode exactly. */
  expect(result.levels.STRENGTH).toBeCloseTo(0, 5);
  expect(result.levels.SWR).toBeCloseTo(1.5, 5);
  expect(result.strength).toBeCloseTo(0, 5);

  expect(result.refusal.ok).toBe(false);
  expect(result.refusal.ok ? null : result.refusal.error.code).toBe('INVALID_ARGUMENT');
});

test('a level watch reads only the level, a frequency watch reads none', async ({ harnessPage: page }) => {
  const captured = await page.evaluate(() => window.__testHelpers.capture(async () => {
    const hamlib = await window.__hamlibHarness.createHamlib({ levels: ['STRENGTH'] });
    const model = hamlib.models.find((candidate) => candidate.model === 'TS-480');

    if (!model) { throw new Error('the TS-480 is missing from the catalogue'); }

    const rig = await hamlib.open({ modelId: model.id, baudRate: model.serialRateMax });

    /* Meter-only watch: one SM0 read per tick, nothing else. */
    const base = window.__fakeSerial.commands.length;
    const stopMeter = rig.watch({ intervalMs: 40, fields: ['levels'], levels: ['STRENGTH'] });
    await window.__virtualClock.advance(260);
    stopMeter();
    const meterCommands = window.__fakeSerial.commands.slice(base);

    /* Frequency watch with no levels: no SM0 read at all.  It starts 260 ms
     * after the open read the frequency, inside Hamlib's 500 ms cache window,
     * and runs 600 ms of virtual time - so the window lapses during the watch,
     * at the same tick on every run, and exactly one read reaches the wire
     * before the cache it refills serves the rest. */
    const frequencyBase = window.__fakeSerial.commands.length;
    const stopFrequency = rig.watch({ intervalMs: 40, fields: ['frequency'] });
    await window.__virtualClock.advance(600);
    stopFrequency();
    const frequencyCommands = window.__fakeSerial.commands.slice(frequencyBase);

    await rig.close();
    await hamlib.dispose();

    return { meterCommands, frequencyCommands };
  }));

  const result = expectOk(captured);

  /* Ticks at 0, 40, ..., 240: one meter read each, and nothing else. */
  expect(result.meterCommands).toEqual(Array.from({ length: 7 }, () => 'SM0'));
  expect(result.frequencyCommands).toEqual(['FA']);
});

test('watching levels on an instance with none configured is refused', async ({ harnessPage: page }) => {
  const captured = await page.evaluate(() => window.__testHelpers.capture(async () => {
    const hamlib = await window.__hamlibHarness.createHamlib({});
    const model = hamlib.models.find((candidate) => candidate.model === 'TS-480');

    if (!model) { throw new Error('the TS-480 is missing from the catalogue'); }

    const rig = await hamlib.open({ modelId: model.id, baudRate: model.serialRateMax });
    const refusal = window.__testHelpers.capture(() => {
      rig.watch({ intervalMs: 100, fields: ['levels'] });
      return null;
    });

    await rig.close();
    await hamlib.dispose();

    return refusal;
  }));

  const result = expectOk(captured);

  expect(result.ok).toBe(false);
  expect(result.ok ? null : result.error.code).toBe('INVALID_ARGUMENT');
});
