/**
 * The model catalogue, read once at config time from the built package.
 *
 * The landing page renders its model picker and its facts as plain HTML, so
 * the catalogue has to exist before any Wasm reaches a browser.  Node loads
 * the same `hamlib-wasm` build the site ships and lists its models here; the
 * page then only fetches the Wasm when a reader connects a radio.
 */
import { createHamlib } from 'hamlib-wasm';

import type { PanelModel } from '../src/radio/models';

export interface Catalogue {
  /** The upstream release, e.g. `X.Y.Z`. */
  readonly version: string;
  /** Only what the panel needs of each model, to keep the page small. */
  readonly models: readonly PanelModel[];
}

export async function readCatalogue(): Promise<Catalogue> {
  const hamlib = await createHamlib();

  try {
    return {
      version: /\d+\.\d+(?:\.\d+)?/.exec(hamlib.version)?.[0] ?? hamlib.version,
      models: hamlib.models.map((model) => ({
        id: model.id,
        manufacturer: model.manufacturer,
        model: model.model,
        ...(model.limitation === undefined ? {} : { limitation: model.limitation }),
        serialRateMin: model.serialRateMin,
        serialRateMax: model.serialRateMax,
      })),
    };
  } finally {
    await hamlib.dispose();
  }
}
