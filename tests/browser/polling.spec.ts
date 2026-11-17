/**
 * Polling subscriptions and disposal ownership.
 *
 * One scheduler per rig, driven by independent registrations: several
 * consumers can poll at once, removing one leaves the others running, removing
 * the last stops the scheduler, and neither close() nor dispose() may publish
 * afterwards or leave a timer behind.
 *
 * The page runs on the virtual clock (fixtures/virtual-clock.ts), so a window
 * of polling is an exact span of virtual time: every tick due in it fires, in
 * order, however slowly the machine runs, and counts are asserted exactly.
 * "Nothing happens afterwards" is proved the same way - by letting virtual
 * time pass, and by the page having no timer left at all.
 */

import { expect, expectOk, test } from './fixtures';

test('two watchers coexist and removing one leaves the other polling', async ({ harnessPage: page }) => {
  const captured = await page.evaluate(() => window.__testHelpers.capture(async () => {
    const hamlib = await window.__hamlibHarness.createHamlib({});
    const model = hamlib.models.find((candidate) => candidate.model === 'TS-480');

    if (!model) { throw new Error('the TS-480 is missing from the catalogue'); }

    const rig = await hamlib.open({ modelId: model.id, baudRate: model.serialRateMax });
    let samples = 0;

    rig.on('state', () => { samples += 1; });

    const stopA = rig.watch({ intervalMs: 150 });
    const stopB = rig.watch({ intervalMs: 40 });

    /* A's interval is the slower one, so growth after B is removed can only
     * come from A still being registered. */
    await window.__virtualClock.advance(500);
    const withBoth = samples;

    stopB();
    await window.__virtualClock.advance(500);
    const afterRemovingB = samples;

    stopA();
    const timersAfterRemovingA = window.__virtualClock.pendingTimers();
    await window.__virtualClock.advance(400);
    const afterRemovingA = samples;

    await rig.close();
    await hamlib.dispose();

    return { withBoth, afterRemovingB, afterRemovingA, timersAfterRemovingA };
  }));

  const result = expectOk(captured);

  /* A TS-480 read costs no virtual time, so every tick publishes once.  In the
   * first 500 ms: A at 0, 150, 300, 450 and B at 0, 40, ..., 480 - 4 + 13. */
  expect(result.withBoth).toBe(17);
  /* B's unsubscribe did not disturb A: A alone at 600, 750, 900. */
  expect(result.afterRemovingB).toBe(20);
  /* Removing the last registration stopped the scheduler: no timer is left,
   * and 400 ms of virtual time later nothing more was published. */
  expect(result.timersAfterRemovingA).toBe(0);
  expect(result.afterRemovingA).toBe(20);
});

test('a slow read never accumulates poll work', async ({ harnessPage: page }) => {
  const captured = await page.evaluate(() => window.__testHelpers.capture(async () => {
    const hamlib = await window.__hamlibHarness.createHamlib({});
    const model = hamlib.models.find((candidate) => candidate.model === 'TS-480');

    if (!model) { throw new Error('the TS-480 is missing from the catalogue'); }

    const rig = await hamlib.open({ modelId: model.id, baudRate: model.serialRateMax });

    /* Every reply arrives after 400 ms, so one refresh spans more than a
     * second while the watch interval is 30 ms. */
    window.__fakeSerial.replyDelayMs = 400;
    const base = window.__fakeSerial.commands.length;
    const stop = rig.watch({ intervalMs: 30 });

    await window.__virtualClock.advance(900);

    /* Count the PTT read, which is the last of a refresh and cannot be served
     * from Hamlib's frequency cache; the total bounds the wire traffic. */
    const during = window.__fakeSerial.commands.slice(base);
    const pttReads = during.filter((command) => command === 'IF').length;

    stop();
    window.__fakeSerial.replyDelayMs = 0;
    await rig.close();
    await hamlib.dispose();

    return { pttReads, during };
  }));

  const result = expectOk(captured);

  /* Thirty ticks were due in the 900 ms, and exactly one refresh ran: the
   * frequency came from the cache the open filled, then MD and FW took 400 ms
   * each, and the PTT read was still waiting for its reply when the window
   * closed.  Nothing piled up behind it. */
  expect(result.pttReads).toBe(1);
  expect(result.during).toEqual(['MD', 'FW', 'IF']);
});

test('disposal with an active watcher closes the port and stops polling', async ({ harnessPage: page }) => {
  const captured = await page.evaluate(() => window.__testHelpers.capture(async () => {
    const hamlib = await window.__hamlibHarness.createHamlib({});
    const model = hamlib.models.find((candidate) => candidate.model === 'TS-480');

    if (!model) { throw new Error('the TS-480 is missing from the catalogue'); }

    const rig = await hamlib.open({ modelId: model.id, baudRate: model.serialRateMax });
    let samples = 0;

    rig.on('state', () => { samples += 1; });

    const stop = rig.watch({ intervalMs: 40 });

    await window.__virtualClock.advance(300);

    const polling = samples;
    const base = window.__fakeSerial.commands.length;

    await hamlib.dispose();

    const atDisposal = samples;
    const timersAtDisposal = window.__virtualClock.pendingTimers();

    await window.__virtualClock.advance(400);

    stop();

    return {
      polling,
      atDisposal,
      timersAtDisposal,
      afterDisposal: samples,
      commandsAfterDisposal: window.__fakeSerial.commands.length - base,
      connected: rig.connected,
      isOpen: window.__fakeSerial.isOpen,
      closeCount: window.__fakeSerial.closeCount,
      closedWithLockedStreams: window.__fakeSerial.closedWithLockedStreams,
    };
  }));

  const result = expectOk(captured);

  /* Ticks at 0, 40, ..., 280. */
  expect(result.polling).toBe(8);
  /* No publication and no read after disposal: the scheduler is gone, and
   * with it every timer. */
  expect(result.timersAtDisposal).toBe(0);
  expect(result.atDisposal).toBe(result.polling);
  expect(result.afterDisposal).toBe(result.atDisposal);
  expect(result.commandsAfterDisposal).toBe(0);
  expect(result.connected).toBe(false);
  expect(result.isOpen).toBe(false);
  expect(result.closeCount).toBe(1);
  expect(result.closedWithLockedStreams).toBe(false);
});

test('closing the raw rig behind the wrapper stops the scheduler', async ({ harnessPage: page }) => {
  const captured = await page.evaluate(() => window.__testHelpers.capture(async () => {
    const hamlib = await window.__hamlibHarness.createHamlib({});
    const model = hamlib.models.find((candidate) => candidate.model === 'TS-480');

    if (!model) { throw new Error('the TS-480 is missing from the catalogue'); }

    const rig = await hamlib.open({ modelId: model.id, baudRate: model.serialRateMax });

    rig.watch({ intervalMs: 40 });
    await window.__virtualClock.advance(250);

    /* The escape hatch closes the port without going through the wrapper. */
    await rig.raw.close();

    const base = window.__fakeSerial.commands.length;
    await window.__virtualClock.advance(400);

    const result = {
      timersAfterRawClose: window.__virtualClock.pendingTimers(),
      connected: rig.connected,
      commandsAfterRawClose: window.__fakeSerial.commands.length - base,
      isOpen: window.__fakeSerial.isOpen,
    };

    await hamlib.dispose();
    return result;
  }));

  const result = expectOk(captured);

  expect(result.connected).toBe(false);
  /* The next tick found the rig closed and stopped its own timer. */
  expect(result.timersAfterRawClose).toBe(0);
  expect(result.commandsAfterRawClose).toBe(0);
  expect(result.isOpen).toBe(false);
});

test('a closed wrapper publishes nothing more', async ({ harnessPage: page }) => {
  const captured = await page.evaluate(() => window.__testHelpers.capture(async () => {
    const hamlib = await window.__hamlibHarness.createHamlib({});
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
    await window.__virtualClock.advance(250);

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

test('a second instance can reuse the port after the first cleaned up', async ({ harnessPage: page }) => {
  const captured = await page.evaluate(() => window.__testHelpers.capture(async () => {
    const first = await window.__hamlibHarness.createHamlib({});
    const model = first.models.find((candidate) => candidate.model === 'TS-480');

    if (!model) { throw new Error('the TS-480 is missing from the catalogue'); }

    const rigA = await first.open({ modelId: model.id, baudRate: model.serialRateMax });

    rigA.watch({ intervalMs: 40 });
    await rigA.close();
    await first.dispose();

    const second = await window.__hamlibHarness.createHamlib({});
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

test('watching a closed rig is refused', async ({ harnessPage: page }) => {
  const captured = await page.evaluate(() => window.__testHelpers.capture(async () => {
    const hamlib = await window.__hamlibHarness.createHamlib({});
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
