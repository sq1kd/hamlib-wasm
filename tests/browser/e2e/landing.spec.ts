/**
 * The landing page's radio: the demo's panel as plain HTML until a reader
 * connects, then a real, read-only rig.
 *
 * Four promises are held here:
 *
 *  - the page costs no Wasm until it is asked for, and the panel says its
 *    readings are samples while no radio is connected;
 *  - Connect asks for the port first and loads Hamlib alongside it, then
 *    shows what the radio reports - here the emulated TS-480 at 14.074 MHz;
 *  - Auto-detect, the default, finds the rate and connects;
 *  - once open, the panel only reads: no command it sends sets frequency,
 *    mode or transmit, and it offers no control that would.
 */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { installFakeSerial, installTestHelpers, installVirtualClock, readFakeSerial, useRig } from '../fixtures';

const LANDING_URL = 'http://127.0.0.1:4176/';

/* Kenwood writes: a set frequency (FA/FB + 11 digits), a set mode, or keying. */
const KENWOOD_WRITE = /^(?:F[AB]\d{11};|MD\d;|TX\d?;|RX;)/;

function wasmRequests(page: Page): string[] {
  const urls: string[] = [];

  page.on('request', (request) => {
    if (request.url().endsWith('.wasm')) {
      urls.push(request.url());
    }
  });

  return urls;
}

/* The fake port, for every test that has Web Serial; the last one has none. */
async function withFakeSerial(page: Page): Promise<void> {
  await installVirtualClock(page, 'auto');
  await installFakeSerial(page);
  await installTestHelpers(page);
}

async function connectTs480(page: Page, baud: string): Promise<void> {
  await page.goto(LANDING_URL);
  await useRig(page, 'kenwood-ts480');
  await page.getByTestId('model-select').selectOption({ label: 'Kenwood TS-480' });
  await page.getByTestId('baud-select').selectOption(baud);
  await page.getByTestId('connect-button').click();
  await expect(page.getByTestId('connection-state')).toHaveAttribute('data-state', 'connected', { timeout: 30_000 });
}

test('the panel is HTML until asked: sample readings, the catalogue, and no Wasm', async ({ page }) => {
  await withFakeSerial(page);

  const wasm = wasmRequests(page);

  await page.goto(LANDING_URL);
  await page.waitForLoadState('networkidle');

  const model = page.getByTestId('model-select');

  await expect(model.locator('option', { hasText: 'Kenwood TS-480' })).toHaveCount(1);
  await expect(model).toHaveValue(/\d+/);
  await expect(page.getByTestId('baud-select')).toHaveValue('auto');
  await expect(page.getByTestId('connection-state')).toHaveAttribute('data-state', 'disconnected');
  await expect(page.getByTestId('connection-state')).toHaveText('Sample');
  await expect(page.getByTestId('frequency-display')).toHaveText(/^\d{1,3}\.\d{3}\.\d{3}$/);
  await expect(page.getByTestId('ptt-on')).toHaveCount(0);
  expect(wasm).toEqual([]);
});

test('connects the emulated TS-480, shows what it reports, and only reads', async ({ page }) => {
  await withFakeSerial(page);
  await connectTs480(page, '9600');

  await expect(page.getByTestId('frequency-display')).toHaveText('14.074.000');
  await expect(page.getByTestId('mode-display')).toHaveText('USB');
  await expect(page.getByTestId('mode-USB')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('connect-button')).toBeHidden();
  await expect(page.getByTestId('frequency-input')).toHaveCount(0);
  await expect(page.getByTestId('ptt-on')).toHaveCount(0);

  /* Whatever Hamlib's own open sends is its business; the panel's polls must only read. */
  const opened = (await readFakeSerial(page)).commands.length;

  await page.evaluate(() => window.__virtualClock.advance(3500));

  const polled = (await readFakeSerial(page)).commands.slice(opened);

  expect(polled.length).toBeGreaterThan(0);
  expect(polled.filter((command) => KENWOOD_WRITE.test(command))).toEqual([]);

  await page.getByTestId('disconnect-button').click();
  await expect(page.getByTestId('connection-state')).toHaveAttribute('data-state', 'disconnected');
  await expect(page.getByTestId('connection-state')).toHaveText('Sample');
  await expect.poll(async () => (await readFakeSerial(page)).isOpen).toBe(false);
});

test('Auto-detect finds the rate, connects, and says which rate it used', async ({ page }) => {
  await withFakeSerial(page);
  await connectTs480(page, 'auto');

  await expect(page.getByTestId('frequency-display')).toHaveText('14.074.000');
  await expect(page.locator('[data-radio-meta]')).toHaveText(/^\d+ baud · read-only$/);
});

test('without Web Serial the panel says why, keeps Connect disabled and fetches nothing', async ({ page }) => {
  await page.addInitScript(() => {
    delete (Navigator.prototype as { serial?: unknown }).serial;
  });

  const wasm = wasmRequests(page);

  await page.goto(LANDING_URL);

  const connect = page.getByTestId('connect-button');

  await expect(connect).toBeDisabled();
  await expect(page.locator('[data-radio-note]')).toContainText('Web Serial');
  await connect.hover({ force: true });
  await page.waitForLoadState('networkidle');
  expect(wasm).toEqual([]);
});
