/**
 * Browser compatibility checks.
 *
 * Three things the package promises to make explicit and predictable:
 *
 *   - which models are actually exercised here and which are only serial
 *     candidates,
 *   - that a model whose backend declares line settings Web Serial cannot
 *     express is refused before the device is touched,
 *   - that a backend which needs a worker thread fails loudly rather than
 *     half working, and that a device which disappears mid-session is reported
 *     as a transport failure instead of wedging the rig.
 */
import { expect, test } from '@playwright/test';

import {
  UNUSABLE_MODELS,
  VERIFIED_MODELS,
  describeLineSettingsLimitation,
} from 'hamlib-wasm';

import {
  installFakeSerial,
  installTestHelpers,
  installVirtualClock,
  readFakeSerial,
} from './fixtures';
import type { Captured, HamlibErrorView } from './globals';

const HARNESS_URL = 'http://127.0.0.1:4174/';

interface CatalogueModel {
  id: number;
  manufacturer: string;
  model: string;
  serialDataBits: number;
  serialStopBits: number;
  serialParity: string;
  serialHandshake: string;
  support: string;
  limitation: string | null;
}

function expectOk<T>(captured: Captured<T>): T {
  if (!captured.ok) {
    throw new Error(
      `expected success but the page reported ${JSON.stringify(captured.error)}`,
    );
  }

  return captured.value;
}

function expectFailure<T>(captured: Captured<T>): HamlibErrorView {
  if (captured.ok) {
    throw new Error(
      `expected a failure but the page succeeded: ${JSON.stringify(captured.value)}`,
    );
  }

  return captured.error;
}

test.beforeEach(async ({ page }) => {
  await installVirtualClock(page);
  await installFakeSerial(page);
  await installTestHelpers(page);
  await page.goto(HARNESS_URL);
});

test('labels verified models and explains the unusable ones', async ({ page }) => {
  const captured = await page.evaluate(
    (): Promise<Captured<CatalogueModel[]>> => window.__testHelpers.capture(
      async () => {
        const hamlib = await window.__hamlibHarness.createRawHamlib();
        const models: CatalogueModel[] = hamlib.models.map((model) => ({
          id: model.id,
          manufacturer: model.manufacturer,
          model: model.model,
          serialDataBits: model.serialDataBits,
          serialStopBits: model.serialStopBits,
          serialParity: model.serialParity,
          serialHandshake: model.serialHandshake,
          support: model.support,
          limitation: model.limitation ?? null,
        }));

        await hamlib.dispose();
        return models;
      },
    ),
  );

  const models = expectOk(captured);
  const find = (manufacturer: string, model: string): CatalogueModel[] =>
    models.filter(
      (entry) => entry.manufacturer === manufacturer && entry.model === model,
    );

  /* Every model claimed as verified exists and is labelled as such. */
  for (const entry of VERIFIED_MODELS) {
    const matches = find(entry.manufacturer, entry.model);

    expect(
      matches,
      `${entry.manufacturer} ${entry.model} is listed as verified but is not in the catalogue`,
    ).toHaveLength(1);
    expect(matches[0]?.support).toBe('verified');
    expect(entry.evidence.length).toBeGreaterThan(0);
  }

  /* ... and nothing else claims to be verified. */
  const verifiedNames = new Set(
    VERIFIED_MODELS.map((entry) => `${entry.manufacturer}|${entry.model}`),
  );

  for (const model of models) {
    if (verifiedNames.has(`${model.manufacturer}|${model.model}`)) {
      continue;
    }

    expect(
      model.support,
      `${model.manufacturer} ${model.model} is not verified`,
    ).toBe('candidate');
  }

  /* Every recorded reason resolves to a model and is reported verbatim. */
  for (const entry of UNUSABLE_MODELS) {
    const matches = find(entry.manufacturer, entry.model);

    expect(
      matches,
      `${entry.manufacturer} ${entry.model} has a recorded limitation but is not in the catalogue`,
    ).toHaveLength(1);
    expect(matches[0]?.limitation).toBe(entry.reason);
  }

  /* The line settings a backend declares decide the rest. */
  const bySettings = models.filter(
    (model) => describeLineSettingsLimitation(model) !== undefined,
  );

  expect(
    bySettings.length,
    'no advertised model declares settings Web Serial cannot express',
  ).toBeGreaterThan(0);

  for (const model of bySettings) {
    expect(
      model.limitation,
      `${model.manufacturer} ${model.model} declares unsupported settings`,
    ).toBe(describeLineSettingsLimitation(model));
  }

  /* A model is only flagged for one reason. */
  for (const model of models) {
    if (model.limitation === null) { continue; }

    const derived = describeLineSettingsLimitation(model);
    const recorded = UNUSABLE_MODELS.find(
      (entry) => entry.manufacturer === model.manufacturer && entry.model === model.model,
    );

    expect(
      derived ?? recorded?.reason,
      `${model.manufacturer} ${model.model} states an unexplained limitation`,
    ).toBe(model.limitation);
  }
});

test('refuses a model whose line settings Web Serial cannot express', async ({ page }) => {
  const captured = await page.evaluate(() => window.__testHelpers.capture(async () => {
    const hamlib = await window.__hamlibHarness.createRawHamlib();
    const port = await hamlib.requestPort();
    const unsupported = hamlib.models.find((model) => model.model === 'AR2700');

    if (!unsupported) {
      throw new Error('the AOR AR2700 model is missing');
    }

    const rejected = await window.__testHelpers.capture(
      () => hamlib.open({ modelId: unsupported.id, port }),
    );

    /* The port must still be usable for a model the browser can drive. */
    const ts480 = hamlib.models.find((model) => model.model === 'TS-480');

    if (!ts480) {
      throw new Error('the TS-480 model is missing');
    }

    const rig = await hamlib.open({ modelId: ts480.id, port });
    const frequency = await rig.getFrequency();
    await rig.close();
    await hamlib.dispose();

    return { rejected, limitation: unsupported.limitation ?? null, frequency };
  }));

  const result = expectOk(captured);

  expect(result.limitation).toContain('xon-xoff');
  expect(result.frequency).toBe(14_074_000);

  const rejected = expectFailure(result.rejected);
  expect(rejected.code).toBe('HAMLIB_ERROR');
  /* -RIG_ECONF: the transport refuses the configuration before touching the
   * device, so the user never sees a silently downgraded port. */
  expect(rejected.hamlibCode).toBe(-2);
  expect(rejected.hamlibMessage).toBe('invalid configuration');

  const transport = await readFakeSerial(page);

  /* Only the TS-480 ever reached the serial port. */
  expect(transport.openCount).toBe(1);
  expect(transport.isOpen).toBe(false);
  expect(transport.closedWithLockedStreams).toBe(false);
});

test('fails predictably for a backend that needs a worker thread', async ({ page }) => {
  const captured = await page.evaluate(() => window.__testHelpers.capture(async () => {
    const hamlib = await window.__hamlibHarness.createRawHamlib();
    const port = await hamlib.requestPort();
    const threaded = hamlib.models.find((model) => model.model === 'D578A');

    if (!threaded) {
      throw new Error('the AnyTone D578A model is missing');
    }

    const rejected = await window.__testHelpers.capture(
      () => hamlib.open({ modelId: threaded.id, port }),
    );

    /* The failure must not wedge the instance or the port. */
    const ts480 = hamlib.models.find((model) => model.model === 'TS-480');

    if (!ts480) {
      throw new Error('the TS-480 model is missing');
    }

    const rig = await hamlib.open({ modelId: ts480.id, port });
    const frequency = await rig.getFrequency();
    await rig.close();
    await hamlib.dispose();

    return { rejected, frequency };
  }));

  const result = expectOk(captured);

  expect(result.frequency).toBe(14_074_000);

  const rejected = expectFailure(result.rejected);
  expect(rejected.code).toBe('HAMLIB_ERROR');
  /* -RIG_EINTERNAL: pthread_create is refused by the single-threaded shim. */
  expect(rejected.hamlibCode).toBe(-7);

  const transport = await readFakeSerial(page);

  /* The abandoned attempt released the port, and the retry started clean. */
  expect(transport.openCount).toBe(2);
  expect(transport.closeCount).toBe(2);
  expect(transport.isOpen).toBe(false);
  expect(transport.closedWithLockedStreams).toBe(false);
});

test('reports a device that disappears mid-session', async ({ page }) => {
  const captured = await page.evaluate(() => window.__testHelpers.capture(async () => {
    const hamlib = await window.__hamlibHarness.createRawHamlib();
    const port = await hamlib.requestPort();
    const ts480 = hamlib.models.find((model) => model.model === 'TS-480');

    if (!ts480) {
      throw new Error('the TS-480 model is missing');
    }

    const rig = await hamlib.open({ modelId: ts480.id, port });
    await rig.getFrequency();

    /* Let 600 ms of virtual time pass: Hamlib's 500 ms cache has then lapsed,
     * so the next read is a real transaction and not the cached answer from
     * the healthy session. */
    await window.__virtualClock.advance(600);

    const connectedBefore = rig.connected;

    /* The device is unplugged: the readable stream errors. */
    window.__fakeSerial.errorReadable('NetworkError');

    const failed = await window.__testHelpers.capture(() => rig.getFrequency());
    const connectedAfter = rig.connected;
    const closed = await window.__testHelpers.capture(() => rig.close());

    await hamlib.dispose();

    return { failed, closed, connectedBefore, connectedAfter };
  }));

  const result = expectOk(captured);

  const failed = expectFailure(result.failed);
  expect(failed.code).toBe('HAMLIB_ERROR');
  /* The lost port shows on the rig, before anything closes it. */
  expect(result.connectedBefore).toBe(true);
  expect(result.connectedAfter).toBe(false);
  /* -RIG_EIO, not a timeout: the transport failure is what the caller sees. */
  expect(failed.hamlibCode).toBe(-6);
  expect(failed.hamlibMessage).toBe('I/O error');

  expectOk(result.closed);

  const transport = await readFakeSerial(page);

  expect(transport.isOpen).toBe(false);
  expect(transport.closedWithLockedStreams).toBe(false);
});
