/**
 * Recorded behavioural baseline for the pinned upstream release.
 *
 * This spec runs the same fixed transaction against the built package every
 * time and compares it with `packages/hamlib-web/baseline/baseline.json`:
 *
 *   - the upstream version the module reports must match the release manifest,
 *   - the serial model catalogue must hash to the recorded digest,
 *   - the TS-480 capability record and the exact command sequence of a
 *     status/frequency/mode/PTT transaction must match.
 *
 * That is the tripwire for the "reduce upstream coupling" work: a change to
 * the transport wiring, the facade or the build must not move the catalogue or
 * the wire traffic.
 *
 * Re-record with:
 *   HAMLIBS_WEB_RECORD_BASELINE=1 npx playwright test tests/browser/baseline.spec.ts
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

import { installFakeSerial, installTestHelpers } from './fixtures';
import {
  UPSTREAM_MANIFEST,
  UPSTREAM_VERSION,
  readBuiltProvenance,
  readRepositoryPatch,
  readShippedPatch,
  sha256,
} from './upstream';

const BASELINE_PATH = fileURLToPath(
  new URL('../../packages/hamlib-web/baseline/baseline.json', import.meta.url),
);

const HARNESS_URL = 'http://127.0.0.1:4174/';

const RECORD = process.env.HAMLIBS_WEB_RECORD_BASELINE === '1';

interface Ts480Sample {
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
  wire: string[];
}

interface Sample {
  version: string;
  catalogueCount: number;
  catalogueText: string;
  ts480: Ts480Sample;
  frequency: number;
  mode: { mode: string; passband: number };
}

interface Baseline {
  catalogue: { count: number; sha256: string };
  ts480: Omit<Ts480Sample, 'wire'> & { wire: string[] };
}

test('the built package provenance matches the release manifest', () => {
  const provenance = readBuiltProvenance();

  expect(provenance.version).toBe(UPSTREAM_MANIFEST.version);
  expect(provenance.series).toBe(UPSTREAM_MANIFEST.series);
  expect(provenance.license).toBe(UPSTREAM_MANIFEST.license);
  expect(provenance.url).toBe(UPSTREAM_MANIFEST.archive.url);
  expect(provenance.sha256).toBe(UPSTREAM_MANIFEST.archive.sha256);
  expect(provenance.patches.map((patch) => patch.file))
    .toEqual(UPSTREAM_MANIFEST.patches.map((patch) => patch.file));

  for (const patch of UPSTREAM_MANIFEST.patches) {
    /* The shipped patch is byte-identical to the one in the repository, so the
     * distributed provenance really describes what was built. */
    expect(sha256(readShippedPatch(patch.file))).toBe(
      sha256(readRepositoryPatch(patch.file)),
    );
    expect(provenance.patches.find((entry) => entry.file === patch.file)?.purpose)
      .toBe(patch.purpose);
  }
});

test('matches the recorded upstream baseline', async ({ page }) => {
  await installFakeSerial(page);
  await installTestHelpers(page);
  await page.goto(HARNESS_URL);

  const sample = await page.evaluate(async (): Promise<Sample> => {
    const hamlib = await window.__hamlibHarness.createHamlib();
    const port = await hamlib.requestPort();
    const ts480 = hamlib.models.find(
      (model) => model.manufacturer === 'Kenwood' && model.model === 'TS-480',
    );

    if (!ts480) {
      throw new Error('the TS-480 model is missing');
    }

    const version = hamlib.version;
    const catalogueCount = hamlib.models.length;
    /* One line per model, field order fixed by this list. */
    const catalogueText = hamlib.models.map((model) => [
      model.id,
      model.manufacturer,
      model.model,
      model.backendVersion,
      model.status,
      model.serialRateMin,
      model.serialRateMax,
      model.canGetFrequency ? 1 : 0,
      model.canSetFrequency ? 1 : 0,
      model.canGetMode ? 1 : 0,
      model.canSetMode ? 1 : 0,
      model.canGetPtt ? 1 : 0,
      model.canSetPtt ? 1 : 0,
    ].join('\t')).join('\n');

    const rig = await hamlib.open({ modelId: ts480.id, port });
    const frequency = await rig.getFrequency();
    const mode = await rig.getMode();
    await rig.setFrequency(7_074_000);
    await rig.setMode('CW', 500);
    await rig.setPtt('on');
    await rig.setPtt('off');

    const wire = [...window.__fakeSerial.commands];

    await rig.close();
    await hamlib.dispose();

    return {
      version,
      catalogueCount,
      catalogueText,
      frequency,
      mode,
      ts480: {
        id: ts480.id,
        manufacturer: ts480.manufacturer,
        model: ts480.model,
        backendVersion: ts480.backendVersion,
        status: ts480.status,
        serialRateMin: ts480.serialRateMin,
        serialRateMax: ts480.serialRateMax,
        canGetFrequency: ts480.canGetFrequency,
        canSetFrequency: ts480.canSetFrequency,
        canGetMode: ts480.canGetMode,
        canSetMode: ts480.canSetMode,
        canGetPtt: ts480.canGetPtt,
        canSetPtt: ts480.canSetPtt,
        wire,
      },
    };
  });

  /* The runtime version must agree with the release manifest, not with a
   * number baked into the test. */
  expect(sample.version).toContain(UPSTREAM_VERSION);

  /* Absolute facts, so a corrupted baseline cannot quietly pass. */
  expect(sample.catalogueCount).toBeGreaterThan(50);
  expect(sample.frequency).toBe(14_074_000);
  expect(sample.mode.mode).toBe('USB');

  const actual: Baseline = {
    catalogue: {
      count: sample.catalogueCount,
      sha256: createHash('sha256').update(sample.catalogueText).digest('hex'),
    },
    ts480: sample.ts480,
  };

  if (RECORD) {
    mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
    writeFileSync(BASELINE_PATH, `${JSON.stringify(actual, null, 2)}\n`);
  }

  const baseline: Baseline = RECORD
    ? actual
    : JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));

  expect(actual).toEqual(baseline);
});
