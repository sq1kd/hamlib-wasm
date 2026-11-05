/**
 * Baud rate: the rate a rig answers at is a setting on the rig, not something
 * its model declares - and a mismatched rate is silence, not an error.
 *
 * Both cases here are real, and they are why the same blank rate field is
 * harmless on one radio and fatal on the other:
 *
 *   - the QRP Labs QMX+ is a USB CDC interface, which ignores the line rate, so
 *     opening it at Hamlib's default (the model's `serial_rate_max`) works;
 *   - the Yaesu FT-710 is a real UART behind a CP2105 bridge whose CAT rate is a
 *     menu setting on the radio, so that same default opens a port nothing
 *     answers on, and every later read fails with a message naming neither the
 *     rate nor the reason.
 *
 * The emulated FT-710 therefore carries the protocol recorded from the radio
 * *and* the radio's own rate: like the real thing, it stays silent at every
 * other rate, which is a failure no protocol-level reply can express.
 */
import { expect, test } from '@playwright/test';

import {
  installFakeSerial,
  installTestHelpers,
  installVirtualClock,
  readFakeSerial,
  useRig,
} from './fixtures';
import type { Captured, HamlibErrorView } from './globals';

const HARNESS_URL = 'http://127.0.0.1:4174/';

/** The rate the emulated FT-710's CAT menu is set to, as on the real radio. */
const FT710_CAT_RATE = 38400;

function expectOk<T>(captured: Captured<T>): T {
  if (!captured.ok) {
    throw new Error(
      `expected success but the page reported ${JSON.stringify(captured.error)}`,
    );
  }

  return captured.value;
}

function expectFailure<T>(captured: Captured<T>): HamlibErrorView {
  if (captured.ok) {
    throw new Error(`expected a failure but the page succeeded: ${JSON.stringify(captured.value)}`);
  }

  return captured.error;
}

test.beforeEach(async ({ page }) => {
  await installVirtualClock(page);
  await installFakeSerial(page);
  await installTestHelpers(page);
  await page.goto(HARNESS_URL);
});

test('an open that nothing answers fails loudly instead of reporting a rig', async ({ page }) => {
  await useRig(page, 'yaesu-ft710');

  const captured = await page.evaluate(async () => {
    const hamlib = await window.__hamlibHarness.createRawHamlib();
    const model = hamlib.models.find((candidate) => candidate.model === 'FT-710');
    const port = await hamlib.requestPort();

    /* No baudRate: Hamlib's own default is the highest rate the model
     * advertises, which for this rig is not the rate it is listening at. */
    const omitted = await window.__testHelpers.capture(
      () => hamlib.open({ modelId: model!.id, port }),
    );

    /* An explicit rate the rig does not answer at is the same silence; the
     * caller's own guess is not trusted either. */
    const explicit = await window.__testHelpers.capture(
      () => hamlib.open({ modelId: model!.id, port, baudRate: 9600 }),
    );

    await hamlib.dispose();
    return { omitted, explicit, max: model!.serialRateMax };
  });

  const omitted = expectFailure(captured.omitted);
  expect(omitted.code).toBe('HAMLIB_ERROR');
  /* -RIG_ETIMEOUT: Hamlib's own code for a read that timed out. */
  expect(omitted.hamlibCode).toBe(-5);
  /* The message has to name the rate that was tried and what to check: the rate
   * is the one thing that can be wrong, and the user is the one who set it. */
  expect(omitted.message).toContain(`at ${String(captured.max)} baud`);
  expect(omitted.message).toContain('nothing arrived');
  expect(omitted.operation).toBe('open');

  expect(expectFailure(captured.explicit).message).toContain('at 9600 baud');

  /* The failure is not a half-open connection: the port itself is released. */
  const control = await readFakeSerial(page);
  expect(control.isOpen).toBe(false);
  expect(control.closeCount).toBe(2);
  /* The emulator never even decoded the commands, because a rig opened at
   * another rate does not receive them - which is what makes the silence look
   * like silence rather than like a rig refusing. */
  expect(control.commands).toEqual([]);
});

test('detectBaudRate finds the rate the rig answers at, then the rig opens', async ({ page }) => {
  await useRig(page, 'yaesu-ft710');

  const found = await page.evaluate(async () => {
    const hamlib = await window.__hamlibHarness.createRawHamlib();
    const model = hamlib.models.find((candidate) => candidate.model === 'FT-710');
    const port = await hamlib.requestPort();

    const detected = await window.__testHelpers.capture(
      () => hamlib.detectBaudRate({ modelId: model!.id, port }),
    );

    /* What the search itself did, before the rig is opened for real. */
    const afterDetect = {
      openCount: window.__fakeSerial.openCount,
      closeCount: window.__fakeSerial.closeCount,
      isOpen: window.__fakeSerial.isOpen,
    };

    if (!detected.ok) {
      /* Nothing to open with: hand the failure back for the spec to report. */
      await hamlib.dispose();
      return { detected, afterDetect, frequency: undefined, baudRate: undefined };
    }

    /* The search is no use to the caller if it keeps the port: they open the rig
     * with the number it found. */
    const rig = await hamlib.open({ modelId: model!.id, port, baudRate: detected.value });
    const frequency = await rig.getFrequency();
    const baudRate = rig.baudRate;

    await rig.close();
    await hamlib.dispose();

    return { detected, afterDetect, frequency, baudRate };
  });

  expect(expectOk(found.detected)).toBe(FT710_CAT_RATE);
  /* Reading through the rig the search led to works, and the rate that is in
   * use is readable from the object itself - so a caller can keep it and pass it
   * straight back on the next connect. */
  expect(found.frequency).toBe(7175000);
  expect(found.baudRate).toBe(FT710_CAT_RATE);

  /* The search closed everything it opened and kept nothing: three candidates
   * were tried - the model's declared maximum, the next rate down, and the one
   * that answered - and that is what lets the caller open the rig next. */
  expect(found.afterDetect.openCount).toBe(3);
  expect(found.afterDetect.closeCount).toBe(3);
  expect(found.afterDetect.isOpen).toBe(false);

  const control = await readFakeSerial(page);
  expect(control.openedOptions?.baudRate).toBe(FT710_CAT_RATE);
  expect(control.isOpen).toBe(false);
});

test('a rig whose declared maximum is right is not searched at all', async ({ page }) => {
  /* The QMX+ case: a CDC interface that answers whatever rate it is opened at,
   * so Hamlib's default is already correct. */
  const found = await page.evaluate(async () => {
    const hamlib = await window.__hamlibHarness.createRawHamlib();
    const model = hamlib.models.find((candidate) => candidate.model === 'TS-480');
    const port = await hamlib.requestPort();

    const detected = await window.__testHelpers.capture(
      () => hamlib.detectBaudRate({ modelId: model!.id, port }),
    );

    await hamlib.dispose();
    return { detected, max: model!.serialRateMax };
  });

  expect(expectOk(found.detected)).toBe(found.max);

  const control = await readFakeSerial(page);
  /* One candidate, one open: the search starts where Hamlib's default already
   * is, so a rig that needs no search pays for none. */
  expect(control.openCount).toBe(1);
  expect(control.closeCount).toBe(1);
});

test('a rate outside the model range is refused before the port is touched', async ({ page }) => {
  await useRig(page, 'yaesu-ft710');

  const captured = await page.evaluate(async () => {
    const hamlib = await window.__hamlibHarness.createRawHamlib();
    const model = hamlib.models.find((candidate) => candidate.model === 'FT-710');
    const port = await hamlib.requestPort();

    const captured = await window.__testHelpers.capture(
      () => hamlib.open({ modelId: model!.id, port, baudRate: 460800 }),
    );

    await hamlib.dispose();
    return { captured, min: model!.serialRateMin, max: model!.serialRateMax };
  });

  const failure = expectFailure(captured.captured);
  expect(failure.code).toBe('INVALID_ARGUMENT');
  expect(failure.message).toContain(`${String(captured.min)}-${String(captured.max)}`);

  expect((await readFakeSerial(page)).openCount).toBe(0);
});
