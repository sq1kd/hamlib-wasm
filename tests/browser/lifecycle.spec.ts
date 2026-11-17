/**
 * Lifecycle ownership regressions.
 *
 * An `open()` that was accepted before `dispose()` must never survive the
 * disposal: it either completes and is closed again, or it is rejected.  The
 * Web Serial double is the witness - a rig that stayed open would leave the
 * fake port open or a locked stream behind.
 */

import { expect, expectFailure, expectOk, readFakeSerial, test } from './fixtures';

test('disposal during an accepted open closes the rig and rejects the open', async ({ harnessPage: page }) => {
  const captured = await page.evaluate(() => window.__testHelpers.capture(async () => {
    const hamlib = await window.__hamlibHarness.createRawHamlib();
    const port = await hamlib.requestPort();
    const ts480 = window.__testHelpers.catalogueModel(hamlib.models, 'Kenwood', 'TS-480');

    /* open() reaches the queue synchronously, so this is the exact race: the
     * open is accepted, dispose() is requested while it waits on the chain. */
    const pendingOpen = window.__testHelpers.capture(
      () => hamlib.open({ modelId: ts480.id, port }),
    );
    const disposal = window.__testHelpers.capture(() => hamlib.dispose());

    const [open, dispose] = await Promise.all([pendingOpen, disposal]);

    const afterDispose = await window.__testHelpers.capture(() => hamlib.open({
      modelId: ts480.id,
      port,
    }));

    return { open, dispose, afterDispose };
  }));

  const result = expectOk(captured);

  expectOk(result.dispose);

  const open = expectFailure(result.open);
  expect(open.code).toBe('DISPOSED');
  expect(open.operation).toBe('open');

  const afterDispose = expectFailure(result.afterDispose);
  expect(afterDispose.code).toBe('DISPOSED');

  const transport = await readFakeSerial(page);

  /* The open really reached the device, and disposal really released it. */
  expect(transport.commands).toContain('ID');
  expect(transport.openCount).toBe(1);
  expect(transport.closeCount).toBe(1);
  expect(transport.isOpen).toBe(false);
  expect(transport.closedWithLockedStreams).toBe(false);
});

test('disposal is idempotent and releases a port that raced with it', async ({ harnessPage: page }) => {
  const captured = await page.evaluate(() => window.__testHelpers.capture(async () => {
    const hamlib = await window.__hamlibHarness.createRawHamlib();
    const port = await hamlib.requestPort();
    const ts480 = window.__testHelpers.catalogueModel(hamlib.models, 'Kenwood', 'TS-480');

    const pendingOpen = window.__testHelpers.capture(
      () => hamlib.open({ modelId: ts480.id, port }),
    );
    const first = window.__testHelpers.capture(() => hamlib.dispose());
    const second = window.__testHelpers.capture(() => hamlib.dispose());
    const third = window.__testHelpers.capture(() => hamlib.dispose());

    const [open, firstDispose, secondDispose, thirdDispose] = await Promise.all([
      pendingOpen,
      first,
      second,
      third,
    ]);

    return { open, firstDispose, secondDispose, thirdDispose };
  }));

  const result = expectOk(captured);

  expectFailure(result.open);
  expectOk(result.firstDispose);
  expectOk(result.secondDispose);
  expectOk(result.thirdDispose);

  const transport = await readFakeSerial(page);

  expect(transport.openCount).toBe(1);
  expect(transport.closeCount).toBe(1);
  expect(transport.isOpen).toBe(false);
  expect(transport.closedWithLockedStreams).toBe(false);
});

test('a later instance can use the same port after a raced disposal', async ({ harnessPage: page }) => {
  const captured = await page.evaluate(() => window.__testHelpers.capture(async () => {
    const first = await window.__hamlibHarness.createRawHamlib();
    const port = await first.requestPort();
    const ts480 = window.__testHelpers.catalogueModel(first.models, 'Kenwood', 'TS-480');

    const pendingOpen = window.__testHelpers.capture(
      () => first.open({ modelId: ts480.id, port }),
    );
    const disposal = window.__testHelpers.capture(() => first.dispose());
    await Promise.all([pendingOpen, disposal]);

    /* Nothing from the disposed instance may still hold the device. */
    const second = await window.__hamlibHarness.createRawHamlib();
    const rig = await second.open({ modelId: ts480.id, port });
    const frequency = await rig.getFrequency();
    await rig.close();
    await second.dispose();

    return frequency;
  }));

  expect(expectOk(captured)).toBe(14_074_000);

  const transport = await readFakeSerial(page);

  expect(transport.openCount).toBe(2);
  expect(transport.closeCount).toBe(2);
  expect(transport.isOpen).toBe(false);
  expect(transport.closedWithLockedStreams).toBe(false);
});

for (const action of ['close', 'dispose'] as const) {
  test(`${action} from a state listener finishes that event but suppresses the rest`, async ({ harnessPage: page }) => {
    const captured = await page.evaluate((action) => window.__testHelpers.capture(async () => {
      const hamlib = await window.__hamlibHarness.createHamlib({});
      const model = window.__testHelpers.catalogueModel(hamlib.models, 'Kenwood', 'TS-480');

      const rig = await hamlib.open({ modelId: model.id, baudRate: model.serialRateMax });
      const events: string[] = [];
      let stopping: Promise<void> | undefined;

      rig.on('state', () => {
        events.push('state:first');
        stopping = action === 'close' ? rig.close() : hamlib.dispose();
      });
      rig.on('state', () => { events.push('state:second'); });
      rig.on('frequency', () => { events.push('frequency'); });
      rig.on('mode', () => { events.push('mode'); });
      rig.on('ptt', () => { events.push('ptt'); });

      try {
        await rig.refresh();
        await stopping;

        return { events, connected: rig.connected };
      } finally {
        await hamlib.dispose();
      }
    }), action);

    const result = expectOk(captured);

    /* Snapshot dispatch: the event already on its way reaches both listeners,
     * and no field event follows the close. */
    expect(result.events).toEqual(['state:first', 'state:second']);
    expect(result.connected).toBe(false);
    expect((await readFakeSerial(page)).isOpen).toBe(false);
  });

  test(`${action} from an error listener preserves rejection and the error event`, async ({ harnessPage: page }) => {
    const captured = await page.evaluate((action) => window.__testHelpers.capture(async () => {
      const hamlib = await window.__hamlibHarness.createHamlib({});
      const model = window.__testHelpers.catalogueModel(hamlib.models, 'Kenwood', 'TS-480');

      const rig = await hamlib.open({ modelId: model.id, baudRate: model.serialRateMax });
      const events: string[] = [];
      let stopping: Promise<void> | undefined;

      rig.on('error', () => {
        events.push('error:first');
        stopping = action === 'close' ? rig.close() : hamlib.dispose();
      });
      rig.on('error', () => { events.push('error:second'); });

      try {
        // @ts-expect-error -- not a Hamlib mode: the runtime refusal a plain-JS caller gets.
        const failure = await window.__testHelpers.capture(() => rig.setMode('NOT_A_MODE'));

        await stopping;

        return { events, failure };
      } finally {
        await hamlib.dispose();
      }
    }), action);

    const result = expectOk(captured);

    expect(result.events).toEqual(['error:first', 'error:second']);
    expect(expectFailure(result.failure).operation).toBe('setMode');
    expect((await readFakeSerial(page)).isOpen).toBe(false);
  });
}
