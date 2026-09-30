/**
 * Happy path: drive the built example page in Chromium against the fake
 * Web Serial port and its TS-480 emulator.
 */
import { expect, test } from '@playwright/test';

import { TS480_LINE_SETTINGS, installFakeSerial, readFakeSerial } from '../fixtures';
import { connectTs480 } from './helpers';

test.beforeEach(async ({ page }) => {
  await installFakeSerial(page);

  await page.goto('/');

  await expect(page.getByTestId('hamlib-version')).toHaveText(/4\.7\.2/);
  await expect(page.getByTestId('web-serial-status')).toHaveAttribute(
    'data-state',
    'available',
  );
});

test('selects a rig, connects, controls it, and disconnects cleanly', async ({ page }) => {
  const model = await connectTs480(page);

  expect(model.label).toContain('Kenwood');
  expect(model.label).toContain('TS-480');

  /* Connect reads the rig state. */
  await expect(page.getByTestId('status-frequency')).toHaveText('14074000');
  await expect(page.getByTestId('status-mode')).toHaveText('USB');
  await expect(page.getByTestId('status-passband')).toHaveText('2400');
  await expect(page.getByTestId('ptt-state')).toHaveText('off');

  /* The port was opened with the model's line settings. */
  const opened = (await readFakeSerial(page)).openedOptions;
  expect(opened).toEqual({
    baudRate: model.serialRateMax,
    ...TS480_LINE_SETTINGS,
  });

  /* Frequency. */
  await page.getByTestId('frequency-input').fill('7074000');
  await page.getByTestId('frequency-set').click();
  await expect(page.getByTestId('status-frequency')).toHaveText('7074000');

  /* Mode and passband. */
  await page.getByTestId('mode-input').fill('CW');
  await page.getByTestId('passband-input').fill('500');
  await page.getByTestId('mode-set').click();
  await expect(page.getByTestId('status-mode')).toHaveText('CW');
  await expect(page.getByTestId('status-passband')).toHaveText('500');

  /* PTT on, then off, both read back through the dedicated methods. */
  await page.getByTestId('ptt-select').selectOption('on');
  await page.getByTestId('ptt-set').click();
  await expect(page.getByTestId('ptt-state')).toHaveText('on');
  await expect(page.getByTestId('error-section')).toBeHidden();

  await page.getByTestId('ptt-select').selectOption('off');
  await page.getByTestId('ptt-set').click();
  await expect(page.getByTestId('ptt-state')).toHaveText('off');

  /* Refresh observes the emulator state. */
  await page.getByTestId('refresh-button').click();
  await expect(page.getByTestId('status-frequency')).toHaveText('7074000');
  await expect(page.getByTestId('status-mode')).toHaveText('CW');
  await expect(page.getByTestId('status-passband')).toHaveText('500');
  await expect(page.getByTestId('error-section')).toBeHidden();

  const emulator = await readFakeSerial(page);
  expect(emulator.state.frequency).toBe(7_074_000);
  expect(emulator.state.modeDigit).toBe(3);
  expect(emulator.state.filterValue).toBe(500);
  expect(emulator.state.transmitting).toBe(false);
  expect(emulator.commands).toContain('MD3');
  expect(emulator.commands).toContain('FW0500');
  expect(emulator.commands).toContain('TX');
  expect(emulator.commands).toContain('RX');

  /* Disconnect closes the rig and the port. */
  await page.getByTestId('disconnect-button').click();
  await expect(page.getByTestId('connection-state')).toHaveText('disconnected');
  await expect(page.getByTestId('connect-button')).toBeEnabled();
  await expect(page.getByTestId('refresh-button')).toBeDisabled();
  await expect(page.getByTestId('ptt-set')).toBeDisabled();

  const closed = await readFakeSerial(page);
  expect(closed.isOpen).toBe(false);
  expect(closed.closeCount).toBe(1);
  expect(closed.closedWithLockedStreams).toBe(false);
});
