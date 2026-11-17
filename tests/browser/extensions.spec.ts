/**
 * The operations hamlib-wasm adds around the generated surface: Hamlib
 * configuration tokens at open, Morse through the backend's own keyer
 * command, raw CAT bytes, the power conversions, and the diagnostics report.
 */
import { expect, test } from '@playwright/test';

import { installFakeSerial, installTestHelpers, installVirtualClock, useRig } from './fixtures';
import type { Captured } from './globals';

const HARNESS_URL = 'http://127.0.0.1:4174/';

function expectOk<T>(captured: Captured<T>): T {
  if (!captured.ok) {
    throw new Error(
      `expected success but the page reported ${captured.error.code}: ${captured.error.message}`,
    );
  }

  return captured.value;
}

test.beforeEach(async ({ page }) => {
  await installVirtualClock(page);
  await installFakeSerial(page);
  await installTestHelpers(page);
  await page.goto(HARNESS_URL);
});

test('civaddr reaches an Icom radio moved off its default address', async ({ page }) => {
  /* The IC-746 emulator answers on 0x56; the IC-703 model addresses 0x68. */
  await useRig(page, 'icom-ic746');

  const captured = await page.evaluate(() => window.__testHelpers.capture(async () => {
    const hamlib = await window.__hamlibHarness.createRawHamlib();
    const port = await hamlib.requestPort();
    const ic703 = hamlib.models.find((model) => model.manufacturer === 'Icom' && model.model === 'IC-703');

    if (!ic703) { throw new Error('the IC-703 model is missing'); }

    /* Addressed to 0x68, nothing on the bus answers. */
    const silent = await window.__testHelpers.capture(() => hamlib.open({ modelId: ic703.id, port }));
    const rig = await hamlib.open({ modelId: ic703.id, port, conf: { civaddr: '0x56' } });
    const frequency = await rig.getFrequency();

    await rig.close();
    await hamlib.dispose();

    return { silent, frequency };
  }));

  const result = expectOk(captured);

  expect(result.silent.ok).toBe(false);
  expect(result.frequency).toBe(14_074_000);
});

test('refuses owned, unreachable and unknown tokens', async ({ page }) => {
  const captured = await page.evaluate(() => window.__testHelpers.capture(async () => {
    const hamlib = await window.__hamlibHarness.createRawHamlib();
    const port = await hamlib.requestPort();
    const ts480 = hamlib.models.find((model) => model.model === 'TS-480');

    if (!ts480) { throw new Error('the TS-480 is missing'); }

    const attempt = (conf: Record<string, string>) =>
      window.__testHelpers.capture(() => hamlib.open({ modelId: ts480.id, port, conf }));

    const owned = await attempt({ serial_speed: '9600' });
    const unreachable = await attempt({ ptt_type: 'CM108' });
    const unknown = await attempt({ no_such_token: '1' });
    const accepted = await attempt({ post_write_delay: '5', ptt_type: 'RIG' });

    await hamlib.dispose();

    return { owned, unreachable, unknown, accepted: accepted.ok };
  }));

  const result = expectOk(captured);
  const code = (outcome: { ok: boolean; error?: { code: string | null } }): string | null =>
    outcome.ok ? null : (outcome.error?.code ?? null);

  expect(code(result.owned)).toBe('INVALID_ARGUMENT');
  expect(code(result.unreachable)).toBe('INVALID_ARGUMENT');
  expect(code(result.unknown)).toBe('HAMLIB_ERROR');
  expect(result.unknown.ok ? '' : result.unknown.error.message).toContain('no_such_token');
  expect(result.accepted).toBe(true);
});

test('sendRaw writes bytes as they are and reads up to the terminator', async ({ page }) => {
  const captured = await page.evaluate(() => window.__testHelpers.capture(async () => {
    const hamlib = await window.__hamlibHarness.createRawHamlib();
    const port = await hamlib.requestPort();
    const ts480 = hamlib.models.find((model) => model.model === 'TS-480');

    if (!ts480) { throw new Error('the TS-480 is missing'); }

    const rig = await hamlib.open({ modelId: ts480.id, port });
    const reply = await rig.sendRaw(new TextEncoder().encode('FA;'), { terminator: 0x3b });
    const writeOnly = await rig.sendRaw(new TextEncoder().encode('FA00007074000;'));
    const invalid = await window.__testHelpers.capture(() => rig.sendRaw(new Uint8Array()));
    const frequency = window.__fakeSerial.state.frequency;

    await rig.close();
    await hamlib.dispose();

    return {
      reply: new TextDecoder().decode(reply),
      writeOnly: writeOnly.length,
      invalid: invalid.ok ? null : invalid.error.code,
      frequency,
    };
  }));

  const result = expectOk(captured);

  expect(result.reply).toBe('FA00014074000;');
  expect(result.writeOnly).toBe(0);
  expect(result.invalid).toBe('INVALID_ARGUMENT');
  expect(result.frequency).toBe(7_074_000);
});

test('sendMorse keys through the backend in chunks, and only in CW', async ({ page }) => {
  const captured = await page.evaluate(() => window.__testHelpers.capture(async () => {
    const hamlib = await window.__hamlibHarness.createHamlib();
    const ts480 = hamlib.models.find((model) => model.model === 'TS-480');

    if (!ts480) { throw new Error('the TS-480 is missing'); }

    const rig = await hamlib.open({ modelId: ts480.id });
    const notCw = await window.__testHelpers.capture(() => rig.sendMorse('TEST'));

    await rig.setMode('CW');
    /* 30 characters: more than the 24 a Kenwood keyer command carries. */
    await rig.sendMorse('CQ CQ DE SP0ABC SP0ABC PSE K ');
    await rig.stopMorse();

    const keyed = window.__fakeSerial.commands.filter((command) => command.startsWith('KY '));
    const capabilities = rig.capabilities;

    await rig.close();
    await hamlib.dispose();

    return { notCw, keyed, sendMorse: capabilities.sendMorse };
  }));

  const result = expectOk(captured);

  expect(result.sendMorse).toBe(true);
  expect(result.notCw.ok).toBe(false);
  expect(result.notCw.ok ? '' : result.notCw.error.message).toContain('CW');
  /* Each keyer command is space padded, so compare the letters only. */
  expect(result.keyed.length).toBeGreaterThan(1);
  expect(result.keyed.map((command) => command.slice(3)).join('').replace(/ /g, '')).toBe(
    'CQCQDESP0ABCSP0ABCPSEK',
  );
});

test('converts a power level to milliwatts through the model\'s ranges', async ({ page }) => {
  const captured = await page.evaluate(() => window.__testHelpers.capture(async () => {
    const hamlib = await window.__hamlibHarness.createRawHamlib();
    const port = await hamlib.requestPort();
    const ts480 = hamlib.models.find((model) => model.model === 'TS-480');

    if (!ts480) { throw new Error('the TS-480 is missing'); }

    const rig = await hamlib.open({ modelId: ts480.id, port });
    const full = await rig.powerToMilliwatts(1, 14_074_000, 'USB');
    const back = await rig.milliwattsToPower(full, 14_074_000, 'USB');

    await rig.close();
    await hamlib.dispose();

    return { full, back };
  }));

  const result = expectOk(captured);

  expect(result.full).toBeGreaterThan(0);
  expect(result.back).toBeCloseTo(1, 2);
});

test('diagnostics carry the rigs, the port traffic, errors and debug lines', async ({ page }) => {
  const captured = await page.evaluate(() => window.__testHelpers.capture(async () => {
    const lines: string[] = [];
    const hamlib = await window.__hamlibHarness.createHamlib({
      debug: { level: 'verbose', onLog: (entry) => { lines.push(entry.message); } },
    });
    const ts480 = hamlib.models.find((model) => model.model === 'TS-480');

    if (!ts480) { throw new Error('the TS-480 is missing'); }

    const rig = await hamlib.open({ modelId: ts480.id });

    await rig.refresh();
    // @ts-expect-error -- not a Hamlib mode: the runtime refusal a plain-JS caller gets.
    await window.__testHelpers.capture(() => rig.setMode('NOT-A-MODE'));

    const report = JSON.parse(JSON.stringify(hamlib.diagnostics()));

    const hooked = lines.length;

    await rig.close();
    await hamlib.dispose();

    return { report, hooked };
  }));

  const { report, hooked } = expectOk(captured);

  expect(report.debugLevel).toBe('verbose');
  expect(report.rigs).toHaveLength(1);
  expect(report.rigs[0].model).toBe('TS-480');
  expect(report.trace.some((entry: { direction: string; hex: string }) =>
    entry.direction === 'tx' && entry.hex === '46413b')).toBe(true);
  expect(report.trace.some((entry: { direction: string }) => entry.direction === 'rx')).toBe(true);
  expect(report.errors.length).toBeGreaterThan(0);
  expect(report.log.length).toBeGreaterThan(0);
  /* The hook saw every line the report kept (the buffer is not full yet). */
  expect(hooked).toBe(report.log.length);
});

test('every generated name is one the built module parses', async ({ page }) => {
  const captured = await page.evaluate(() => window.__testHelpers.capture(async () => {
    const hamlib = await window.__hamlibHarness.createRawHamlib();
    const port = await hamlib.requestPort();
    const ts480 = hamlib.models.find((model) => model.model === 'TS-480');

    if (!ts480) { throw new Error('the TS-480 is missing'); }

    const rig = await hamlib.open({ modelId: ts480.id, port });
    const names = window.__hamlibHarness.vocabularies;
    const parsers: Record<string, (name: string) => Promise<number>> = {
      RIG_MODES: (name) => rig.parseMode(name),
      VFOS: (name) => rig.parseVfo(name),
      LEVELS: (name) => rig.parseLevel(name),
      FUNCS: (name) => rig.parseFunc(name),
      PARMS: (name) => rig.parseParm(name),
      VFO_OPS: (name) => rig.parseVfoOp(name),
      SCAN_OPS: (name) => rig.parseScan(name),
      RPTR_SHIFTS: (name) => rig.parseRptrShift(name),
    };
    const unparsed: string[] = [];
    let checked = 0;

    for (const [vocabulary, parse] of Object.entries(parsers)) {
      for (const name of names[vocabulary] ?? []) {
        checked++;

        /* "None" is a real name whose value is the NONE sentinel, 0. */
        if (name !== 'None' && (await parse(name)) === 0) {
          unparsed.push(`${vocabulary}:${name}`);
        }
      }
    }

    await rig.close();
    await hamlib.dispose();

    return { unparsed, checked };
  }));

  const result = expectOk(captured);

  expect(result.unparsed).toEqual([]);
  expect(result.checked).toBeGreaterThan(200);
});
