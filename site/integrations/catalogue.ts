/**
 * The model catalogue, read once at config time from the built package.
 *
 * The landing page renders its model picker and its facts as plain HTML, so
 * the catalogue has to exist before any Wasm reaches a browser.  Node loads
 * the same `hamlib-wasm` build the site ships and lists its models here; the
 * page then only fetches the Wasm when a reader connects a radio.
 */
import { createHamlib } from 'hamlib-wasm';

export interface CatalogueModel {
  readonly id: number;
  readonly manufacturer: string;
  readonly model: string;
  readonly limitation?: string;
  readonly rateMin: number;
  readonly rateMax: number;
}

export interface Catalogue {
  /** The upstream release, e.g. `4.7.2`. */
  readonly version: string;
  readonly models: readonly CatalogueModel[];
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
        rateMin: model.serialRateMin,
        rateMax: model.serialRateMax,
      })),
    };
  } finally {
    await hamlib.dispose();
  }
}
