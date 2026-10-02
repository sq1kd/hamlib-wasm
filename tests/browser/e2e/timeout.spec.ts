/**
 * Timeout path: a query that gets no answer must surface a Hamlib timeout,
 * leave the rig connected, and succeed on the next attempt without
 * reconnecting.
 */
import { expect, test } from '@playwright/test';

import { installFakeSerial, setEmulatorSilent } from '../fixtures';
import { UPSTREAM_VERSION } from '../upstream';
import { connectTs480 } from './helpers';

test.beforeEach(async ({ page }) => {
  await installFakeSerial(page);

  await page.goto('/');

  await expect(page.getByTestId('hamlib-version')).toContainText(UPSTREAM_VERSION);
});

test('reports a Hamlib timeout and recovers on the next refresh', async ({ page }) => {
  await connectTs480(page);
  await expect(page.getByTestId('status-frequency')).toHaveText('14074000');
  await expect(page.getByTestId('error-section')).toBeHidden();

  /* The emulator stops answering: the next read runs into Hamlib's timeout
   * (TS-480 caps: 500 ms, 3 retries).  Wait out Hamlib's own 500 ms cache
   * window first, so the refresh is guaranteed to reach the wire. */
  await setEmulatorSilent(page, true);
  await page.waitForTimeout(600);
  await page.getByTestId('refresh-button').click();

  /* While the read is in flight the page reports a busy state and disables
   * the actions that would re-enter the transport. */
  await expect(page.getByTestId('refresh-button')).toBeDisabled();
  await expect(page.getByTestId('frequency-set')).toBeDisabled();
  await expect(page.getByTestId('ptt-set')).toBeDisabled();
  await expect(page.getByTestId('disconnect-button')).toBeDisabled();

  const message = page.getByTestId('error-message');
  const detail = page.getByTestId('error-detail');

  await expect(message).toContainText('communication timed out', { timeout: 30_000 });
  await expect(message).toContainText('getFrequency');
  await expect(detail).toContainText('operation: getFrequency');
  await expect(detail).toContainText('code: HAMLIB_ERROR');
  /* -RIG_ETIMEOUT */
  await expect(detail).toContainText('hamlib: -5 (communication timed out)');

  /* Still connected: the failure is reported, not fatal. */
  await expect(page.getByTestId('disconnect-button')).toBeEnabled();
  await expect(page.getByTestId('connection-state')).toContainText('connected');

  /* The emulator answers again: the next refresh succeeds. */
  await setEmulatorSilent(page, false);
  await page.getByTestId('refresh-button').click();

  await expect(page.getByTestId('status-frequency')).toHaveText('14074000');
  await expect(page.getByTestId('status-mode')).toHaveText('USB');
  await expect(page.getByTestId('error-section')).toBeHidden();

  await page.getByTestId('disconnect-button').click();
  await expect(page.getByTestId('connection-state')).toHaveText('disconnected');
});
