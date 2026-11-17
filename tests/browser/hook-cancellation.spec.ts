/**
 * Connection cancellation as the React hooks implement it.
 *
 * The demo's own UI hides this: its Connect and Disconnect buttons are disabled
 * while a connection is pending, so no click can cancel one.  The hook harness
 * page drives `useRig`/`useRigState` directly, and the Web Serial double
 * parks inside `SerialPort.open()`, so a spec can cancel an attempt that has
 * already reached the device and then assert both what the hooks published and
 * - through the emulator - that the port was released.
 *
 * The page runs on a *manual* virtual clock (fixtures/virtual-clock.ts): the
 * spec drives it across several `page.evaluate()` calls while timers are
 * armed - the probe polls on an interval, a parked connect has its watchdog
 * running - so time moves only when a step says so.  Each step runs the clock
 * until the promise it started settles, or until the emulator reaches the
 * state it waits for; React's renders are timers too, so every step returns
 * with the hooks' output committed, and is asserted directly.
 */
import type { Page } from '@playwright/test';

import {
  advanceClock,
  expect,
  holdNextPortOpen,
  pendingTimers,
  readFakeSerial,
  releasePortOpen,
  test,
  waitForPortOpenPending,
} from './fixtures';
import { POLL_MS } from '../harness/src/hook-harness-types';
import type { HookSnapshot } from '../harness/src/hook-harness-types';

async function snapshot(page: Page): Promise<HookSnapshot> {
  return page.evaluate(() => window.__hookHarness.snapshot());
}

/**
 * Wait for the provider to publish its catalogue.
 *
 * Loading the module is network and compilation, not time, so this is a
 * condition the driver polls for.
 */
async function waitForReady(page: Page): Promise<void> {
  await expect.poll(async () => (await snapshot(page)).ready, { timeout: 60_000 }).toBe(true);
}

/**
 * Start a connect and leave it pending in the page, recording how it ends.
 *
 * Not awaited: a held one stays inside `SerialPort.open()`.
 */
async function startConnect(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__pendingHookCall = window.__hookHarness.connect('TS-480').then(
      () => 'resolved',
      (error: unknown) => `rejected: ${String(error)}`,
    );
  });
}

/** Run the clock until the connect {@link startConnect} began has settled. */
async function settleConnect(page: Page): Promise<string> {
  return page.evaluate(() => {
    const pending = window.__pendingHookCall;

    if (pending === undefined) { throw new Error('no connect is pending'); }

    return window.__virtualClock.settle(pending);
  });
}

/** Connect for real and run one poll interval, so the probe holds a snapshot. */
async function connectAndPoll(page: Page): Promise<void> {
  await startConnect(page);
  expect(await settleConnect(page)).toBe('resolved');
  await advanceClock(page, POLL_MS);
}

async function disconnect(page: Page): Promise<void> {
  await page.evaluate(() => window.__virtualClock.settle(window.__hookHarness.disconnect()));
}

/** Run the clock until the emulator has seen `count` port closes. */
async function untilClosed(page: Page, count: number): Promise<void> {
  await page.evaluate(
    (closes: number) => window.__virtualClock.until(
      () => window.__fakeSerial.closeCount === closes,
    ),
    count,
  );
}

test.use({ clockMode: 'manual', harnessPath: '/hooks.html' });

test.beforeEach(async ({ harnessPage: page }) => {
  await waitForReady(page);
});

test('disconnect during a parked connect publishes nothing and releases the port', async ({ harnessPage: page }) => {
  await holdNextPortOpen(page);
  await startConnect(page);
  await waitForPortOpenPending(page);
  expect((await snapshot(page)).connecting).toBe(true);

  await disconnect(page);
  await releasePortOpen(page);

  /* The superseded attempt resolves without publishing. */
  expect(await settleConnect(page)).toBe('resolved');

  /* It did reach the device, and it really was closed again. */
  await untilClosed(page, 1);

  const published = await snapshot(page);

  expect(published.connecting).toBe(false);
  expect(published.connected).toBe(false);
  expect(published.error).toBeNull();
  expect(published.hasState).toBe(false);

  const transport = await readFakeSerial(page);

  expect(transport.commands).toContain('ID');
  expect(transport.isOpen).toBe(false);
  expect(transport.closedWithLockedStreams).toBe(false);

  /* Nothing is wedged: a later connect still works. */
  await connectAndPoll(page);
  expect((await snapshot(page)).connected).toBe(true);
  expect((await snapshot(page)).hasState).toBe(true);

  await disconnect(page);
  expect((await readFakeSerial(page)).isOpen).toBe(false);
  expect((await readFakeSerial(page)).closeCount).toBe(2);
});

test('removing the probe during a parked connect publishes nothing', async ({ harnessPage: page }) => {
  await holdNextPortOpen(page);
  await startConnect(page);
  await waitForPortOpenPending(page);
  expect((await snapshot(page)).connecting).toBe(true);

  /* The provider stays mounted, so this is the hook's own effect cleanup -
   * the part a StrictMode remount runs and then undoes. */
  await page.evaluate(() => { window.__hookHarness.setProbeVisible(false); });
  await releasePortOpen(page);
  await settleConnect(page);
  await untilClosed(page, 1);

  /* The snapshot published before the probe went away never held a rig. */
  const published = await page.evaluate(() => window.__hookHarness.lastPublished());

  expect(published.connected).toBe(false);

  const transport = await readFakeSerial(page);

  expect(transport.isOpen).toBe(false);
  expect(transport.closedWithLockedStreams).toBe(false);

  /* The probe can come back and connect for real. */
  await page.evaluate(() => { window.__hookHarness.setProbeVisible(true); });
  await connectAndPoll(page);
  expect((await snapshot(page)).connected).toBe(true);
  expect((await snapshot(page)).hasState).toBe(true);

  await disconnect(page);
  expect((await readFakeSerial(page)).isOpen).toBe(false);
});

test('unmount during a parked connect leaves no owned rig', async ({ harnessPage: page }) => {
  await holdNextPortOpen(page);

  /* The attempt may reject: unmounting also disposes the module it opened
   * against.  Either way it must not publish, and it must not leak the port. */
  await startConnect(page);
  await waitForPortOpenPending(page);
  await page.evaluate(() => window.__hookHarness.unmount());
  await releasePortOpen(page);
  await settleConnect(page);
  await untilClosed(page, 1);

  const transport = await readFakeSerial(page);

  expect(transport.isOpen).toBe(false);
  expect(transport.closedWithLockedStreams).toBe(false);

  /* A fresh mount is unaffected: the harness reports nothing, then works. */
  expect((await snapshot(page)).connected).toBe(false);

  await page.evaluate(() => { window.__hookHarness.mount(); });
  await waitForReady(page);
  await connectAndPoll(page);
  expect((await snapshot(page)).connected).toBe(true);
  expect((await snapshot(page)).hasState).toBe(true);

  await disconnect(page);
  expect((await readFakeSerial(page)).isOpen).toBe(false);
});

test('a closed rig publishes no further state', async ({ harnessPage: page }) => {
  await connectAndPoll(page);

  const polling = await snapshot(page);

  expect(polling.connected).toBe(true);
  expect(polling.snapshots).toBeGreaterThan(0);

  await disconnect(page);
  expect((await readFakeSerial(page)).isOpen).toBe(false);

  const frozen = await snapshot(page);

  /* Six poll intervals of virtual time: a scheduler that survived the close
   * would have fired in them.  None is left to fire. */
  expect(await pendingTimers(page)).toBe(0);
  await advanceClock(page, 6 * POLL_MS);

  const after = await snapshot(page);

  expect(after.snapshots).toBe(frozen.snapshots);
  expect(after.connected).toBe(false);
  expect(after.hasState).toBe(false);
});
