/**
 * Polling subscriptions and disposal ownership.
 *
 * One scheduler per easy rig, driven by independent registrations: several
 * consumers can poll at once, removing one leaves the others running, removing
 * the last stops the scheduler, and neither close() nor dispose() may publish
 * afterwards or leave a timer behind.
 */
import { expect, test } from '@playwright/test';

import { installFakeSerial, installTestHelpers } from './fixtures';
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

test('two watchers coexist and removing one leaves the other polling', async ({ page }) => {
  const captured = await page.evaluate(() => window.__testHelpers.capture(async () => {
    const hamlib = await window.__hamlibHarness.createEasy({});
    const model = hamlib.models.find((candidate) => candidate.model === 'TS-480');

    if (!model) { throw new Error('the TS-480 is missing from the catalogue'); }

    const rig = await hamlib.open({ modelId: model.id, baudRate: model.serialRateMax });
    let samples = 0;

    rig.on('state', () => { samples += 1; });

    const stopA = rig.watch({ intervalMs: 150 });
    const stopB = rig.watch({ intervalMs: 40 });

    /* A's interval is the slower one, so growth after B is removed can only
     * come from A still being registered. */
    await window.__testHelpers.sleep(500);
    const withBoth = samples;

    stopB();
    await window.__testHelpers.sleep(500);
    const afterRemovingB = samples;

    stopA();
    await window.__testHelpers.sleep(400);
    const afterRemovingA = samples;

    await rig.close();
    await hamlib.dispose();

    return { withBoth, afterRemovingB, afterRemovingA };
  }));

  const result = expectOk(captured);

  expect(result.withBoth).toBeGreaterThan(0);
  /* B's unsubscribe did not disturb A. */
  expect(result.afterRemovingB).toBeGreaterThan(result.withBoth);
  /* Removing the last registration stopped the scheduler. */
  expect(result.afterRemovingA).toBe(result.afterRemovingB);
});

test('a slow read never accumulates poll work', async ({ page }) => {
  const captured = await page.evaluate(() => window.__testHelpers.capture(async () => {
    const hamlib = await window.__hamlibHarness.createEasy({});
    const model = hamlib.models.find((candidate) => candidate.model === 'TS-480');

    if (!model) { throw new Error('the TS-480 is missing from the catalogue'); }

    const rig = await hamlib.open({ modelId: model.id, baudRate: model.serialRateMax });

    /* Every reply arrives after 400 ms, so one refresh spans more than a
     * second while the watch interval is 30 ms. */
    window.__fakeSerial.replyDelayMs = 400;
    const base = window.__fakeSerial.commands.length;
    const stop = rig.watch({ intervalMs: 30 });

    await window.__testHelpers.sleep(900);

    /* Count the PTT read, which is the last of a refresh and cannot be served
     * from Hamlib's frequency cache; the total bounds the wire traffic. */
    const during = window.__fakeSerial.commands.slice(base);
    const pttReads = during.filter((command) => command === 'IF').length;

    stop();
    window.__fakeSerial.replyDelayMs = 0;
    await rig.close();
    await hamlib.dispose();

    return { pttReads, total: during.length };
  }));

  const result = expectOk(captured);

  /* Roughly thirty ticks were due: one refresh started, and nothing piled up
   * behind it. */
  expect(result.pttReads).toBe(1);
  expect(result.total).toBeLessThanOrEqual(4);
});

test('disposal with an active watcher closes the port and stops polling', async ({ page }) => {
  const captured = await page.evaluate(() => window.__testHelpers.capture(async () => {
    const hamlib = await window.__hamlibHarness.createEasy({});
    const model = hamlib.models.find((candidate) => candidate.model === 'TS-480');

    if (!model) { throw new Error('the TS-480 is missing from the catalogue'); }

    const rig = await hamlib.open({ modelId: model.id, baudRate: model.serialRateMax });
    let samples = 0;

    rig.on('state', () => { samples += 1; });

    const stop = rig.watch({ intervalMs: 40 });

    await window.__testHelpers.sleep(300);

    const polling = samples;
    const base = window.__fakeSerial.commands.length;

    await hamlib.dispose();

    const atDisposal = samples;

    await window.__testHelpers.sleep(400);

    stop();

    return {
      polling,
      atDisposal,
      afterDisposal: samples,
      commandsAfterDisposal: window.__fakeSerial.commands.length - base,
      connected: rig.connected,
      isOpen: window.__fakeSerial.isOpen,
      closeCount: window.__fakeSerial.closeCount,
      closedWithLockedStreams: window.__fakeSerial.closedWithLockedStreams,
    };
  }));

  const result = expectOk(captured);

  expect(result.polling).toBeGreaterThan(0);
  /* No publication and no read after disposal: the scheduler is gone. */
  expect(result.afterDisposal).toBe(result.atDisposal);
  expect(result.commandsAfterDisposal).toBe(0);
  expect(result.connected).toBe(false);
  expect(result.isOpen).toBe(false);
  expect(result.closeCount).toBe(1);
  expect(result.closedWithLockedStreams).toBe(false);
});

test('closing the raw rig behind the wrapper stops the scheduler', async ({ page }) => {
  const captured = await page.evaluate(() => window.__testHelpers.capture(async () => {
    const hamlib = await window.__hamlibHarness.createEasy({});
    const model = hamlib.models.find((candidate) => candidate.model === 'TS-480');

    if (!model) { throw new Error('the TS-480 is missing from the catalogue'); }

    const rig = await hamlib.open({ modelId: model.id, baudRate: model.serialRateMax });

    rig.watch({ intervalMs: 40 });
    await window.__testHelpers.sleep(250);

    /* The escape hatch closes the port without going through the wrapper. */
    await rig.raw.close();

    const base = window.__fakeSerial.commands.length;
    await window.__testHelpers.sleep(400);

    const result = {
      connected: rig.connected,
      commandsAfterRawClose: window.__fakeSerial.commands.length - base,
      isOpen: window.__fakeSerial.isOpen,
    };

    await hamlib.dispose();
    return result;
  }));

  const result = expectOk(captured);

  expect(result.connected).toBe(false);
  expect(result.commandsAfterRawClose).toBe(0);
  expect(result.isOpen).toBe(false);
});

test('a closed wrapper publishes nothing more', async ({ page }) => {
  const captured = await page.evaluate(() => window.__testHelpers.capture(async () => {
    const hamlib = await window.__hamlibHarness.createEasy({});
    const model = hamlib.models.find((candidate) => candidate.model === 'TS-480');

    if (!model) { throw new Error('the TS-480 is missing from the catalogue'); }

    const rig = await hamlib.open({ modelId: model.id, baudRate: model.serialRateMax });
    let samples = 0;

    rig.on('state', () => { samples += 1; });

    await rig.refresh();

    const beforeClose = samples;

    /* A read already queued behind the close must not publish. */
    const queued = window.__testHelpers.capture(() => rig.refresh());

    await rig.close();
    const failure = await queued;
    await window.__testHelpers.sleep(250);

    const result = {
      beforeClose,
      afterClose: samples,
      queuedOk: failure.ok,
      queuedCode: failure.ok ? null : failure.error.code,
      connected: rig.connected,
    };

    await hamlib.dispose();
    return result;
  }));

  const result = expectOk(captured);

  expect(result.beforeClose).toBe(1);
  expect(result.afterClose).toBe(1);
  expect(result.queuedOk).toBe(false);
  expect(result.queuedCode).toBe('RIG_CLOSED');
  expect(result.connected).toBe(false);
});

test('a second instance can reuse the port after the first cleaned up', async ({ page }) => {
  const captured = await page.evaluate(() => window.__testHelpers.capture(async () => {
    const first = await window.__hamlibHarness.createEasy({});
    const model = first.models.find((candidate) => candidate.model === 'TS-480');

    if (!model) { throw new Error('the TS-480 is missing from the catalogue'); }

    const rigA = await first.open({ modelId: model.id, baudRate: model.serialRateMax });

    rigA.watch({ intervalMs: 40 });
    await rigA.close();
    await first.dispose();

    const second = await window.__hamlibHarness.createEasy({});
    const rigB = await second.open({ modelId: model.id, baudRate: model.serialRateMax });
    const state = await rigB.refresh();

    await rigB.close();
    await second.dispose();

    return {
      frequency: state.frequency ?? null,
      openCount: window.__fakeSerial.openCount,
      closeCount: window.__fakeSerial.closeCount,
      isOpen: window.__fakeSerial.isOpen,
      closedWithLockedStreams: window.__fakeSerial.closedWithLockedStreams,
    };
  }));

  const result = expectOk(captured);

  expect(result.frequency).toBe(14_074_000);
  expect(result.openCount).toBe(2);
  expect(result.closeCount).toBe(2);
  expect(result.isOpen).toBe(false);
  expect(result.closedWithLockedStreams).toBe(false);
});

test('watching a closed rig is refused', async ({ page }) => {
  const captured = await page.evaluate(() => window.__testHelpers.capture(async () => {
    const hamlib = await window.__hamlibHarness.createEasy({});
    const model = hamlib.models.find((candidate) => candidate.model === 'TS-480');

    if (!model) { throw new Error('the TS-480 is missing from the catalogue'); }

    const rig = await hamlib.open({ modelId: model.id, baudRate: model.serialRateMax });
    await rig.close();

    const refusal = window.__testHelpers.capture(() => {
      rig.watch({ intervalMs: 100 });
      return null;
    });

    await hamlib.dispose();
    return refusal;
  }));

  const result = expectOk(captured);

  expect(result.ok).toBe(false);
  expect(result.ok ? null : result.error.code).toBe('RIG_CLOSED');
});
