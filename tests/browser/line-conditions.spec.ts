/**
 * What a real serial line does that a clean emulator does not: replies that
 * arrive in pieces, an echo of every command, and stale bytes waiting in the
 * receive queue.  Reassembling and skipping them is the transport's and
 * Hamlib's job together; these specs drive one rig of each framing family
 * through them.
 */

import {
  expect,
  expectOk,
  setEcho,
  setEmulatorSilent,
  setReplyFragments,
  test,
  useRig,
} from './fixtures';
import { CACHE_LAPSE_MS, RIG_ETIMEOUT } from '../hamlib-constants';

/** One rig per framing: `;`-terminated ASCII, CI-V binary, newcat ASCII, fixed-length binary. */
const FAMILIES: readonly { rig: FakeRigName; manufacturer: string; model: string; baudRate?: number }[] = [
  { rig: 'kenwood-ts480', manufacturer: 'Kenwood', model: 'TS-480' },
  { rig: 'icom-ic703', manufacturer: 'Icom', model: 'IC-703' },
  { rig: 'yaesu-ft710', manufacturer: 'Yaesu', model: 'FT-710', baudRate: 38_400 },
  { rig: 'yaesu-frg100', manufacturer: 'Yaesu', model: 'FRG-100' },
];

/** Open the rig, read what the model can, close it. */
async function readOnce(
  page: import('@playwright/test').Page,
  family: (typeof FAMILIES)[number],
): Promise<{ frequency: number; mode: string | null }> {
  const captured = await page.evaluate((target) => window.__testHelpers.capture(async () => {
    const hamlib = await window.__hamlibHarness.createRawHamlib();
    const port = await hamlib.requestPort();
    const model = window.__testHelpers.catalogueModel(hamlib.models, target.manufacturer, target.model);

    const rig = await hamlib.open({
      modelId: model.id,
      port,
      ...(target.baudRate === undefined ? {} : { baudRate: target.baudRate }),
    });
    const frequency = await rig.getFrequency();
    const mode = model.capabilities.has('getMode') ? (await rig.getMode()).mode : null;

    await rig.close();
    await hamlib.dispose();

    return { frequency, mode };
  }), family);

  return expectOk(captured);
}

for (const family of FAMILIES) {
  test(`${family.model}: a reply split into pieces reads the same as a whole one`, async ({ harnessPage: page }) => {
    await useRig(page, family.rig);

    const whole = await readOnce(page, family);

    /* One byte at a time, then three: the worst case and a typical adapter. */
    await setReplyFragments(page, 1, 2);
    const bytewise = await readOnce(page, family);

    await setReplyFragments(page, 3, 1);
    const triples = await readOnce(page, family);

    expect(bytewise).toEqual(whole);
    expect(triples).toEqual(whole);
  });
}

test('an echoing CI-V line still reads the radio', async ({ harnessPage: page }) => {
  await useRig(page, 'icom-ic703');
  await setEcho(page, true);

  const result = await readOnce(page, FAMILIES[1] as (typeof FAMILIES)[number]);

  expect(result.frequency).toBe(14_074_000);
  expect(result.mode).toBe('USB');
});

test('an echo alone is not a rig answering the open', async ({ harnessPage: page }) => {
  /* The interface echoes, the radio behind it is switched off. */
  await useRig(page, 'icom-ic703');
  await setEcho(page, true);
  await setEmulatorSilent(page, true);

  const captured = await page.evaluate(() => window.__testHelpers.capture(async () => {
    const hamlib = await window.__hamlibHarness.createRawHamlib();
    const port = await hamlib.requestPort();
    const ic703 = window.__testHelpers.catalogueModel(hamlib.models, 'Icom', 'IC-703');

    const opened = await window.__testHelpers.capture(() => hamlib.open({ modelId: ic703.id, port }));

    await hamlib.dispose();

    return opened;
  }));

  const opened = expectOk(captured);

  /* The Icom backend's own open reads the radio and times out on an echo, so
   * the open fails in Hamlib - before the facade's "nothing arrived" check,
   * which an echo would satisfy, ever decides. */
  expect(opened.ok).toBe(false);
  expect(opened.ok ? null : opened.error.hamlibCode).toBe(-RIG_ETIMEOUT);
});

test('stale bytes in the receive queue do not become the next reply', async ({ harnessPage: page }) => {
  const captured = await page.evaluate((cacheLapseMs) => window.__testHelpers.capture(async () => {
    const hamlib = await window.__hamlibHarness.createRawHamlib();
    const port = await hamlib.requestPort();
    const ts480 = window.__testHelpers.catalogueModel(hamlib.models, 'Kenwood', 'TS-480');

    const rig = await hamlib.open({ modelId: ts480.id, port });

    /* A late reply to some earlier command, and line noise, waiting unread.
     * Past Hamlib's cache, the next read is a real transaction. */
    window.__fakeSerial.pushRaw('\u0000ÿFA00099999999;');
    await window.__virtualClock.advance(cacheLapseMs);

    const frequency = await rig.getFrequency();

    await rig.close();
    await hamlib.dispose();

    return frequency;
  }), CACHE_LAPSE_MS);

  expect(expectOk(captured)).toBe(14_074_000);
});
