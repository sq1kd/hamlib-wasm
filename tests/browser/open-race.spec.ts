/**
 * Connection cancellation at the port-open boundary.
 *
 * The default layer tracks its handles and marks itself disposed before the
 * native cleanup runs, so an open parked inside `SerialPort.open()` is handed
 * over closed instead of publishing a live wrapper, and the port is released.
 *
 * The fixture parks `SerialPort.open()` behind a gate, so the race is decided
 * by explicit release rather than by a sleep, and the spec waits for the park
 * itself on the virtual clock: whatever Hamlib sleeps through before it reaches
 * the port fires in order, and nothing after.
 */

import { expect, expectOk, holdNextPortOpen, readFakeSerial, test } from './fixtures';

test('disposal during a parked open publishes nothing and releases the port', async ({ harnessPage: page }) => {
  await holdNextPortOpen(page);

  const captured = await page.evaluate(() => window.__testHelpers.capture(async () => {
    const hamlib = await window.__hamlibHarness.createHamlib({});
    const model = hamlib.models.find((candidate) => candidate.model === 'TS-480');

    if (!model) { throw new Error('the TS-480 is missing from the catalogue'); }

    /* Start the open, then wait until its port open is actually parked. */
    const opening = window.__testHelpers.capture(
      () => hamlib.open({ modelId: model.id, baudRate: model.serialRateMax }),
    );

    await window.__virtualClock.until(() => window.__fakeSerial.openPending);

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

test('a later open after a cancelled one still works', async ({ harnessPage: page }) => {
  await holdNextPortOpen(page);

  const captured = await page.evaluate(() => window.__testHelpers.capture(async () => {
    const hamlib = await window.__hamlibHarness.createHamlib({});
    const model = hamlib.models.find((candidate) => candidate.model === 'TS-480');

    if (!model) { throw new Error('the TS-480 is missing from the catalogue'); }

    /* First attempt: cancelled through close() of the wrapper it would have
     * produced - here the cancelled attempt is the disposal race's rig. */
    const opening = window.__testHelpers.capture(
      () => hamlib.open({ modelId: model.id, baudRate: model.serialRateMax }),
    );

    await window.__virtualClock.until(() => window.__fakeSerial.openPending);

    const disposal = window.__testHelpers.capture(() => hamlib.dispose());

    window.__fakeSerial.releaseOpen();

    await disposal;
    await opening;

    /* A fresh instance must be able to take the same port again. */
    const second = await window.__hamlibHarness.createHamlib({});
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
