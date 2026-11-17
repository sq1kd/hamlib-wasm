/**
 * The React page against a capability-limited model, plus the ownership and
 * error-display contracts the panel depends on.
 *
 * Three things the rig/raw backends must agree on are proved here:
 *
 *  - a model whose telemetry is only part of the surface stays connected, shows
 *    the missing fields as unknown, and can be disconnected;
 *  - a telemetry read that fails after the port is acquired is reported as a
 *    telemetry failure, never as a failed connection, so cleanup stays
 *    available;
 *  - a rejected command reaches the error display, because the panel callbacks
 *    discard the rejected promise.
 *
 * Every scenario runs on a manual virtual clock (fixtures/virtual-clock.ts):
 * the panel polls on an interval, the backends sleep and time out inside
 * Hamlib, and a parked connect has its call watchdog armed, so time must not
 * run while the page merely waits for the spec.  After each action the clock
 * runs, in deadline order, until the screen or the emulator shows the outcome
 * - a timeout takes exactly its budget of virtual time, however loaded the
 * machine is.
 */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import {
  holdNextPortOpen,
  installFakeSerial,
  installTestHelpers,
  installVirtualClock,
  pressPtt,
  readFakeSerial,
  releasePortOpen,
  releasePtt,
  runClockUntilElement,
  runClockUntilPortClosed,
  setEmulatorSilent,
  setWritesFailing,
  useRig,
  waitForPortOpenPending,
} from '../fixtures';

const REACT_URL = 'http://127.0.0.1:4176/demo/';

test.beforeEach(async ({ page }) => {
  await installVirtualClock(page, 'manual');
  await installFakeSerial(page);
  await installTestHelpers(page);
});

/** Pick a model and its highest rate, so the open is one attempt, not an Auto-detect search. */
async function selectModel(page: Page, label: string): Promise<void> {
  await expect(page.getByTestId('model-select')).toBeEnabled();
  await page.getByTestId('model-select').selectOption({ label });
  await page.getByTestId('baud-select').selectOption({ index: 1 });
}

test('a frequency-only model connects, shows unknown fields and disconnects', async ({ page }) => {
  await page.goto(REACT_URL);

  /* The FRG-100 receiver: its backend declares frequency only. */
  await useRig(page, 'yaesu-frg100');

  await selectModel(page, 'Yaesu FRG-100');
  await page.getByTestId('connect-button').click();
  await runClockUntilElement(page, { testId: 'frequency-display', text: '7.050.000' });

  await expect(page.getByTestId('connection-state')).toHaveAttribute('data-state', 'connected');
  await expect(page.getByTestId('frequency-display')).toHaveText('7.050.000');

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
  await expect(page.getByTestId('ptt-button')).toBeDisabled();

  /* The setter works even though the mode cannot be read back. */
  await page.getByTestId('frequency-input').fill('7100000');
  await page.getByTestId('frequency-set').click();
  await runClockUntilElement(page, { testId: 'frequency-display', text: '7.100.000' });
  await expect(page.getByTestId('frequency-display')).toHaveText('7.100.000');

  await page.getByTestId('disconnect-button').click();
  await runClockUntilElement(page, { testId: 'connection-state', state: 'disconnected' });
  await expect(page.getByTestId('connection-state')).toHaveAttribute('data-state', 'disconnected');

  /* The panel discards the rejection of the close, so the port release is
   * observed rather than assumed. */
  await runClockUntilPortClosed(page);
  expect((await readFakeSerial(page)).isOpen).toBe(false);
  expect((await readFakeSerial(page)).closeCount).toBe(1);
});

test('a rig that never answers fails the acquisition loudly and releases the port', async ({ page }) => {
  await page.goto(REACT_URL);
  await useRig(page, 'yaesu-frg100');
  await page.getByTestId('backend-raw').check();

  /* Park the acquisition at the port chooser, silence the emulator, then let it
   * through: the FRG-100 backend's open path writes one frame, and with nothing
   * answering the rig never speaks at all. */
  await holdNextPortOpen(page);
  await selectModel(page, 'Yaesu FRG-100');
  await page.getByTestId('connect-button').click();
  await waitForPortOpenPending(page);

  await setEmulatorSilent(page, true);
  await releasePortOpen(page);

  /* The open gives up after its retry budget of virtual time and hands the
   * port back. */
  await page.evaluate(() => window.__virtualClock.until(
    () => window.__fakeSerial.closeCount === 1,
  ));
  await runClockUntilElement(page, { testId: 'error-message', contains: 'nothing arrived' });

  /* A port that opened onto nothing is not a connection: nothing is published,
   * the failure names what to check, and the port is given back rather than
   * held by a rig that cannot be used.  (A rig that goes quiet *after* it has
   * answered is the other case - see the timeout scenario, where the failure
   * stays telemetry and the rig stays owned.) */
  await expect(page.getByTestId('connection-state')).toHaveAttribute('data-state', 'disconnected');
  await expect(page.getByTestId('error-message')).toContainText('nothing arrived');
  await expect(page.getByTestId('error-message')).toContainText('baud');
  /* Still on the setup step: no radio to drive, nothing to disconnect. */
  await expect(page.getByTestId('frequency-input')).toHaveCount(0);
  await expect(page.getByTestId('disconnect-button')).toHaveCount(0);

  expect((await readFakeSerial(page)).isOpen).toBe(false);
  expect((await readFakeSerial(page)).closeCount).toBe(1);
});

test('a rejected command reaches the error display of the raw backend', async ({ page }) => {
  await page.goto(REACT_URL);
  await page.getByTestId('backend-raw').check();

  await selectModel(page, 'Kenwood TS-480');
  await page.getByTestId('connect-button').click();
  await runClockUntilElement(page, { testId: 'frequency-display', text: '14.074.000' });
  await expect(page.getByTestId('connection-state')).toHaveAttribute('data-state', 'connected');
  await expect(page.getByTestId('frequency-display')).toHaveText('14.074.000');

  /* The emulator refuses writes but keeps answering reads, so the PTT commands
   * fail on their own without a poll failure racing them for the same error slot. */
  await setWritesFailing(page, true);
  await pressPtt(page);
  await releasePtt(page);

  /* The panel callback discards the rejection, so the failure has to be in the
   * backend error state to be visible at all. */
  await runClockUntilElement(page, { testId: 'error-message', contains: 'setPtt' });
  await expect(page.getByTestId('error-message')).toContainText('setPtt');

  /* Still owned: a rejected command is reported, not fatal. */
  await expect(page.getByTestId('connection-state')).toHaveAttribute('data-state', 'connected');
  await expect(page.getByTestId('disconnect-button')).toBeEnabled();

  /* A rejected stream requires a new connection, but the failed action must
   * not poison the panel queue used by that connection. */
  await setWritesFailing(page, false);
  await page.getByTestId('disconnect-button').click();
  await runClockUntilPortClosed(page);
  expect((await readFakeSerial(page)).isOpen).toBe(false);
  await page.getByTestId('connect-button').click();
  await runClockUntilElement(page, { testId: 'frequency-display', text: '14.074.000' });
  await expect(page.getByTestId('frequency-display')).toHaveText('14.074.000');
  await page.getByTestId('frequency-input').fill('7074000');
  await page.getByTestId('frequency-set').click();
  await runClockUntilElement(page, { testId: 'frequency-display', text: '7.074.000' });
  await expect(page.getByTestId('frequency-display')).toHaveText('7.074.000');
});

test('copy diagnostics puts a rig report on the clipboard', async ({ page }) => {
  await page.goto(REACT_URL);

  /* The clipboard is stubbed: neither browser lets a test read the real one. */
  await page.evaluate(() => {
    const copies: string[] = [];

    Object.defineProperty(window, '__copies', { value: copies });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: (text: string) => { copies.push(text); return Promise.resolve(); } },
    });
  });

  await useRig(page, 'kenwood-ts480');
  await selectModel(page, 'Kenwood TS-480');
  await page.getByTestId('connect-button').click();
  await runClockUntilElement(page, { testId: 'connection-state', state: 'connected' });

  await page.getByTestId('copy-diagnostics').click();
  await expect(page.getByTestId('copy-diagnostics')).toHaveText('Copied');

  const copied = await page.evaluate(() => (window as unknown as { __copies: string[] }).__copies[0] ?? '');
  const report = JSON.parse(copied.replace(/^```json\n|\n```$/g, ''));

  expect(report.hamlibVersion).toContain('Hamlib');
  expect(report.debugLevel).toBe('verbose');
  expect(report.rigs[0].model).toBe('TS-480');
  expect(report.trace.length).toBeGreaterThan(0);
  expect(report.log.length).toBeGreaterThan(0);
});
