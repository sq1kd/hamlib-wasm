/**
 * The generated operation surface.
 *
 * Proves that the generator's output is reachable through the public API: the
 * capability matrix is derived from `struct rig_caps`, generated operations
 * are real typed methods on `RawRig`, and an operation the model does not
 * implement is refused before the rig is touched.
 */

import { RIG_EINVAL } from '../hamlib-constants';
import { expect, expectFailure, expectOk, test, useRig } from './fixtures';

test('exposes the generated capability matrix and drives a generated operation', async ({ harnessPage: page }) => {
  const captured = await page.evaluate(() => window.__testHelpers.capture(async () => {
    const hamlib = await window.__hamlibHarness.createRawHamlib();
    const port = await hamlib.requestPort();
    const ts480 = window.__testHelpers.catalogueModel(hamlib.models, 'Kenwood', 'TS-480');

    const capabilities = [...ts480.capabilities];
    const rig = await hamlib.open({ modelId: ts480.id, port });

    /* Pure generated operations read rig_caps only - no CAT traffic - so they
     * exercise the generated facade without depending on the emulator. */
    const wide = await rig.passbandWide('USB');
    const narrow = await rig.passbandNarrow('USB');

    /* The str/parse codec crosses the token as a number, so a round trip
     * returns the name it parsed instead of echoing a name it was given. */
    const codec = {
      vfo: await rig.strVfo(await rig.parseVfo('VFOA')),
      mode: await rig.strRmode(await rig.parseMode('USB')),
      hasAgc: await rig.hasGetLevel('AGC'),
    };

    /* `rig_ext_lookup` answers NULL for a name or token that is not an
     * extension parameter, which fails the call rather than projecting
     * nothing. */
    const miss = await window.__testHelpers.capture(() => rig.extLookup('not_a_real_ext_param'));
    const missTok = await window.__testHelpers.capture(() => rig.extLookupTok(0));
    const setting = await rig.idxToSetting(await rig.settingToIdx(0));

    /* An integer argument takes a whole number its C type can hold; anything
     * else is refused instead of truncated. */
    const fraction = await window.__testHelpers.capture(() => rig.strLevel(1.5));
    const outOfRange = await window.__testHelpers.capture(() => rig.strLevel(2 ** 64));

    /* A generated getter the TS-480 backend does not implement is gated by the
     * capability matrix, so it never reaches Wasm. */
    const gated = await window.__testHelpers.capture(() => rig.getParm('BAT'));

    await rig.close();
    await hamlib.dispose();

    return {
      capabilities,
      wide,
      narrow,
      codec,
      miss,
      missTok,
      setting,
      fraction,
      outOfRange,
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

  /* Two pure helpers that read `rig_caps` and answer with a width; the values
   * themselves are a backend fact, so only the shape is asserted. */
  expect(Number.isFinite(result.wide)).toBe(true);
  expect(Number.isFinite(result.narrow)).toBe(true);
  expect(result.wide).toBeGreaterThanOrEqual(0);
  expect(result.narrow).toBeGreaterThanOrEqual(0);

  /* The token-side codec and the mask helpers. */
  expect(result.codec.vfo).toBe('VFOA');
  expect(result.codec.mode).toBe('USB');
  expect(typeof result.codec.hasAgc).toBe('boolean');

  expect(typeof result.setting).toBe('number');

  for (const refused of [
    expectFailure(result.miss),
    expectFailure(result.missTok),
    expectFailure(result.fraction),
    expectFailure(result.outOfRange),
  ]) {
    expect(refused.hamlibCode).toBe(-RIG_EINVAL);
  }

  /* `get_ant` is one of the functions the TS-480 declares. */
  expect(result.capabilities).toContain('getAnt');

  const gated = expectFailure(result.gated);
  expect(gated.code).toBe('UNSUPPORTED_OPERATION');
  expect(gated.operation).toBe('getParm');
});

test('getChannel reads the memory channel the caller selects', async ({ harnessPage: page }) => {
  await useRig(page, 'yaesu-ft710');

  const captured = await page.evaluate(() => window.__testHelpers.capture(async () => {
    const hamlib = await window.__hamlibHarness.createRawHamlib();
    const port = await hamlib.requestPort();
    const ft710 = window.__testHelpers.catalogueModel(hamlib.models, 'Yaesu', 'FT-710');
    const rig = await hamlib.open({ modelId: ft710.id, port, baudRate: 38400 });

    const before = window.__fakeSerial.commands.length;
    const channel = await rig.getChannel({ vfo: 'MEM', channelNum: 5 }, true);
    const commands = window.__fakeSerial.commands.slice(before);

    await rig.close();
    await hamlib.dispose();

    return { channel, commands };
  }));

  const result = expectOk(captured);

  /* newcat_get_channel() reads chan->channel_num; the emulator rejects the
   * empty channel with `?;`, which Hamlib reports as an empty channel. */
  expect(result.commands).toContain('MT005;');
  expect(result.channel.channelNum).toBe(5);
  expect(result.channel.vfo).toBe('MEM');
  expect(result.channel.freq).toBe(0);
  /* An empty channel's modes, transmit VFO and shift are the NONE values,
   * which the vocabularies name 'None'. */
  expect(result.channel.mode).toBe('None');
  expect(result.channel.txMode).toBe('None');
  expect(result.channel.txVfo).toBe('None');
  expect(result.channel.rptrShift).toBe('None');
});

test('the NONE repeater shift is a setting, while an unknown name is refused', async ({ harnessPage: page }) => {
  await useRig(page, 'icom-ic746');

  const captured = await page.evaluate(() => window.__testHelpers.capture(async () => {
    const hamlib = await window.__hamlibHarness.createRawHamlib();
    const port = await hamlib.requestPort();
    const ic746 = window.__testHelpers.catalogueModel(hamlib.models, 'Icom', 'IC-746');
    const rig = await hamlib.open({ modelId: ic746.id, port });

    await rig.setRptrShift('+');
    const plus = await rig.getRptrShift();
    await rig.setRptrShift('None');
    const none = await rig.getRptrShift();
    const unknown = await window.__testHelpers.capture(() => rig.setRptrShift('simplex' as 'None'));
    const commands = [...window.__fakeSerial.commands];

    await rig.close();
    await hamlib.dispose();

    return { plus, none, unknown, commands };
  }));

  const result = expectOk(captured);

  expect(result.plus).toBe('+');
  expect(result.none).toBe('None');
  /* `0F 10` is the CI-V simplex command icom_set_rptr_shift() sends for RIG_RPT_SHIFT_NONE. */
  expect(result.commands).toContain('0F 10');
  expect(expectFailure(result.unknown).hamlibCode).toBe(-RIG_EINVAL);
});
