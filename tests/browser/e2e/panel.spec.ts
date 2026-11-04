/**
 * The React page against a capability-limited model, plus the ownership and
 * error-display contracts the panel depends on.
 *
 * Three things the easy/native backends must agree on are proved here:
 *
 *  - a model whose telemetry is only part of the surface stays connected, shows
 *    the missing fields as unknown, and can be disconnected;
 *  - a telemetry read that fails after the port is acquired is reported as a
 *    telemetry failure, never as a failed connection, so cleanup stays
 *    available;
 *  - a rejected command reaches the error display, because the panel callbacks
 *    discard the rejected promise.
 */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import {
  holdNextPortOpen,
  installFakeSerial,
  installTestHelpers,
  readFakeSerial,
  releasePortOpen,
  setEmulatorSilent,
  setWritesFailing,
  useRig,
  waitForPortOpenPending,
} from '../fixtures';

const REACT_URL = 'http://127.0.0.1:4176/demo/';

test.beforeEach(async ({ page }) => {
  await installFakeSerial(page);
  await installTestHelpers(page);
});

async function selectModel(page: Page, label: string): Promise<void> {
  await expect(page.getByTestId('model-select')).toBeEnabled();
  await page.getByTestId('model-select').selectOption({ label });
}

test('a frequency-only model connects, shows unknown fields and disconnects', async ({ page }) => {
  await page.goto(REACT_URL);
  await page.getByTestId('load-demo').click();

  /* The FRG-100 receiver: its backend declares frequency only. */
  await useRig(page, 'yaesu-frg100');

  await selectModel(page, 'FRG-100');
  await page.getByTestId('connect-button').click();

  await expect(page.getByTestId('connection-state')).toHaveAttribute('data-state', 'connected');
  await expect(page.getByTestId('frequency-display')).toHaveText('7,050,000');

  /* Fields the model cannot read stay visibly unknown - never invented. */
  await expect(page.getByTestId('mode-display')).toHaveText('—');
  await expect(page.getByTestId('passband-display')).toHaveText('—');
  await expect(page.getByTestId('ptt-state')).toHaveAttribute('data-state', 'unknown');

  /* Gating follows capability: relative tuning needs a known frequency,
   * absolute entry only the setter, mode only the setter, passband the current
   * mode, and PTT is unavailable on a receiver. */
  await expect(page.getByTestId('tune-up')).toBeEnabled();
  await expect(page.getByTestId('frequency-input')).toBeEnabled();
  await expect(page.getByTestId('mode-CW')).toBeEnabled();
  await expect(page.getByTestId('passband-normal')).toBeDisabled();
  await expect(page.getByTestId('ptt-on')).toBeDisabled();
  await expect(page.getByTestId('ptt-off')).toBeDisabled();

  /* The setter works even though the mode cannot be read back. */
  await page.getByTestId('frequency-input').fill('7100000');
  await page.getByTestId('frequency-set').click();
  await expect(page.getByTestId('frequency-display')).toHaveText('7,100,000');

  await page.getByTestId('disconnect-button').click();
  await expect(page.getByTestId('connection-state')).toHaveAttribute('data-state', 'disconnected');

  /* The panel discards the rejection of the close, so the port release is
   * observed rather than assumed. */
  await expect.poll(async () => (await readFakeSerial(page)).isOpen).toBe(false);
  expect((await readFakeSerial(page)).closeCount).toBe(1);
});

test('a rig that never answers fails the acquisition loudly and releases the port', async ({ page }) => {
  await page.goto(REACT_URL);
  await page.getByTestId('load-demo').click();
  await useRig(page, 'yaesu-frg100');
  await page.getByTestId('backend-native').check();

  /* Park the acquisition at the port chooser, silence the emulator, then let it
   * through: the FRG-100 backend's open path writes one frame, and with nothing
   * answering the rig never speaks at all. */
  await holdNextPortOpen(page);
  await selectModel(page, 'FRG-100');
  await page.getByTestId('connect-button').click();
  await waitForPortOpenPending(page);

  await setEmulatorSilent(page, true);
  await releasePortOpen(page);

  /* A port that opened onto nothing is not a connection: nothing is published,
   * the failure names what to check, and the port is given back rather than
   * held by a rig that cannot be used.  (A rig that goes quiet *after* it has
   * answered is the other case - see the timeout scenario, where the failure
   * stays telemetry and the rig stays owned.) */
  await expect(page.getByTestId('connection-state')).toHaveAttribute('data-state', 'disconnected');
  await expect(page.getByTestId('error-message')).toContainText('nothing arrived', {
    timeout: 30_000,
  });
  await expect(page.getByTestId('error-message')).toContainText('baud');
  await expect(page.getByTestId('frequency-display')).toHaveText('---.---.---');
  await expect(page.getByTestId('disconnect-button')).toBeDisabled();

  await expect.poll(async () => (await readFakeSerial(page)).isOpen).toBe(false);
  expect((await readFakeSerial(page)).closeCount).toBe(1);
});

test('a rejected command reaches the error display of the native backend', async ({ page }) => {
  await page.goto(REACT_URL);
  await page.getByTestId('load-demo').click();
  await page.getByTestId('backend-native').check();

  await expect(page.getByTestId('model-select')).toBeEnabled();
  await page.getByTestId('connect-button').click();
  await expect(page.getByTestId('connection-state')).toHaveAttribute('data-state', 'connected');
  await expect(page.getByTestId('frequency-display')).toHaveText('14,074,000');

  /* The emulator refuses writes but keeps answering reads, so the PTT command
   * fails on its own without a poll failure racing it for the same error slot. */
  await setWritesFailing(page, true);
  await page.getByTestId('ptt-off').click();

  /* The panel callback discards the rejection, so the failure has to be in the
   * backend error state to be visible at all. */
  await expect(page.getByTestId('error-message')).toContainText('setPtt', { timeout: 30_000 });

  /* Still owned: a rejected command is reported, not fatal. */
  await expect(page.getByTestId('connection-state')).toHaveAttribute('data-state', 'connected');
  await expect(page.getByTestId('disconnect-button')).toBeEnabled();

  /* A rejected stream requires a new connection, but the failed action must
   * not poison the panel queue used by that connection. */
  await setWritesFailing(page, false);
  await page.getByTestId('disconnect-button').click();
  await expect.poll(async () => (await readFakeSerial(page)).isOpen).toBe(false);
  await page.getByTestId('connect-button').click();
  await expect(page.getByTestId('frequency-display')).toHaveText('14,074,000');
  await page.getByTestId('frequency-input').fill('7074000');
  await page.getByTestId('frequency-set').click();
  await expect(page.getByTestId('frequency-display')).toHaveText('7,074,000');
});
