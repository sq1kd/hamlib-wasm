/**
 * How the demo page arrives: on its own, unless the reader asked to save data,
 * with the call log beside the radio and the reader's model kept for the next
 * visit.
 */
import { expect, test } from '@playwright/test';

import { UPSTREAM_VERSION } from '../upstream';

const REACT_URL = 'http://127.0.0.1:4176/demo/';

test('loads the demo without a click, with the call log and its API switch', async ({ page }) => {
  await page.goto(REACT_URL);

  await expect(page.getByTestId('hamlib-version')).toContainText(UPSTREAM_VERSION);
  await expect(page.getByTestId('demo-loading')).toHaveCount(0);
  await expect(page.getByTestId('load-demo')).toHaveCount(0);

  await expect(page.getByTestId('call-log')).toBeVisible();
  await expect(page.getByTestId('backend-rig')).toBeChecked();
  await expect(page.getByTestId('backend-raw')).toBeEnabled();
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

test('remembers the model across visits', async ({ page }) => {
  await page.goto(REACT_URL);

  await expect(page.getByTestId('model-select')).toBeEnabled();
  await page.getByTestId('model-select').selectOption({ label: 'Yaesu FRG-100' });

  await page.reload();

  await expect(page.getByTestId('model-select')).toBeEnabled();
  await expect(page.getByTestId('model-select').locator('option:checked')).toHaveText('Yaesu FRG-100');
});
