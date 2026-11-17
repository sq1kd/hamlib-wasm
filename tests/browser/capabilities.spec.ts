/**
 * Capability-aware telemetry and command gating.
 *
 * A model may implement only part of the telemetry surface.  `refresh()`
 * must read exactly the getters the model advertises and omit the rest - never
 * invent a value - while the connection stays owned and the operations the
 * model cannot perform are refused before reaching Wasm.
 *
 * The emulators make two real models testable without hardcoded capability
 * knowledge: the Yaesu FRG-100 receiver (frequency only) and the Kenwood
 * TS-140S (frequency and mode, but PTT is set-only).
 */

import { expect, expectFailure, expectOk, test, useRig } from './fixtures';

test('a frequency-only model produces a frequency-only snapshot', async ({ harnessPage: page }) => {
  await useRig(page, 'yaesu-frg100');

  const captured = await page.evaluate(() => window.__testHelpers.capture(async () => {
    const hamlib = await window.__hamlibHarness.createHamlib({});
    const model = window.__testHelpers.catalogueModel(hamlib.models, 'Yaesu', 'FRG-100');

    const capabilities = window.__hamlibHarness.capabilitiesOf(model);
    const rig = await hamlib.open({ modelId: model.id, baudRate: model.serialRateMax });
    const first = await rig.refresh();

    const events: string[] = [];

    rig.on('frequency', () => { events.push('frequency'); });
    rig.on('mode', () => { events.push('mode'); });
    rig.on('ptt', () => { events.push('ptt'); });

    const second = await rig.refresh();
    const eventsAfterRefresh = [...events];

    /* The advertised getters keep working; the unadvertised ones are refused
     * before they reach Wasm. */
    const modeRead = await window.__testHelpers.capture(() => rig.raw.getMode());
    const pttSet = await window.__testHelpers.capture(() => rig.raw.setPtt('on'));

    await rig.setFrequency(7_100_000);

    const afterWrite = await rig.refresh();
    const connected = rig.connected;
    const remembered = rig.state;

    await rig.close();
    await hamlib.dispose();

    return {
      capabilities,
      firstKeys: Object.keys(first).sort(),
      firstFrequency: first.frequency ?? null,
      secondKeys: Object.keys(second).sort(),
      events: eventsAfterRefresh,
      modeRead,
      pttSet,
      afterWriteFrequency: afterWrite.frequency ?? null,
      rememberedKeys: remembered === undefined ? null : Object.keys(remembered).sort(),
      connected,
      isOpen: window.__fakeSerial.isOpen,
      closeCount: window.__fakeSerial.closeCount,
    };
  }));

  const result = expectOk(captured);

  expect(result.capabilities).toEqual({
    getFrequency: true,
    setFrequency: true,
    getMode: false,
    setMode: true,
    getPtt: false,
    setPtt: false,
    sendMorse: false,
    stopMorse: false,
  });

  /* Only the advertised field, and the same shape on every refresh. */
  expect(result.firstKeys).toEqual(['frequency']);
  expect(result.secondKeys).toEqual(['frequency']);
  expect(result.firstFrequency).toBe(7_050_000);
  expect(result.rememberedKeys).toEqual(['frequency']);

  /* Field-specific events are only emitted for present fields. */
  expect(result.events).toEqual(['frequency']);

  expect(expectFailure(result.modeRead).code).toBe('UNSUPPORTED_OPERATION');
  expect(expectFailure(result.pttSet).code).toBe('UNSUPPORTED_OPERATION');

  /* The frequency setter works, and the model stays connected throughout. */
  expect(result.afterWriteFrequency).toBe(7_100_000);
  expect(result.connected).toBe(true);
  expect(result.isOpen).toBe(false);
  expect(result.closeCount).toBe(1);
});

test('a set-only PTT model takes both PTT commands and refuses the read', async ({ harnessPage: page }) => {
  const captured = await page.evaluate(() => window.__testHelpers.capture(async () => {
    const hamlib = await window.__hamlibHarness.createHamlib({});
    const model = window.__testHelpers.catalogueModel(hamlib.models, 'Kenwood', 'TS-140S');

    const capabilities = window.__hamlibHarness.capabilitiesOf(model);
    const rig = await hamlib.open({ modelId: model.id, baudRate: model.serialRateMax });

    const state = await rig.refresh();
    const read = await window.__testHelpers.capture(() => rig.raw.getPtt());

    /* The commands do not depend on any readback. */
    await rig.setPtt(true);
    await rig.setPtt(false);

    const commands = window.__fakeSerial.commands;
    const transmitting = window.__fakeSerial.state.transmitting;

    await rig.close();
    await hamlib.dispose();

    return {
      capabilities,
      keys: Object.keys(state).sort(),
      read,
      transmitting,
      txIndex: commands.indexOf('TX'),
      rxIndex: commands.indexOf('RX'),
      isOpen: window.__fakeSerial.isOpen,
    };
  }));

  const result = expectOk(captured);

  expect(result.capabilities.getPtt).toBe(false);
  expect(result.capabilities.setPtt).toBe(true);

  /* PTT readback is unavailable, so the snapshot omits it - and the write
   * commands still go out, in order. */
  expect(result.keys).toEqual(['frequency', 'mode', 'passband']);
  expect(expectFailure(result.read).code).toBe('UNSUPPORTED_OPERATION');
  expect(result.txIndex).toBeGreaterThanOrEqual(0);
  expect(result.rxIndex).toBeGreaterThan(result.txIndex);
  expect(result.transmitting).toBe(false);
  expect(result.isOpen).toBe(false);
});
