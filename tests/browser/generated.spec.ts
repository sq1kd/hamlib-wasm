/**
 * The generated operation surface.
 *
 * Proves that the generator's output is reachable through the public API: the
 * capability matrix is derived from `struct rig_caps`, generated operations
 * are real typed methods on `Rig`, and an operation the model does not
 * implement is refused before the rig is touched.
 */
import { expect, test } from '@playwright/test';

import { installFakeSerial, installTestHelpers } from './fixtures';
import type { Captured, HamlibErrorView } from './globals';

const HARNESS_URL = 'http://127.0.0.1:4174/';

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
    throw new Error(`expected a failure but the page succeeded: ${JSON.stringify(captured.value)}`);
  }

  return captured.error;
}

test.beforeEach(async ({ page }) => {
  await installFakeSerial(page);
  await installTestHelpers(page);
  await page.goto(HARNESS_URL);
});

test('exposes the generated capability matrix and drives a generated operation', async ({ page }) => {
  const captured = await page.evaluate(() => window.__testHelpers.capture(async () => {
    const hamlib = await window.__hamlibHarness.createHamlib();
    const port = await hamlib.requestPort();
    const ts480 = hamlib.models.find((model) => model.model === 'TS-480');

    if (!ts480) {
      throw new Error('the TS-480 model is missing');
    }

    const capabilities = [...ts480.capabilities];
    const rig = await hamlib.open({ modelId: ts480.id, port });

    /* Pure generated operations read rig_caps only - no CAT traffic - so they
     * exercise the generated facade without depending on the emulator. */
    const resolution = await rig.getResolution('USB');
    const wide = await rig.passbandWide('USB');
    const license = await rig.license();
    const isTs480 = await rig.isModel(ts480.id);
    const confparam = await rig.confparamLookup('rig_pathname');
    const memoryCount = await rig.memCount();

    /* The str/parse codec crosses the token as a number, so a round trip
     * returns the name it parsed instead of echoing a name it was given. */
    const codec = {
      roundTrip: await rig.strVfo(await rig.parseVfo('VFOA')),
      hasAgc: await rig.hasGetLevel('AGC'),
      agcOff: await rig.valueAgcLevel(0),
      miss: await rig.extLookup('not_a_real_ext_param'),
    };

    /* The table walkers return the whole `confparams` projection; the ext
     * lookups turn a name back into a token and a token back into metadata. */
    const tokens = await rig.tokenForeach();
    const extLevels = await rig.extLevelForeach();
    const firstName = extLevels.length > 0 ? extLevels[0]?.name ?? '' : '';
    const extToken = firstName ? await rig.extTokenLookup(firstName) : 0;
    const extLookupTok = firstName ? await rig.extLookupTok(extToken) : null;
    const vfoList = await rig.getVfoList();

    /* A generated getter the TS-480 backend does not implement is gated by the
     * capability matrix, so it never reaches Wasm. */
    const gated = await window.__testHelpers.capture(() => rig.getParm('BAT'));

    await rig.close();
    await hamlib.dispose();

    return {
      capabilities,
      resolution,
      wide,
      license,
      isTs480,
      confparam,
      memoryCount,
      codec,
      tokens,
      extLevels,
      extToken,
      extLookupTok,
      vfoList,
      firstName,
      gated,
    };
  }));

  const result = expectOk(captured);

  /* The matrix is the intersection of the generated operations and the
   * backend's `rig_caps` function pointers (kenwood/ts480.c). */
  for (const supported of [
    'setVfo',
    'getVfo',
    'setRit',
    'getRit',
    'setXit',
    'getXit',
    'setSplitVfo',
    'getSplitVfo',
    'setPowerstat',
    'getPowerstat',
    'scan',
    'vfoOp',
    'getLevel',
    'setLevel',
    'getFunc',
    'setFunc',
  ]) {
    expect(result.capabilities).toContain(supported);
  }

  /* `setClock`/`getClock` exist in the file but belong to a sibling caps
   * (`qrplabs_caps`); the TS-480 has no DCS, tuning step or parameter table. */
  for (const absent of [
    'setClock',
    'getClock',
    'setDcsCode',
    'getDcsCode',
    'setTs',
    'getTs',
    'getParm',
    'setParm',
  ]) {
    expect(result.capabilities).not.toContain(absent);
  }

  expect(Number.isFinite(result.resolution)).toBe(true);
  expect(result.resolution).toBeGreaterThanOrEqual(0);
  expect(Number.isFinite(result.wide)).toBe(true);

  /* Pure helpers added with the numeric fallbacks: a string-returning helper
   * and an int predicate that is not an error code. */
  expect(typeof result.license).toBe('string');
  expect(result.license.length).toBeGreaterThan(0);
  expect(result.isTs480).toBe(1);

  /* A struct projection crosses as a value object; a memory count is a pure
   * int that is not an error code. */
  expect(typeof result.confparam.name).toBe('string');
  expect(typeof result.memoryCount).toBe('number');

  /* The token-side codec and the mask/lookup helpers. */
  expect(result.codec.roundTrip).toBe('VFOA');
  expect(typeof result.codec.hasAgc).toBe('number');
  expect(result.codec.agcOff).toBe(0);
  expect(result.codec.miss.name).toBe('');

  /* A table walker returns projected confparams; the ext lookups round trip
   * the name through the token. */
  expect(result.tokens.map((entry) => entry.name)).toContain('rig_pathname');
  expect(Array.isArray(result.extLevels)).toBe(true);
  if (result.firstName) {
    expect(result.extToken).toBeGreaterThan(0);
    expect(result.extLookupTok?.name).toBe(result.firstName);
  }

  expect(typeof result.vfoList).toBe('string');

  /* `get_ant` is one of the functions the TS-480 declares. */
  expect(result.capabilities).toContain('getAnt');

  const gated = expectFailure(result.gated);
  expect(gated.code).toBe('UNSUPPORTED_OPERATION');
  expect(gated.operation).toBe('getParm');
});
