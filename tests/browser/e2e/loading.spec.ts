/**
 * How the demo page arrives: on its own, unless the reader asked to save data,
 * with the call log opt-in and the reader's choices kept for the next visit.
 */
import { expect, test } from '@playwright/test';

import { UPSTREAM_VERSION } from '../upstream';

const REACT_URL = 'http://127.0.0.1:4176/demo/';

test('loads the demo without a click and hides the call log', async ({ page }) => {
  await page.goto(REACT_URL);

  await expect(page.getByTestId('hamlib-version')).toContainText(UPSTREAM_VERSION);
  await expect(page.getByTestId('demo-loading')).toHaveCount(0);
  await expect(page.getByTestId('load-demo')).toHaveCount(0);

  await expect(page.getByTestId('show-calls')).not.toBeChecked();
  await expect(page.getByTestId('call-log')).toHaveCount(0);
  await expect(page.getByTestId('backend-raw')).toHaveCount(0);
});

test('waits for a click when the browser asks to save data', async ({ page }) => {
  /* Firefox has no Network Information API; define the member either way. */
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'connection', {
      configurable: true,
      get: () => ({ saveData: true, effectiveType: '4g' }),
    });
  });

  await page.goto(REACT_URL);

  await expect(page.getByTestId('load-demo')).toBeVisible();
  await expect(page.getByTestId('model-select')).toHaveCount(0);
  expect(await page.evaluate(() => performance.getEntriesByType('resource')
    .some((entry) => entry.name.includes('hamlib-wasm.wasm')))).toBe(false);

  await page.getByTestId('load-demo').click();
  await expect(page.getByTestId('hamlib-version')).toContainText(UPSTREAM_VERSION);
});

test('remembers the model and the call log toggle across visits', async ({ page }) => {
  await page.goto(REACT_URL);

  await expect(page.getByTestId('model-select')).toBeEnabled();
  await page.getByTestId('model-select').selectOption({ label: 'FRG-100' });
  await page.getByTestId('show-calls').check();

  await page.reload();

  await expect(page.getByTestId('model-select')).toBeEnabled();
  await expect(page.getByTestId('model-select').locator('option:checked')).toHaveText('FRG-100');
  await expect(page.getByTestId('show-calls')).toBeChecked();
  await expect(page.getByTestId('call-log')).toBeVisible();
});
