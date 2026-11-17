/**
 * Deterministic transport and lifecycle checks.
 *
 * These run against the built package in a real browser, driving the Web
 * Serial double over the harness page.  No timing assumptions beyond the
 * emulator's immediate replies.
 */

import {
  expect,
  expectFailure,
  expectOk,
  failNextPortOpen,
  readFakeSerial,
  removeWebSerial,
  test,
  TS480_LINE_SETTINGS,
} from './fixtures';
import { UPSTREAM_VERSION } from './upstream';
import { CACHE_LAPSE_MS, HAMLIB_MESSAGE, RIG_ECONF, RIG_EINVAL, RIG_ETIMEOUT } from '../hamlib-constants';

interface ModelSummary {
  id: number;
  manufacturer: string;
  model: string;
  backendVersion: string;
  status: number;
  serialRateMin: number;
  serialRateMax: number;
  canGetFrequency: boolean;
  canSetFrequency: boolean;
  canGetMode: boolean;
  canSetMode: boolean;
  canGetPtt: boolean;
  canSetPtt: boolean;
}

test('lists the serial rig catalogue sorted by manufacturer and model', async ({ harnessPage: page }) => {
  const captured = await page.evaluate(() => window.__testHelpers.capture(async () => {
    const hamlib = await window.__hamlibHarness.createRawHamlib();

    const models: ModelSummary[] = hamlib.models.map((model) => ({
      id: model.id,
      manufacturer: model.manufacturer,
      model: model.model,
      backendVersion: model.backendVersion,
      status: model.status,
      serialRateMin: model.serialRateMin,
      serialRateMax: model.serialRateMax,
      canGetFrequency: model.canGetFrequency,
      canSetFrequency: model.canSetFrequency,
      canGetMode: model.canGetMode,
      canSetMode: model.canSetMode,
      canGetPtt: model.canGetPtt,
      canSetPtt: model.canSetPtt,
    }));

    const version = hamlib.version;
    await hamlib.dispose();

    return { version, models };
  }));

  const { version, models } = expectOk(captured);

  expect(version).toContain(UPSTREAM_VERSION);
  expect(models.length).toBeGreaterThan(50);

  for (const model of models) {
    expect(model.manufacturer.length).toBeGreaterThan(0);
    expect(model.model.length).toBeGreaterThan(0);
    expect(Number.isInteger(model.id)).toBe(true);
  }

  /* Sorted the same way the native side sorts: byte-wise, then by id. */
  const sorted = [...models].sort((left, right) => {
    if (left.manufacturer !== right.manufacturer) {
      return left.manufacturer < right.manufacturer ? -1 : 1;
    }

    if (left.model !== right.model) {
      return left.model < right.model ? -1 : 1;
    }

    return left.id - right.id;
  });

  expect(models.map((model) => model.id)).toEqual(sorted.map((model) => model.id));

  const ts480 = models.find(
    (model) => model.manufacturer === 'Kenwood' && model.model === 'TS-480',
  );

  expect(ts480).toBeDefined();
  expect(ts480?.serialRateMin).toBe(4800);
  expect(ts480?.serialRateMax).toBe(115200);
  expect(ts480?.canGetFrequency).toBe(true);
  expect(ts480?.canSetFrequency).toBe(true);
  expect(ts480?.canGetMode).toBe(true);
  expect(ts480?.canSetMode).toBe(true);
  expect(ts480?.canGetPtt).toBe(true);
  expect(ts480?.canSetPtt).toBe(true);
});

test('reports TRANSPORT_UNAVAILABLE when the browser has no Web Serial', async ({ harnessPage: page }) => {
  await removeWebSerial(page);

  const captured = await page.evaluate(() => window.__testHelpers.capture(async () => {
    const hamlib = await window.__hamlibHarness.createRawHamlib();
    const port = window.__fakeSerial.port;

    const request = await window.__testHelpers.capture(() => hamlib.requestPort());
    const open = await window.__testHelpers.capture(
      () => hamlib.open({ modelId: 1, port }),
    );

    await hamlib.dispose();

    return { request, open };
  }));

  const { request, open } = expectOk(captured);

  expect(expectFailure(request).code).toBe('TRANSPORT_UNAVAILABLE');
  expect(expectFailure(request).operation).toBe('requestPort');
  expect(expectFailure(open).code).toBe('TRANSPORT_UNAVAILABLE');
  expect(expectFailure(open).operation).toBe('open');
});

test('rejects a device path, which only the Node transport can open', async ({ harnessPage: page }) => {
  const captured = await page.evaluate(() => window.__testHelpers.capture(async () => {
    const hamlib = await window.__hamlibHarness.createRawHamlib();

    const byPath = await window.__testHelpers.capture(
      () => hamlib.requestPort({ path: '/dev/tty.usbserial-1410' }),
    );

    await hamlib.dispose();

    return { byPath };
  }));

  /* The browser chooses the port, so a `path` is a caller mistake and not a
   * runtime accident: this is the Web Serial transport's own refusal. */
  const byPath = expectFailure(expectOk(captured).byPath);

  expect(byPath.code).toBe('INVALID_ARGUMENT');
  expect(byPath.operation).toBe('requestPort');
  expect(byPath.message).toContain('path');
});

test('uses a caller-supplied transport instead of Web Serial', async ({ harnessPage: page }) => {
  const captured = await page.evaluate(() => window.__testHelpers.capture(async () => {
    const transport = window.__hamlibHarness.fakeTransport(window.__fakeSerial.port);
    const hamlib = await window.__hamlibHarness.createRawHamlib({ transport });
    const ts480 = window.__testHelpers.catalogueModel(hamlib.models, 'Kenwood', 'TS-480');

    const port = await hamlib.requestPort();
    const rig = await hamlib.open({ modelId: ts480.id, port });
    const frequency = await rig.getFrequency();

    await rig.close();
    await hamlib.dispose();

    return { frequency, calls: transport.calls, closed: rig.connected };
  }));

  const result = expectOk(captured);

  expect(result.frequency).toBe(14_074_000);
  expect(result.calls).toEqual(['requestPort']);
  expect(result.closed).toBe(false);

  /* The rig really ran: the port the injected transport handed over is the
   * fake Web Serial one, and it was opened and closed cleanly. */
  const transport = await readFakeSerial(page);

  expect(transport.openCount).toBe(1);
  expect(transport.closeCount).toBe(1);
  expect(transport.isOpen).toBe(false);
  expect(transport.closedWithLockedStreams).toBe(false);
  expect(transport.commands).toContain('ID');
});

test('rejects an unknown model and baud rate, and surfaces Hamlib rejecting input', async ({ harnessPage: page }) => {
  const captured = await page.evaluate(() => window.__testHelpers.capture(async () => {
    const hamlib = await window.__hamlibHarness.createRawHamlib();
    const port = window.__fakeSerial.port;
    const ts480 = window.__testHelpers.catalogueModel(hamlib.models, 'Kenwood', 'TS-480');

    const unknownModel = await window.__testHelpers.capture(
      () => hamlib.open({ modelId: 999_999, port }),
    );
    const badBaud = await window.__testHelpers.capture(
      () => hamlib.open({ modelId: ts480.id, port, baudRate: 300 }),
    );

    const rig = await hamlib.open({ modelId: ts480.id, port });

    /* The library no longer validates arguments (Hamlib owns the semantics),
     * so an out-of-range frequency is Hamlib's to reject; a mode name it does
     * not know is a guaranteed -RIG_EINVAL from rig_parse_mode(). */
    // @ts-expect-error -- not a Hamlib mode: the runtime refusal a plain-JS caller gets.
    const badMode = await window.__testHelpers.capture(() => rig.setMode('NOT-A-MODE', 0));

    await rig.close();
    await hamlib.dispose();

    return { unknownModel, badBaud, badMode };
  }));

  const results = expectOk(captured);

  const unknownModel = expectFailure(results.unknownModel);
  expect(unknownModel.code).toBe('INVALID_ARGUMENT');
  expect(unknownModel.message).toContain('999999');

  const badBaud = expectFailure(results.badBaud);
  expect(badBaud.code).toBe('INVALID_ARGUMENT');
  expect(badBaud.message).toContain('4800-115200');

  /* Hamlib's own rig_parse_mode() rejects the mode name. */
  const badMode = expectFailure(results.badMode);
  expect(badMode.code).toBe('HAMLIB_ERROR');
  /* Hamlib reports failures as negative codes. */
  expect(badMode.hamlibCode).toBe(-RIG_EINVAL);
  expect(badMode.hamlibMessage).toBe(HAMLIB_MESSAGE[RIG_EINVAL]);
  expect(badMode.operation).toBe('setMode');
});

test('opens a rig, drives it over the transport and releases the port', async ({ harnessPage: page }) => {
  const captured = await page.evaluate(() => window.__testHelpers.capture(async () => {
    const hamlib = await window.__hamlibHarness.createRawHamlib();
    const port = await hamlib.requestPort();
    const ts480 = window.__testHelpers.catalogueModel(hamlib.models, 'Kenwood', 'TS-480');

    const rig = await hamlib.open({ modelId: ts480.id, port });

    const frequencyBefore = await rig.getFrequency();
    const modeBefore = await rig.getMode();
    await rig.setFrequency(7_074_000);
    const frequency = await rig.getFrequency();
    await rig.setMode('CW', 500);
    const mode = await rig.getMode();
    await rig.setPtt('on');
    const pttOn = await rig.getPtt();
    await rig.setPtt('off');
    const pttOff = await rig.getPtt();

    await rig.close();
    const connectedAfterClose = rig.connected;

    /* close() is idempotent and operations after close are rejected. */
    const secondClose = await window.__testHelpers.capture(() => rig.close());
    const afterClose = await window.__testHelpers.capture(() => rig.getFrequency());

    await hamlib.dispose();
    const secondDispose = await window.__testHelpers.capture(() => hamlib.dispose());
    const afterDispose = await window.__testHelpers.capture(() => hamlib.requestPort());

    return {
      serialRateMax: ts480.serialRateMax,
      frequencyBefore,
      modeBefore,
      frequency,
      mode,
      pttOn,
      pttOff,
      connectedAfterClose,
      secondClose,
      afterClose,
      secondDispose,
      afterDispose,
    };
  }));

  const result = expectOk(captured);

  expect(result.frequencyBefore).toBe(14_074_000);
  expect(result.modeBefore.mode).toBe('USB');
  expect(result.modeBefore.passband).toBe(2400);

  expect(result.frequency).toBe(7_074_000);
  expect(result.mode.mode).toBe('CW');
  expect(result.mode.passband).toBe(500);

  expect(result.pttOn).toBe('on');
  expect(result.pttOff).toBe('off');

  expect(result.connectedAfterClose).toBe(false);
  expectOk(result.secondClose);

  const afterClose = expectFailure(result.afterClose);
  expect(afterClose.code).toBe('RIG_CLOSED');
  expect(afterClose.operation).toBe('getFrequency');

  expectOk(result.secondDispose);

  const afterDispose = expectFailure(result.afterDispose);
  expect(afterDispose.code).toBe('DISPOSED');

  const transport = await readFakeSerial(page);

  /* The port was opened once, with the model's line settings, and closed. */
  expect(transport.openCount).toBe(1);
  expect(transport.closeCount).toBe(1);
  expect(transport.isOpen).toBe(false);
  expect(transport.closedWithLockedStreams).toBe(false);
  expect(transport.openedOptions).toEqual({
    baudRate: result.serialRateMax,
    ...TS480_LINE_SETTINGS,
  });

  /* Real round trips reached the emulator. */
  expect(transport.commands).toContain('ID');
  expect(transport.commands).toContain('FA');
  expect(transport.commands).toContain('FA00007074000');
  expect(transport.commands).toContain('MD3');
  expect(transport.commands).toContain('FW0500');
  expect(transport.commands).toContain('TX');
  expect(transport.commands).toContain('RX');

  expect(transport.state.frequency).toBe(7_074_000);
  expect(transport.state.modeDigit).toBe(3);
  expect(transport.state.filterValue).toBe(500);
  expect(transport.state.transmitting).toBe(false);
});

test('reports a Hamlib timeout and recovers on the next read', async ({ harnessPage: page }) => {
  const captured = await page.evaluate((cacheLapseMs) => window.__testHelpers.capture(async () => {
    const hamlib = await window.__hamlibHarness.createRawHamlib();
    const port = await hamlib.requestPort();
    const ts480 = window.__testHelpers.catalogueModel(hamlib.models, 'Kenwood', 'TS-480');

    const rig = await hamlib.open({ modelId: ts480.id, port });
    const before = await rig.getFrequency();

    /* The emulator stops answering, so the next read runs into Hamlib's own
     * timeout (TS-480 caps: 500 ms, 3 retries), on virtual time.  Hamlib's
     * cache of the frequency read above lapses first, so the read reaches the
     * wire. */
    window.__fakeSerial.state.silent = true;
    await window.__virtualClock.advance(cacheLapseMs);
    const silent = await window.__testHelpers.capture(() => rig.getFrequency());
    const connectedAfterTimeout = rig.connected;

    /* The emulator answers again: the same rig reads without a reconnect. */
    window.__fakeSerial.state.silent = false;
    const recovered = await window.__testHelpers.capture(() => rig.getFrequency());

    await rig.close();
    await hamlib.dispose();

    return { before, silent, connectedAfterTimeout, recovered };
  }), CACHE_LAPSE_MS);

  const result = expectOk(captured);

  expect(result.before).toBe(14_074_000);

  const error = expectFailure(result.silent);
  expect(error.code).toBe('HAMLIB_ERROR');
  expect(error.operation).toBe('getFrequency');
  expect(error.hamlibCode).toBe(-RIG_ETIMEOUT);
  expect(error.hamlibMessage).toBe(HAMLIB_MESSAGE[RIG_ETIMEOUT]);

  /* A timeout is reported, not fatal. */
  expect(result.connectedAfterTimeout).toBe(true);
  expect(expectOk(result.recovered)).toBe(14_074_000);

  const transport = await readFakeSerial(page);
  expect(transport.openCount).toBe(1);
  expect(transport.isOpen).toBe(false);
  expect(transport.closedWithLockedStreams).toBe(false);
});

test('surfaces a Hamlib error when the port cannot be opened', async ({ harnessPage: page }) => {
  await failNextPortOpen(page, 'TypeError');

  const captured = await page.evaluate(() => window.__testHelpers.capture(async () => {
    const hamlib = await window.__hamlibHarness.createRawHamlib();
    const port = await hamlib.requestPort();
    const ts480 = window.__testHelpers.catalogueModel(hamlib.models, 'Kenwood', 'TS-480');

    const rejected = await window.__testHelpers.capture(
      () => hamlib.open({ modelId: ts480.id, port }),
    );

    /* The logical path must not stay registered: the retry succeeds. */
    const retried = await window.__testHelpers.capture(async () => {
      const rig = await hamlib.open({ modelId: ts480.id, port });
      const frequency = await rig.getFrequency();
      await rig.close();
      return frequency;
    });

    await hamlib.dispose();

    return { rejected, retried };
  }));

  const { rejected, retried } = expectOk(captured);

  const error = expectFailure(rejected);
  expect(error.code).toBe('HAMLIB_ERROR');
  /* Web Serial refused the requested line settings. */
  expect(error.hamlibCode).toBe(-RIG_ECONF);
  expect(error.hamlibMessage).toBe(HAMLIB_MESSAGE[RIG_ECONF]);
  expect(error.operation).toBe('open');

  expect(expectOk(retried)).toBe(14_074_000);

  const transport = await readFakeSerial(page);
  expect(transport.openCount).toBe(1);
  expect(transport.isOpen).toBe(false);
  expect(transport.closedWithLockedStreams).toBe(false);
});
