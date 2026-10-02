/**
 * Protocol coverage beyond the TS-480.
 *
 * The transport is protocol agnostic, so these specs drive two structurally
 * different radios through the same public API:
 *
 *   - an Icom IC-703, which speaks binary CI-V frames with an address header
 *     and ACK/NAK responses rather than terminated ASCII;
 *   - a Yaesu FT-757GXII, whose push-to-talk is the DTR line on the CAT port
 *     and therefore never appears on the wire at all.
 */
import { expect, test } from '@playwright/test';

import { installFakeSerial, installTestHelpers, readFakeSerial, useRig } from './fixtures';
import type { Captured } from './globals';

const HARNESS_URL = 'http://127.0.0.1:4174/';

function expectOk<T>(captured: Captured<T>): T {
  if (!captured.ok) {
    throw new Error(
      `expected success but the page reported ${JSON.stringify(captured.error)}`,
    );
  }

  return captured.value;
}

function expectFailure<T>(captured: Captured<T>): NonNullable<
  Extract<Captured<T>, { ok: false }>['error']
> {
  if (captured.ok) {
    throw new Error(
      `expected a failure but the page succeeded: ${JSON.stringify(captured.value)}`,
    );
  }

  return captured.error;
}

test.beforeEach(async ({ page }) => {
  await installFakeSerial(page);
  await installTestHelpers(page);
  await page.goto(HARNESS_URL);
});

test('drives an Icom CI-V radio, a different protocol family', async ({ page }) => {
  await useRig(page, 'icom-ic703');

  const captured = await page.evaluate(() => window.__testHelpers.capture(async () => {
    const hamlib = await window.__hamlibHarness.createHamlib();
    const port = await hamlib.requestPort();
    const ic703 = hamlib.models.find(
      (model) => model.manufacturer === 'Icom' && model.model === 'IC-703',
    );

    if (!ic703) {
      throw new Error('the IC-703 model is missing');
    }

    const rig = await hamlib.open({ modelId: ic703.id, port });

    const frequencyBefore = await rig.getFrequency();
    const modeBefore = await rig.getMode();
    await rig.setFrequency(7_074_000);
    const frequency = await rig.getFrequency();
    /* An omitted passband is the caller's decision now: the rig's own normal
     * width for the mode is its own generated operation. */
    await rig.setMode('CW', await rig.passbandNormal('CW'));
    await rig.setPtt('on');
    const pttOn = await rig.getPtt();
    await rig.setPtt('off');
    const pttOff = await rig.getPtt();

    const commands = [...window.__fakeSerial.commands];

    await rig.close();
    await hamlib.dispose();

    return { commands, frequencyBefore, modeBefore, frequency, pttOn, pttOff };
  }));

  const result = expectOk(captured);

  /* The CI-V framing produced real data, not timeouts: the backend's own
   * frequency decode is the proof. */
  expect(result.frequencyBefore).toBe(14_074_000);
  expect(result.modeBefore.mode).toBe('USB');
  expect(result.frequency).toBe(7_074_000);
  expect(result.pttOn).toBe('on');
  expect(result.pttOff).toBe('off');

  /* CI-V commands: 03 read frequency, 05 set frequency, 04 read mode,
   * 06 set mode, 1C 00 transmit state.  The PTT reads come back from Hamlib's
   * cache, so only the writes reach the wire. */
  expect(result.commands).toContain('03');
  expect(result.commands).toContain('04');
  expect(result.commands).toContain('05 00 40 07 07 00');
  expect(result.commands.some((command) => command.startsWith('06 03'))).toBe(true);
  expect(result.commands).toContain('1C 00 01');
  expect(result.commands).toContain('1C 00 00');

  const transport = await readFakeSerial(page);

  expect(transport.rigName).toBe('icom-ic703');
  expect(transport.state.frequency).toBe(7_074_000);
  expect(transport.state.transmitting).toBe(false);
  expect(transport.openCount).toBe(1);
  expect(transport.closeCount).toBe(1);
  expect(transport.openedOptions).toEqual({
    baudRate: 19200,
    dataBits: 8,
    stopBits: 1,
    parity: 'none',
    flowControl: 'none',
  });
  expect(transport.isOpen).toBe(false);
  expect(transport.closedWithLockedStreams).toBe(false);
});

test('reports the upstream open failure that keeps serial DTR PTT unreachable', async ({ page }) => {
  await useRig(page, 'yaesu-ft757gx2');

  const captured = await page.evaluate(() => window.__testHelpers.capture(async () => {
    const hamlib = await window.__hamlibHarness.createHamlib();
    const port = await hamlib.requestPort();
    const ft757 = hamlib.models.find(
      (model) => model.manufacturer === 'Yaesu' && model.model === 'FT-757GXII',
    );

    if (!ft757) {
      throw new Error('the FT-757GXII model is missing');
    }

    const opened = await window.__testHelpers.capture(
      () => hamlib.open({ modelId: ft757.id, port }),
    );
    const commands = [...window.__fakeSerial.commands];
    const limitation = ft757.limitation ?? null;

    await hamlib.dispose();

    return { opened, commands, limitation };
  }));

  const result = expectOk(captured);

  /* The only serial backend that drives push-to-talk over the DTR line cannot
   * open: its `rig_open` reads a 75 octet status block through a helper whose
   * retry count Hamlib has already zeroed, so it returns an I/O error before
   * writing anything.  Recorded rather than hidden - see UNUSABLE_MODELS. */
  expect(result.limitation).toContain('retry');

  const opened = expectFailure(result.opened);
  expect(opened.code).toBe('HAMLIB_ERROR');
  expect(opened.hamlibCode).toBe(-6); /* -RIG_EIO */
  expect(result.commands).toEqual([]);

  const transport = await readFakeSerial(page);

  expect(transport.rigName).toBe('yaesu-ft757gx2');
  /* The port was opened and released; nothing was left behind. */
  expect(transport.openCount).toBe(1);
  expect(transport.closeCount).toBe(1);
  expect(transport.isOpen).toBe(false);
  expect(transport.closedWithLockedStreams).toBe(false);
  /* Push-to-talk over DTR is still wired at the transport seam, which is the
   * part this build owns: opening the shared CAT/PTT port deasserts DTR. */
  expect(transport.setSignalsCalls).toBe(1);
  expect(transport.outputSignals?.dataTerminalReady).toBe(false);
});
