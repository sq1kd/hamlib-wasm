/**
 * Compound-operation ordering.
 *
 * A `Rig` operation that takes several native calls must own one queue slot:
 * nothing - a raw call, a call on another rig, a later `Rig` call - may run
 * between its steps.  These specs drive the built package through the harness
 * and use the emulator's own command log as the witness, because a plausible
 * final state is not proof of the order that produced it.
 */
import { expect, test } from '@playwright/test';

import {
  installFakeSerial,
  installTestHelpers,
  installVirtualClock,
  setReplyDelay,
} from './fixtures';
import type { Captured } from './globals';

const HARNESS_URL = 'http://127.0.0.1:4174/';

function expectOk<T>(captured: Captured<T>): T {
  if (!captured.ok) {
    throw new Error(`expected success, got ${captured.error.code}: ${captured.error.message}`);
  }

  return captured.value;
}

/**
 * Assert that a raw write never slipped inside the compound operation.
 *
 * A raw `setFrequency` is an `FA` command carrying digits, and the Kenwood
 * backend follows every write with its `ID` verification.  So the write's
 * start must come after the refresh's reads (at least one of the `MD`/`FW`/`IF`
 * reads the refresh issues reaches the wire; the frequency read may be served
 * from Hamlib's own cache) and nothing but that verification may follow it.
 */
function expectRawWriteAfterReads(commands: readonly string[]): void {
  const writeIndex = commands.findIndex(
    (command) => command.startsWith('FA') && command.length > 2,
  );

  expect(writeIndex).toBeGreaterThan(0);

  const before = commands.slice(0, writeIndex);
  const after = commands.slice(writeIndex + 1);

  expect(before.some((command) => command === 'MD' || command === 'FW' || command === 'IF'))
    .toBe(true);
  expect(after.filter((command) => command !== 'ID')).toEqual([]);
}

test.beforeEach(async ({ page }) => {
  await installVirtualClock(page);
  await installFakeSerial(page);
  await installTestHelpers(page);
  await page.goto(HARNESS_URL);
});

/* The harness page publishes the package; the fake transport is installed
 * before it loads, so `requestPort()` resolves to the emulated port. */

test('a later mode change wins over an earlier one', async ({ page }) => {
  const captured = await page.evaluate(() => window.__testHelpers.capture(async () => {
    const hamlib = await window.__hamlibHarness.createHamlib({});
    const model = hamlib.models.find((candidate) => candidate.model === 'TS-480');

    if (!model) { throw new Error('the TS-480 is missing from the catalogue'); }

    const rig = await hamlib.open({ modelId: model.id, baudRate: model.serialRateMax });

    try {
      /* Both are invoked without awaiting between them, so the second is the
       * later call in every respect. */
      const first = rig.setMode('CW');
      const second = rig.setMode('FM', 12000);

      await Promise.all([first, second]);

      const state = await rig.refresh();

      return { mode: state.mode ?? null, connected: rig.connected };
    } finally {
      await rig.close();
      await hamlib.dispose();
    }
  }));

  const result = expectOk(captured);

  expect(result.mode).toBe('FM');
  expect(result.connected).toBe(true);
});

test('a refresh reports the values from before the write that follows it', async ({ page }) => {
  const captured = await page.evaluate(() => window.__testHelpers.capture(async () => {
    const hamlib = await window.__hamlibHarness.createHamlib({});
    const model = hamlib.models.find((candidate) => candidate.model === 'TS-480');

    if (!model) { throw new Error('the TS-480 is missing from the catalogue'); }

    const rig = await hamlib.open({ modelId: model.id, baudRate: model.serialRateMax });

    try {
      const opening = await rig.refresh();

      /* Queue the refresh first and a mode write second: without one queue
       * slot per compound operation the write lands among the refresh's reads
       * and the snapshot mixes the old frequency with the new mode. */
      const earlier = rig.refresh();
      const write = rig.setMode('FM', 12000);
      const before = await earlier;

      await write;

      const after = await rig.refresh();

      return {
        openingMode: opening.mode ?? null,
        beforeMode: before.mode ?? null,
        beforeFrequency: before.frequency ?? null,
        afterMode: after.mode ?? null,
      };
    } finally {
      await rig.close();
      await hamlib.dispose();
    }
  }));

  const result = expectOk(captured);

  expect(result.openingMode).toBe('USB');
  expect(result.beforeMode).toBe('USB');
  expect(result.beforeFrequency).toBe(14_074_000);
  expect(result.afterMode).toBe('FM');
});

test('a raw call cannot run between the steps of a Rig operation', async ({ page }) => {
  const captured = await page.evaluate(() => window.__testHelpers.capture(async () => {
    const hamlib = await window.__hamlibHarness.createHamlib({});
    const model = hamlib.models.find((candidate) => candidate.model === 'TS-480');

    if (!model) { throw new Error('the TS-480 is missing from the catalogue'); }

    const rig = await hamlib.open({ modelId: model.id, baudRate: model.serialRateMax });

    try {
      const base = window.__fakeSerial.commands.length;

      /* Start the compound read first, then issue a raw write: without one
       * queue slot per compound operation the write lands between the reads. */
      const refresh = rig.refresh();
      const write = rig.raw.setFrequency(7_074_000);

      await Promise.all([refresh, write]);

      return window.__fakeSerial.commands.slice(base);
    } finally {
      await rig.close();
      await hamlib.dispose();
    }
  }));

  expectRawWriteAfterReads(expectOk(captured));
});

test('a failed operation does not poison the queue', async ({ page }) => {
  const captured = await page.evaluate(() => window.__testHelpers.capture(async () => {
    const hamlib = await window.__hamlibHarness.createHamlib({});
    const model = hamlib.models.find((candidate) => candidate.model === 'TS-480');

    if (!model) { throw new Error('the TS-480 is missing from the catalogue'); }

    const rig = await hamlib.open({ modelId: model.id, baudRate: model.serialRateMax });

    try {
      /* Hamlib rejects the mode it cannot parse, inside the compound slot. */
      // @ts-expect-error -- not a Hamlib mode: the runtime refusal a plain-JS caller gets.
      const failed = await window.__testHelpers.capture(() => rig.setMode('NOPE'));

      const after = await rig.refresh();

      return {
        failedOk: failed.ok,
        failedCode: failed.ok ? null : failed.error.code,
        frequency: after.frequency ?? null,
        connected: rig.connected,
      };
    } finally {
      await rig.close();
      await hamlib.dispose();
    }
  }));

  const result = expectOk(captured);

  expect(result.failedOk).toBe(false);
  expect(result.failedCode).toBe('HAMLIB_ERROR');
  expect(result.frequency).toBe(14_074_000);
  expect(result.connected).toBe(true);
});

test('a slow step cannot let another call overtake the operation', async ({ page }) => {
  /* The emulator answers slowly, so the compound operation really does span a
   * window a raw call could slip into. */
  await setReplyDelay(page, 250);

  const captured = await page.evaluate(() => window.__testHelpers.capture(async () => {
    const hamlib = await window.__hamlibHarness.createHamlib({});
    const model = hamlib.models.find((candidate) => candidate.model === 'TS-480');

    if (!model) { throw new Error('the TS-480 is missing from the catalogue'); }

    const rig = await hamlib.open({ modelId: model.id, baudRate: model.serialRateMax });

    try {
      const base = window.__fakeSerial.commands.length;
      const refresh = rig.refresh();
      const write = rig.raw.setFrequency(7_074_000);

      await Promise.all([refresh, write]);

      return window.__fakeSerial.commands.slice(base);
    } finally {
      await rig.close();
      await hamlib.dispose();
    }
  }));

  /* Every read of the refresh completes before the raw write starts, even
   * though each reply took a quarter of a second. */
  expectRawWriteAfterReads(expectOk(captured));
});

test('a pure helper cannot re-enter the module while a write is suspended', async ({ page }) => {
  /* The emulator answers slowly, so the write really holds the Asyncify
   * suspension while the pure helper is issued. */
  await setReplyDelay(page, 250);

  const captured = await page.evaluate(() => window.__testHelpers.capture(async () => {
    const hamlib = await window.__hamlibHarness.createHamlib({});
    const model = hamlib.models.find((candidate) => candidate.model === 'TS-480');

    if (!model) { throw new Error('the TS-480 is missing from the catalogue'); }

    const rig = await hamlib.open({ modelId: model.id, baudRate: model.serialRateMax });

    try {
      /* What the helper answers when nothing is in flight. */
      const reference = await rig.raw.passbandNarrow('USB');

      /* A raw write first, then - once it has actually reached the module and
       * suspended on the slow reply - a pure helper.  Without the queue the
       * helper re-enters the unwound module while the write is suspended. */
      const write = rig.raw.setFrequency(7_074_000);

      /* The write has reached the emulator once its frame is decoded; its
       * verification reply is now 250 ms of virtual time away. */
      await window.__virtualClock.until(
        () => window.__fakeSerial.commands.includes('FA00007074000'),
      );

      const narrow = rig.raw.passbandNarrow('USB');

      const [, width] = await Promise.all([write, narrow]);

      /* The queue settled, and the next read sees the write that held it. */
      const after = await rig.refresh();

      return { reference, width, frequency: after.frequency ?? null, connected: rig.connected };
    } finally {
      await rig.close();
      await hamlib.dispose();
    }
  }));

  const result = expectOk(captured);

  expect(result.width).toBe(result.reference);
  expect(result.frequency).toBe(7_074_000);
  expect(result.connected).toBe(true);
});

test('a passband action cannot undo a mode selected after it', async ({ page }) => {
  await setReplyDelay(page, 250);

  const captured = await page.evaluate(() => window.__testHelpers.capture(async () => {
    const hamlib = await window.__hamlibHarness.createHamlib({});
    const model = hamlib.models.find((candidate) => candidate.model === 'TS-480');

    if (!model) { throw new Error('the TS-480 is missing from the catalogue'); }

    const rig = await hamlib.open({ modelId: model.id, baudRate: model.serialRateMax });

    try {
      const opening = await rig.refresh();

      /* From USB, issue the narrow passband action and then a CW selection
       * without awaiting between them: the later selection must win. */
      const passband = rig.setPassband('narrow');
      const mode = rig.setMode('CW');

      await Promise.all([passband, mode]);

      const after = await rig.refresh();

      return {
        openingMode: opening.mode ?? null,
        mode: after.mode ?? null,
        connected: rig.connected,
      };
    } finally {
      await rig.close();
      await hamlib.dispose();
    }
  }));

  const result = expectOk(captured);

  expect(result.openingMode).toBe('USB');
  expect(result.mode).toBe('CW');
  expect(result.connected).toBe(true);
});

test('a write issued while a watch tick holds the queue is not nested', async ({ page }) => {
  const captured = await page.evaluate(() => window.__testHelpers.capture(async () => {
    const hamlib = await window.__hamlibHarness.createHamlib({ levels: ['STRENGTH'] });
    const model = hamlib.models.find((candidate) => candidate.model === 'TS-480');

    if (!model) { throw new Error('the TS-480 is missing from the catalogue'); }

    const rig = await hamlib.open({ modelId: model.id, baudRate: model.serialRateMax });

    /* Every reply is slow, so the meter tick occupies its queue slot while the
     * write arrives from outside.  A compound body's own calls run directly;
     * an unrelated call must still be queued, not refused as "nested". */
    window.__fakeSerial.replyDelayMs = 250;
    const base = window.__fakeSerial.commands.length;
    const stop = rig.watch({ intervalMs: 50, fields: ['frequency', 'levels'] });

    /* The first tick has put its read on the wire and waits for the reply. */
    await window.__virtualClock.until(() => window.__fakeSerial.commands.length > base);

    const failure = await window.__testHelpers.capture(() => rig.setFrequency(7_074_000));

    /* Fast replies again; a tick after the write publishes what it wrote.  The
     * slowest one still in flight answers within 250 ms of virtual time. */
    window.__fakeSerial.replyDelayMs = 0;
    await window.__virtualClock.advance(600);

    const state = rig.state;
    stop();
    await rig.close();
    await hamlib.dispose();

    return { failure, frequency: state?.frequency ?? null };
  }));

  const result = expectOk(captured);

  expect(result.failure.ok).toBe(true);
  expect(result.frequency).toBe(7_074_000);
});
