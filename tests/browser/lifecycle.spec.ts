/**
 * Lifecycle ownership regressions.
 *
 * An `open()` that was accepted before `dispose()` must never survive the
 * disposal: it either completes and is closed again, or it is rejected.  The
 * Web Serial double is the witness - a rig that stayed open would leave the
 * fake port open or a locked stream behind.
 */
import { expect, test } from '@playwright/test';

import { installFakeSerial, installTestHelpers, readFakeSerial } from './fixtures';
import type { Captured, HamlibErrorView } from './globals';

const HARNESS_URL = 'http://127.0.0.1:4174/';

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

test('disposal during an accepted open closes the rig and rejects the open', async ({ page }) => {
  const captured = await page.evaluate(() => window.__testHelpers.capture(async () => {
    const hamlib = await window.__hamlibHarness.createHamlib();
    const port = await hamlib.requestPort();
    const ts480 = hamlib.models.find((model) => model.model === 'TS-480');

    if (!ts480) {
      throw new Error('the TS-480 model is missing');
    }

    /* open() reaches the queue synchronously, so this is the exact race: the
     * open is accepted, dispose() is requested while it waits on the chain. */
    const pendingOpen = window.__testHelpers.capture(
      () => hamlib.open({ modelId: ts480.id, port }),
    );
    const disposal = window.__testHelpers.capture(() => hamlib.dispose());

    const [open, dispose] = await Promise.all([pendingOpen, disposal]);

    const afterDispose = await window.__testHelpers.capture(() => hamlib.open({
      modelId: ts480.id,
      port,
    }));

    return { open, dispose, afterDispose };
  }));

  const result = expectOk(captured);

  expectOk(result.dispose);

  const open = expectFailure(result.open);
  expect(open.code).toBe('DISPOSED');
  expect(open.operation).toBe('open');

  const afterDispose = expectFailure(result.afterDispose);
  expect(afterDispose.code).toBe('DISPOSED');

  const transport = await readFakeSerial(page);

  /* The open really reached the device, and disposal really released it. */
  expect(transport.commands).toContain('ID');
  expect(transport.openCount).toBe(1);
  expect(transport.closeCount).toBe(1);
  expect(transport.isOpen).toBe(false);
  expect(transport.closedWithLockedStreams).toBe(false);
});

test('disposal is idempotent and releases a port that raced with it', async ({ page }) => {
  const captured = await page.evaluate(() => window.__testHelpers.capture(async () => {
    const hamlib = await window.__hamlibHarness.createHamlib();
    const port = await hamlib.requestPort();
    const ts480 = hamlib.models.find((model) => model.model === 'TS-480');

    if (!ts480) {
      throw new Error('the TS-480 model is missing');
    }

    const pendingOpen = window.__testHelpers.capture(
      () => hamlib.open({ modelId: ts480.id, port }),
    );
    const first = window.__testHelpers.capture(() => hamlib.dispose());
    const second = window.__testHelpers.capture(() => hamlib.dispose());
    const third = window.__testHelpers.capture(() => hamlib.dispose());

    const [open, firstDispose, secondDispose, thirdDispose] = await Promise.all([
      pendingOpen,
      first,
      second,
      third,
    ]);

    return { open, firstDispose, secondDispose, thirdDispose };
  }));

  const result = expectOk(captured);

  expectFailure(result.open);
  expectOk(result.firstDispose);
  expectOk(result.secondDispose);
  expectOk(result.thirdDispose);

  const transport = await readFakeSerial(page);

  expect(transport.openCount).toBe(1);
  expect(transport.closeCount).toBe(1);
  expect(transport.isOpen).toBe(false);
  expect(transport.closedWithLockedStreams).toBe(false);
});

test('a later instance can use the same port after a raced disposal', async ({ page }) => {
  const captured = await page.evaluate(() => window.__testHelpers.capture(async () => {
    const first = await window.__hamlibHarness.createHamlib();
    const port = await first.requestPort();
    const ts480 = first.models.find((model) => model.model === 'TS-480');

    if (!ts480) {
      throw new Error('the TS-480 model is missing');
    }

    const pendingOpen = window.__testHelpers.capture(
      () => first.open({ modelId: ts480.id, port }),
    );
    const disposal = window.__testHelpers.capture(() => first.dispose());
    await Promise.all([pendingOpen, disposal]);

    /* Nothing from the disposed instance may still hold the device. */
    const second = await window.__hamlibHarness.createHamlib();
    const rig = await second.open({ modelId: ts480.id, port });
    const frequency = await rig.getFrequency();
    await rig.close();
    await second.dispose();

    return frequency;
  }));

  expect(expectOk(captured)).toBe(14_074_000);

  const transport = await readFakeSerial(page);

  expect(transport.openCount).toBe(2);
  expect(transport.closeCount).toBe(2);
  expect(transport.isOpen).toBe(false);
  expect(transport.closedWithLockedStreams).toBe(false);
});
