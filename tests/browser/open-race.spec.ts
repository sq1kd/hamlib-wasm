/**
 * Connection cancellation at the port-open boundary.
 *
 * The easy layer tracks its handles and marks itself disposed before the
 * native cleanup runs, so an open parked inside `SerialPort.open()` is handed
 * over closed instead of publishing a live wrapper, and the port is released.
 *
 * The fixture parks `SerialPort.open()` behind a gate, so the race is decided
 * by explicit release rather than by a sleep.
 */
import { expect, test } from '@playwright/test';

import { holdNextPortOpen, installFakeSerial, installTestHelpers, readFakeSerial } from './fixtures';
import type { Captured } from './globals';

const HARNESS_URL = 'http://127.0.0.1:4174/';

function expectOk<T>(captured: Captured<T>): T {
  if (!captured.ok) {
    throw new Error(`expected success, got ${captured.error.code}: ${captured.error.message}`);
  }

  return captured.value;
}

test.beforeEach(async ({ page }) => {
  await installFakeSerial(page);
  await installTestHelpers(page);
  await page.goto(HARNESS_URL);
});

test('disposal during a parked open publishes nothing and releases the port', async ({ page }) => {
  await holdNextPortOpen(page);

  const captured = await page.evaluate(() => window.__testHelpers.capture(async () => {
    const hamlib = await window.__hamlibHarness.createEasy({});
    const model = hamlib.models.find((candidate) => candidate.model === 'TS-480');

    if (!model) { throw new Error('the TS-480 is missing from the catalogue'); }

    /* Start the open, then wait until its port open is actually parked. */
    const opening = window.__testHelpers.capture(
      () => hamlib.open({ modelId: model.id, baudRate: model.serialRateMax }),
    );

    while (!window.__fakeSerial.openPending) {
      await window.__testHelpers.sleep(5);
    }

    /* Disposal is accepted while the open is parked; releasing the port lets
     * that open finish and be handed over closed. */
    const disposal = window.__testHelpers.capture(() => hamlib.dispose());

    window.__fakeSerial.releaseOpen();

    const disposed = await disposal;
    const outcome = await opening;

    return {
      disposedOk: disposed.ok,
      openOk: outcome.ok,
      openCode: outcome.ok ? null : outcome.error.code,
      openOperation: outcome.ok ? null : outcome.error.operation,
      commands: window.__fakeSerial.commands.slice(),
      isOpen: window.__fakeSerial.isOpen,
      openCount: window.__fakeSerial.openCount,
      closeCount: window.__fakeSerial.closeCount,
      closedWithLockedStreams: window.__fakeSerial.closedWithLockedStreams,
    };
  }));

  const result = expectOk(captured);

  expect(result.disposedOk).toBe(true);
  expect(result.openOk).toBe(false);
  expect(result.openCode).toBe('DISPOSED');
  expect(result.openOperation).toBe('open');

  /* The open did reach the device, and disposal really released it. */
  expect(result.commands).toContain('ID');
  expect(result.openCount).toBe(1);
  expect(result.closeCount).toBe(1);
  expect(result.isOpen).toBe(false);
  expect(result.closedWithLockedStreams).toBe(false);

  const transport = await readFakeSerial(page);

  expect(transport.isOpen).toBe(false);
});

test('a later open after a cancelled one still works', async ({ page }) => {
  await holdNextPortOpen(page);

  const captured = await page.evaluate(() => window.__testHelpers.capture(async () => {
    const hamlib = await window.__hamlibHarness.createEasy({});
    const model = hamlib.models.find((candidate) => candidate.model === 'TS-480');

    if (!model) { throw new Error('the TS-480 is missing from the catalogue'); }

    /* First attempt: cancelled through close() of the wrapper it would have
     * produced - here the cancelled attempt is the disposal race's rig. */
    const opening = window.__testHelpers.capture(
      () => hamlib.open({ modelId: model.id, baudRate: model.serialRateMax }),
    );

    while (!window.__fakeSerial.openPending) {
      await window.__testHelpers.sleep(5);
    }

    const disposal = window.__testHelpers.capture(() => hamlib.dispose());

    window.__fakeSerial.releaseOpen();

    await disposal;
    await opening;

    /* A fresh instance must be able to take the same port again. */
    const second = await window.__hamlibHarness.createEasy({});
    const rig = await second.open({ modelId: model.id, baudRate: model.serialRateMax });
    const state = await rig.refresh();

    await rig.close();
    await second.dispose();

    return {
      frequency: state.frequency ?? null,
      openCount: window.__fakeSerial.openCount,
      isOpen: window.__fakeSerial.isOpen,
      closedWithLockedStreams: window.__fakeSerial.closedWithLockedStreams,
    };
  }));

  const result = expectOk(captured);

  expect(result.frequency).toBe(14_074_000);
  expect(result.openCount).toBe(2);
  expect(result.isOpen).toBe(false);
  expect(result.closedWithLockedStreams).toBe(false);
});
