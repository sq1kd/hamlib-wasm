// SPDX-License-Identifier: MIT

/**
 * What the browser build has actually been exercised against.
 *
 * Hamlib reports ~280 serial models, and `RIG_PORT_SERIAL` only says that a
 * backend talks through the common port layer.  It does not say that the model
 * has ever run against Web Serial.  This module keeps that distinction
 * explicit and testable:
 *
 *   - {@link VERIFIED_MODELS} lists the models a committed browser test drives
 *     through the real Web Serial double.  It means "covered here", never
 *     "tried against hardware".
 *   - {@link describeLineSettingsLimitation} names the line settings a backend
 *     declares that Web Serial cannot express, so a model that would fail at
 *     open says so up front.
 *   - {@link UNUSABLE_MODELS} records the models that cannot work in this build
 *     for a reason the capabilities do not reveal, such as needing a worker
 *     thread.
 *
 * Everything else stays a `candidate`: worth trying, not promised.
 */

/** How far a rig model has been exercised in a browser. */
export type BrowserSupport = 'verified' | 'candidate';

/** A model with a committed, emulator-backed browser test. */
export interface VerifiedModel {
  manufacturer: string;
  model: string;
  /** Where the behaviour is asserted. */
  evidence: readonly string[];
}

/** A model the browser build cannot drive, and why. */
export interface UnusableModel {
  manufacturer: string;
  model: string;
  /** One sentence a user can act on. */
  reason: string;
}

/** Models covered by a browser test in this repository. */
export const VERIFIED_MODELS: readonly VerifiedModel[] = [
  {
    manufacturer: 'Kenwood',
    model: 'TS-480',
    evidence: [
      'tests/browser/transport.spec.ts: open, status, frequency, mode, PTT, close',
      'tests/browser/e2e/react.spec.ts: the React example page, end to end, on both backends',
      'tests/browser/baseline.spec.ts: the recorded CAT command sequence',
    ],
  },
  {
    manufacturer: 'Icom',
    model: 'IC-703',
    evidence: [
      'tests/browser/protocols.spec.ts: binary CI-V frames, ACK/NAK, frequency and mode',
    ],
  },
  {
    manufacturer: 'Yaesu',
    model: 'FT-710',
    evidence: [
      'tests/browser/baud-rate.spec.ts: the recorded newcat protocol, the rate the rig answers at, and the search that finds it',
    ],
  },
];

/**
 * Models whose backend cannot run here for a reason the capabilities do not
 * show.  A model that merely declares unwritable line settings does not belong
 * here; {@link describeLineSettingsLimitation} derives those.
 */
export const UNUSABLE_MODELS: readonly UnusableModel[] = [
  {
    manufacturer: 'AnyTone',
    model: 'D578A',
    reason:
      'its backend starts a keep-alive worker thread, and this build has no '
      + 'threads, so opening it fails instead of half working',
  },
  {
    manufacturer: 'Yaesu',
    model: 'FT-757GXII',
    reason:
      'its backend cannot open: it reads a 75 octet status block through a '
      + 'helper whose retry count Hamlib has already zeroed, so it gives up '
      + 'before writing anything - and it is the only serial model in this '
      + 'release that drives push-to-talk over the DTR line',
  },
];

/** Line settings a backend declares, as reported by {@link RigModel}. */
export interface DeclaredLineSettings {
  serialDataBits: number;
  serialStopBits: number;
  serialParity: string;
  serialHandshake: string;
}

/**
 * Why the serial transport cannot express a model's declared line settings, if
 * it cannot.
 *
 * The transport refuses these configurations before it touches the port
 * (`native/web_serial.c`, `ws_validate_config`), so this only says the same
 * thing earlier and in words.  This build accepts one set of line settings for
 * every transport, so the answer holds whichever one acquired the port.  Keep
 * the two in step.
 */
export function describeLineSettingsLimitation(
  settings: DeclaredLineSettings,
): string | undefined {
  if (settings.serialDataBits !== 7 && settings.serialDataBits !== 8) {
    return `${settings.serialDataBits} data bits are not available over the serial transport`;
  }

  if (settings.serialStopBits !== 1 && settings.serialStopBits !== 2) {
    return `${settings.serialStopBits} stop bits are not available over the serial transport`;
  }

  if (!['none', 'odd', 'even'].includes(settings.serialParity)) {
    return `${settings.serialParity} parity is not available over the serial transport`;
  }

  if (!['none', 'hardware'].includes(settings.serialHandshake)) {
    return `${settings.serialHandshake} flow control is not available over the serial transport`;
  }

  return undefined;
}

/** Look up the test evidence for a model, if any. */
export function findVerifiedModel(
  manufacturer: string,
  model: string,
): VerifiedModel | undefined {
  return VERIFIED_MODELS.find(
    (entry) => entry.manufacturer === manufacturer && entry.model === model,
  );
}

/** Look up a recorded reason the model cannot work here, if any. */
export function findUnusableModel(
  manufacturer: string,
  model: string,
): UnusableModel | undefined {
  return UNUSABLE_MODELS.find(
    (entry) => entry.manufacturer === manufacturer && entry.model === model,
  );
}
