/**
 * The example must say so, visibly, when the browser cannot do Web Serial -
 * and must not offer to connect.
 */
import { expect, test } from '@playwright/test';

import { UPSTREAM_VERSION } from '../upstream';

test('reports that Web Serial is unavailable and keeps connect disabled', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'serial', {
      value: undefined,
      configurable: true,
    });
  });

  await page.goto('/');

  const status = page.getByTestId('web-serial-status');

  await expect(status).toHaveAttribute('data-state', 'unavailable');
  await expect(status).toContainText('not available');

  /* Hamlib still loads and its version is shown. */
  await expect(page.getByTestId('hamlib-version')).toContainText(UPSTREAM_VERSION);

  await expect(page.getByTestId('connect-button')).toBeDisabled();
  await expect(page.getByTestId('refresh-button')).toBeDisabled();
  await expect(page.getByTestId('disconnect-button')).toBeDisabled();
  await expect(page.getByTestId('error-section')).toBeHidden();
});
