/**
 * The page must say so, visibly, when the browser cannot do Web Serial - and
 * must not offer to connect.
 */
import { expect, test } from '@playwright/test';

import { UPSTREAM_VERSION } from '../upstream';

const REACT_URL = 'http://127.0.0.1:4176/demo/';

test('reports that Web Serial is unavailable and keeps connect disabled', async ({ page }) => {
  /* A browser without Web Serial has no `serial` member at all, so remove the
   * accessor rather than shadow it with `undefined`.  Firefox builds that
   * predate Web Serial already lack it; deleting it again is harmless. */
  await page.addInitScript(() => {
    delete (Navigator.prototype as { serial?: unknown }).serial;
  });

  await page.goto(REACT_URL);
  await page.getByTestId('load-demo').click();

  const status = page.getByTestId('web-serial-status');

  await expect(status).toHaveAttribute('data-state', 'unavailable');
  await expect(status).toContainText('Web Serial unavailable');

  /* Hamlib still loads and its version is shown. */
  await expect(page.getByTestId('hamlib-version')).toContainText(UPSTREAM_VERSION);

  await expect(page.getByTestId('model-select')).toBeEnabled();
  await expect(page.getByTestId('connect-button')).toBeDisabled();
  await expect(page.getByTestId('disconnect-button')).toBeDisabled();
  await expect(page.getByTestId('error-message')).toHaveCount(0);
});
