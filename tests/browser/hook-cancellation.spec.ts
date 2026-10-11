/**
 * Connection cancellation as the React hooks implement it.
 *
 * The demo's own UI hides this: its Connect and Disconnect buttons are disabled
 * while a connection is pending, so no click can cancel one.  The hook harness
 * page drives `useEasyRig`/`useRigState` directly, and the Web Serial double
 * parks inside `SerialPort.open()`, so a spec can cancel an attempt that has
 * already reached the device and then assert both what the hooks published and
 * - through the emulator - that the port was released.
 */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import {
  holdNextPortOpen,
  installFakeSerial,
  installTestHelpers,
  readFakeSerial,
  releasePortOpen,
  waitForPortOpenPending,
} from './fixtures';
import type { HookSnapshot } from '../harness/src/hook-harness-types';

const HOOKS_URL = 'http://127.0.0.1:4174/hooks.html';

async function snapshot(page: Page): Promise<HookSnapshot> {
  return page.evaluate(() => window.__hookHarness.snapshot());
}

/** Wait for the provider to publish its catalogue. */
async function waitForReady(page: Page): Promise<void> {
  await expect.poll(async () => (await snapshot(page)).ready, { timeout: 60_000 }).toBe(true);
}

test.beforeEach(async ({ page }) => {
  await installFakeSerial(page);
  await installTestHelpers(page);
  await page.goto(HOOKS_URL);
  await waitForReady(page);
});

test('disconnect during a parked connect publishes nothing and releases the port', async ({ page }) => {
  await holdNextPortOpen(page);

  /* Not awaited: the attempt is still inside `SerialPort.open()`. */
  const parked = page.evaluate(() => window.__hookHarness.connect('TS-480'));

  await waitForPortOpenPending(page);
  expect((await snapshot(page)).connecting).toBe(true);

  await page.evaluate(() => window.__hookHarness.disconnect());
  await releasePortOpen(page);

  /* The superseded attempt resolves without publishing. */
  await parked;

  await expect.poll(async () => (await snapshot(page)).connecting).toBe(false);

  const published = await snapshot(page);

  expect(published.connected).toBe(false);
  expect(published.error).toBeNull();
  expect(published.hasState).toBe(false);

  /* It did reach the device, and it really was closed again. */
  await expect.poll(async () => (await readFakeSerial(page)).closeCount).toBe(1);

  const transport = await readFakeSerial(page);

  expect(transport.commands).toContain('ID');
  expect(transport.isOpen).toBe(false);
  expect(transport.closedWithLockedStreams).toBe(false);

  /* Nothing is wedged: a later connect still works. */
  await page.evaluate(() => window.__hookHarness.connect('TS-480'));
  await expect.poll(async () => (await snapshot(page)).connected).toBe(true);
  await expect.poll(async () => (await snapshot(page)).hasState).toBe(true);

  await page.evaluate(() => window.__hookHarness.disconnect());
  await expect.poll(async () => (await readFakeSerial(page)).isOpen).toBe(false);
  expect((await readFakeSerial(page)).closeCount).toBe(2);
});

test('removing the probe during a parked connect publishes nothing', async ({ page }) => {
  await holdNextPortOpen(page);

  const parked = page.evaluate(() => window.__hookHarness.connect('TS-480'));

  await waitForPortOpenPending(page);
  expect((await snapshot(page)).connecting).toBe(true);

  /* The provider stays mounted, so this is the hook's own effect cleanup -
   * the part a StrictMode remount runs and then undoes. */
  await page.evaluate(() => { window.__hookHarness.setProbeVisible(false); });
  await releasePortOpen(page);
  await parked;

  await expect.poll(async () => (await readFakeSerial(page)).closeCount).toBe(1);

  /* The snapshot published before the probe went away never held a rig. */
  const published = await page.evaluate(() => window.__hookHarness.lastPublished());

  expect(published.connected).toBe(false);

  const transport = await readFakeSerial(page);

  expect(transport.isOpen).toBe(false);
  expect(transport.closedWithLockedStreams).toBe(false);

  /* The probe can come back and connect for real. */
  await page.evaluate(() => { window.__hookHarness.setProbeVisible(true); });
  await page.evaluate(() => window.__hookHarness.connect('TS-480'));
  await expect.poll(async () => (await snapshot(page)).connected).toBe(true);
  await expect.poll(async () => (await snapshot(page)).hasState).toBe(true);

  await page.evaluate(() => window.__hookHarness.disconnect());
  await expect.poll(async () => (await readFakeSerial(page)).isOpen).toBe(false);
});

test('unmount during a parked connect leaves no owned rig', async ({ page }) => {
  await holdNextPortOpen(page);

  /* The attempt may reject: unmounting also disposes the module it opened
   * against.  Either way it must not publish, and it must not leak the port. */
  const parked = page.evaluate(
    () => window.__hookHarness.connect('TS-480').then(
      () => 'resolved',
      (error: unknown) => `rejected: ${String(error)}`,
    ),
  );

  await waitForPortOpenPending(page);
  await page.evaluate(() => window.__hookHarness.unmount());
  await releasePortOpen(page);
  await parked;

  await expect.poll(async () => (await readFakeSerial(page)).closeCount).toBe(1);

  const transport = await readFakeSerial(page);

  expect(transport.isOpen).toBe(false);
  expect(transport.closedWithLockedStreams).toBe(false);

  /* A fresh mount is unaffected: the harness reports nothing, then works. */
  expect((await snapshot(page)).connected).toBe(false);

  await page.evaluate(() => { window.__hookHarness.mount(); });
  await waitForReady(page);
  await page.evaluate(() => window.__hookHarness.connect('TS-480'));
  await expect.poll(async () => (await snapshot(page)).connected).toBe(true);
  await expect.poll(async () => (await snapshot(page)).hasState).toBe(true);

  await page.evaluate(() => window.__hookHarness.disconnect());
  await expect.poll(async () => (await readFakeSerial(page)).isOpen).toBe(false);
});

test('a closed rig publishes no further state', async ({ page }) => {
  await page.evaluate(() => window.__hookHarness.connect('TS-480'));
  await expect.poll(async () => (await snapshot(page)).connected).toBe(true);
  await expect.poll(async () => (await snapshot(page)).snapshots).toBeGreaterThan(0);

  await page.evaluate(() => window.__hookHarness.disconnect());
  await expect.poll(async () => (await readFakeSerial(page)).isOpen).toBe(false);

  const frozen = await snapshot(page);

  /* Well past five poll intervals: a scheduler that survived the close would
   * keep publishing. */
  await page.waitForTimeout(600);

  const after = await snapshot(page);

  expect(after.snapshots).toBe(frozen.snapshots);
  expect(after.connected).toBe(false);
  expect(after.hasState).toBe(false);
});
