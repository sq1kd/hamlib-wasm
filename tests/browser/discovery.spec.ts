/**
 * Discovery: the `struct confparams` walkers and the scan/VFO predicates.
 *
 * These are the operations `tests/dumpcaps.c` and `tests/dumpstate.c` use, and
 * they are the only way a client can find out what a model offers without a
 * hardcoded model table.  The IC-746PRO is the fixture because its backend
 * declares the three extension parameters `dumpcaps` prints (`ssbbass`,
 * `sqlctrl`, `rttyfltr`) and its own scan/VFO suboperation masks, so the
 * predicates can be checked against a real backend rather than a callback's
 * mere presence.
 */
import { expect, test } from '@playwright/test';

import { installFakeSerial, installTestHelpers, installVirtualClock, useRig } from './fixtures';
import type { Captured } from './globals';

const HARNESS_URL = 'http://127.0.0.1:4174/';

/** `RIG_SCAN_MEM` and `RIG_OP_CPY` from the pinned `hamlib/rig.h`. */
const SCAN_MEM = 1;
const VFO_OP_CPY = 1;

function expectOk<T>(captured: Captured<T>): T {
  if (!captured.ok) {
    throw new Error(`expected success, got ${captured.error.code}: ${captured.error.message}`);
  }

  return captured.value;
}

test.beforeEach(async ({ page }) => {
  await installVirtualClock(page);
  await installFakeSerial(page);
  await installTestHelpers(page);
  await page.goto(HARNESS_URL);
  /* The IC-746PRO answers CI-V at 0x56. */
  await useRig(page, 'icom-ic746');
});

test('an IC-746PRO client discovers its extension parameters', async ({ page }) => {
  const captured = await page.evaluate(() => window.__testHelpers.capture(async () => {
    const hamlib = await window.__hamlibHarness.createRawHamlib({});
    const model = hamlib.models.find((candidate) => candidate.model === 'IC-746PRO');

    if (!model) { throw new Error('the IC-746PRO is missing from the catalogue'); }

    const port = await hamlib.requestPort();
    const rig = await hamlib.open({ modelId: model.id, port, baudRate: model.serialRateMax });

    try {
      const parms = await rig.extParmForeach();
      const levels = await rig.extLevelForeach();
      const funcs = await rig.extFuncForeach();

      return {
        parmNames: parms.map((parm) => parm.name),
        example: parms.find((parm) => parm.name === 'ssbbass') ?? null,
        /* An Embind-owned value object would not have the plain prototype. */
        plain: parms.every((parm) => Object.getPrototypeOf(parm) === Object.prototype),
        allNamed: parms.every((parm) => parm.name.length > 0 && parm.label.length > 0),
        levelNames: levels.map((parm) => parm.name),
        funcNames: funcs.map((parm) => parm.name),
      };
    } finally {
      await rig.close();
      await hamlib.dispose();
    }
  }));

  const result = expectOk(captured);

  /* The names `dumpcaps` prints for this model, discovered rather than known. */
  expect(result.parmNames).toEqual(expect.arrayContaining(['ssbbass', 'sqlctrl', 'rttyfltr']));
  expect(result.plain).toBe(true);
  expect(result.allNamed).toBe(true);

  /* A description, not just a name: token, label, tooltip, default and type. */
  expect(result.example).not.toBeNull();
  expect(result.example?.token).toBeGreaterThan(0);
  expect(result.example?.tooltip.length).toBeGreaterThan(0);
  expect(typeof result.example?.type).toBe('number');

  /* The three families are distinct tables, so a parameter of one is not
   * reported by another. */
  expect(result.levelNames).not.toContain('ssbbass');
  expect(result.funcNames).not.toContain('ssbbass');
});

test('configuration enumeration returns parameter descriptions', async ({ page }) => {
  const captured = await page.evaluate(() => window.__testHelpers.capture(async () => {
    const hamlib = await window.__hamlibHarness.createRawHamlib({});
    const model = hamlib.models.find((candidate) => candidate.model === 'IC-746PRO');

    if (!model) { throw new Error('the IC-746PRO is missing from the catalogue'); }

    const port = await hamlib.requestPort();
    const rig = await hamlib.open({ modelId: model.id, port, baudRate: model.serialRateMax });

    try {
      const tokens = await rig.tokenForeach();
      const pathname = tokens.find((token) => token.name === 'rig_pathname') ?? null;

      return {
        count: tokens.length,
        names: tokens.map((token) => token.name),
        pathname,
        plain: tokens.every((token) => Object.getPrototypeOf(token) === Object.prototype),
        described: tokens.every((token) => typeof token.token === 'number'),
      };
    } finally {
      await rig.close();
      await hamlib.dispose();
    }
  }));

  const result = expectOk(captured);

  /* The frontend's own table plus the model's serial parameters: a real
   * enumeration, with each entry described the way `dumpconf` prints it. */
  expect(result.count).toBeGreaterThan(1);
  expect(result.names).toEqual(expect.arrayContaining(['rig_pathname']));
  expect(result.pathname?.label.length).toBeGreaterThan(0);
  expect(result.pathname?.dflt.length).toBeGreaterThan(0);
  expect(result.plain).toBe(true);
  expect(result.described).toBe(true);
});

test('scan and VFO suboperations are distinguishable before use', async ({ page }) => {
  const captured = await page.evaluate(() => window.__testHelpers.capture(async () => {
    const hamlib = await window.__hamlibHarness.createRawHamlib({});
    const model = hamlib.models.find((candidate) => candidate.model === 'IC-746PRO');

    if (!model) { throw new Error('the IC-746PRO is missing from the catalogue'); }

    const port = await hamlib.requestPort();
    const rig = await hamlib.open({ modelId: model.id, port, baudRate: model.serialRateMax });

    try {
      return {
        scanMem: await rig.hasScan('MEM'),
        scanPlt: await rig.hasScan('PLT'),
        scanProg: await rig.hasScan('PROG'),
        vfoCpy: await rig.hasVfoOp('CPY'),
        vfoUp: await rig.hasVfoOp('UP'),
      };
    } finally {
      await rig.close();
      await hamlib.dispose();
    }
  }));

  const result = expectOk(captured);

  /* The masks are the backend's own `scan_ops`/`vfo_ops`, not a callback
   * presence boolean: `PLT` and `UP` are valid names the model does not
   * implement, so they come back zero while `MEM`/`PROG`/`CPY` come back with
   * their bit set. */
  expect(result.scanMem).toBe(SCAN_MEM);
  expect(result.scanProg).toBe(8);
  expect(result.scanPlt).toBe(0);
  expect(result.vfoCpy).toBe(VFO_OP_CPY);
  expect(result.vfoUp).toBe(0);
});
