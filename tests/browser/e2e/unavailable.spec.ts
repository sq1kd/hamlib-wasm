/**
 * The page must say so, visibly, when the browser cannot do Web Serial - and
 * must not offer to connect.
 */
import { expect, test } from '@playwright/test';

import { removeWebSerial } from '../fixtures';
import { UPSTREAM_VERSION } from '../upstream';

const REACT_URL = 'http://127.0.0.1:4176/demo/';

test('reports that Web Serial is unavailable and keeps connect disabled', async ({ page }) => {
  await removeWebSerial(page);

  await page.goto(REACT_URL);

  const status = page.getByTestId('web-serial-status');

  await expect(status).toHaveAttribute('data-state', 'unavailable');
  await expect(status).toContainText('Web Serial unavailable');

  /* Hamlib still loads and its version is shown. */
  await expect(page.getByTestId('hamlib-version')).toContainText(UPSTREAM_VERSION);

  await expect(page.getByTestId('model-select')).toBeEnabled();
  await expect(page.getByTestId('connect-button')).toBeDisabled();
  await expect(page.getByTestId('disconnect-button')).toHaveCount(0);
  await expect(page.getByTestId('error-message')).toHaveCount(0);
});
