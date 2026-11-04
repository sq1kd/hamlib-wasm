/**
 * The React landing page, driven end to end through the Web Serial double.
 *
 * Two things are proved here: that the easy entry really drives a rig through
 * the React hooks, and that the 1:1 entry produces the same screen from its
 * own calls - the call log is the visible difference between them.  The PTT
 * commands are proved to stand on their own, without a poll in between.
 */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { installFakeSerial, installTestHelpers, readFakeSerial, setReplyDelay } from '../fixtures';

const REACT_URL = 'http://127.0.0.1:4176/demo/';

/** The TS-480 the emulator starts on. */
const TS480_FREQUENCY = '14,074,000';
const TS480_MODE = 'USB';

test.beforeEach(async ({ page }) => {
  await installFakeSerial(page);
  await installTestHelpers(page);
  await page.goto(REACT_URL);
  await page.getByTestId('load-demo').click();
});

/** The page preselects the TS-480, so connecting is the gesture on its own. */
async function connect(page: Page): Promise<void> {
  await expect(page.getByTestId('model-select')).toBeEnabled();
  await page.getByTestId('connect-button').click();
  await expect(page.getByTestId('connection-state')).toHaveAttribute('data-state', 'connected');
  await expect(page.getByTestId('frequency-display')).toHaveText(TS480_FREQUENCY);
  await expect(page.getByTestId('mode-display')).toHaveText(TS480_MODE);
}

test('drives a rig through the easy backend', async ({ page }) => {
  await connect(page);

  /* The panel reads through the backend poll and its own step buttons. */
  await page.getByTestId('tune-up').click();
  await expect(page.getByTestId('frequency-display')).toHaveText('14,075,000');

  await page.getByTestId('mode-CW').click();
  await expect(page.getByTestId('mode-display')).toHaveText('CW');

  /* Two commands, one observed readout: the rig answers with what it did. */
  await page.getByTestId('ptt-on').click();
  await expect(page.getByTestId('ptt-state')).toHaveAttribute('data-state', 'on');

  await page.getByTestId('ptt-off').click();
  await expect(page.getByTestId('ptt-state')).toHaveAttribute('data-state', 'off');

  /* A direct entry goes through setFrequency once, not the step size. */
  await page.getByTestId('frequency-input').fill('7074000');
  await page.getByTestId('frequency-set').click();
  await expect(page.getByTestId('frequency-display')).toHaveText('7,074,000');

  /* The easy logging: the poll is a declaration, and the mode call carries no
   * width because the library fills it in from the model. */
  await expect(page.getByTestId('call-log')).toContainText('useRigState(rig, { pollMs: 1000 })');
  await expect(page.getByTestId('call-log')).toContainText("setMode('CW')");
  await expect(page.getByTestId('call-log')).toContainText('setFrequency(7074000)');
  await expect(page.getByTestId('call-log')).not.toContainText('passbandNormal');

  await page.getByTestId('disconnect-button').click();
  await expect(page.getByTestId('connection-state')).toHaveAttribute('data-state', 'disconnected');
});

test('sends both PTT commands without waiting for a poll', async ({ page }) => {
  await connect(page);

  /* TX on then TX off, back to back: neither button is gated on the snapshot
   * the last poll published, so the second command cannot be built from a
   * stale "off" and silently repeat the first. */
  await page.getByTestId('ptt-on').click();
  await page.getByTestId('ptt-off').click();

  /* The emulator decoded the two commands, in that order... */
  await expect
    .poll(
      async () => (await readFakeSerial(page)).commands.filter(
        (command) => command === 'TX' || command === 'RX',
      ),
      { timeout: 5000 },
    )
    .toEqual(['TX', 'RX']);

  /* ...and the radio the commands reached is no longer transmitting. */
  expect((await readFakeSerial(page)).state.transmitting).toBe(false);
  await expect(page.getByTestId('ptt-state')).toHaveAttribute('data-state', 'off');
});

test('produces the same screen from the 1:1 calls', async ({ page }) => {
  await page.getByTestId('backend-native').check();
  await connect(page);

  await page.getByTestId('mode-CW').click();
  await expect(page.getByTestId('mode-display')).toHaveText('CW');

  /* The native logging: the explicit reads the easy surface folds into one,
   * and a mode call that writes the passband the app asked Hamlib for. */
  await expect(page.getByTestId('call-log')).toContainText('getFrequency()');
  await expect(page.getByTestId('call-log')).toContainText("setMode('CW',");
  await expect(page.getByTestId('call-log')).not.toContainText('useRigState');
});

for (const backend of ['easy', 'native'] as const) {
  for (const modeFirst of [false, true]) {
    test(`${backend} orders ${modeFirst ? 'mode then passband' : 'passband then mode'} actions`, async ({ page }) => {
      if (backend === 'native') {
        await page.getByTestId('backend-native').check();
      }

      await connect(page);
      await expect(page.getByTestId('passband-narrow')).toBeEnabled();
      await setReplyDelay(page, 150);

      await page.evaluate((modeFirst) => {
        window.__fakeSerial.commands.length = 0;
        const mode = document.querySelector<HTMLButtonElement>('[data-testid="mode-CW"]');
        const passband = document.querySelector<HTMLButtonElement>('[data-testid="passband-narrow"]');

        if (!mode || !passband) { throw new Error('missing mode or passband controls'); }

        (modeFirst ? mode : passband).click();
        (modeFirst ? passband : mode).click();
      }, modeFirst);

      /* Each action ends with a width write. Wait for both before checking
       * the result, rather than accepting a transient CW before a stale write. */
      await expect.poll(async () => (await readFakeSerial(page)).commands.filter(
        (command) => /^FW\d/.test(command),
      ).length).toBe(2);

      const radio = await readFakeSerial(page);

      expect(radio.state.modeDigit).toBe(3);
      expect(radio.commands.filter((command) => /^MD\d/.test(command))).toEqual(['MD3']);
      await expect(page.getByTestId('mode-display')).toHaveText('CW');
      await page.getByTestId('disconnect-button').click();
      await expect.poll(async () => (await readFakeSerial(page)).isOpen).toBe(false);
    });
  }
}

test('reports the backend that cannot open a rig', async ({ page }) => {
  /* The catalogue carries the recorded reason, and the page shows it before a
   * user gesture is spent on a port. */
  await expect(page.getByTestId('model-select')).toBeEnabled();
  await page.getByTestId('model-select').selectOption({ label: 'FT-757GXII' });

  await expect(page.getByTestId('model-limitation')).toContainText('FT-757GXII');
});
