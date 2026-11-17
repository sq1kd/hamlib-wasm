/**
 * The model catalogue, read once at config time from the built package.
 *
 * The landing page renders its model picker and its facts as plain HTML, so
 * the catalogue has to exist before any Wasm reaches a browser.  Node loads
 * the same `hamlib-wasm` build the site ships and lists its models here; the
 * page then only fetches the Wasm when a reader connects a radio.  The
 * release and its patches come from the provenance record the package ships.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { baudRateCandidates, createHamlib } from 'hamlib-wasm';

import type { CatalogueModel } from '../src/radio/models';

export interface Catalogue {
  /** The upstream release, e.g. `X.Y.Z`. */
  readonly version: string;
  /** The patches applied to it, by file name; the package ships each beside SOURCE.json. */
  readonly patches: readonly string[];
  /** Only what the panel needs of each model, to keep the page small. */
  readonly models: readonly CatalogueModel[];
}

interface Source {
  readonly version: string;
  readonly patches: readonly { readonly file: string }[];
}

export async function readCatalogue(): Promise<Catalogue> {
  const sourceUrl = new URL(import.meta.resolve('hamlib-wasm/third_party/hamlib/SOURCE.json'));
  const source = JSON.parse(readFileSync(fileURLToPath(sourceUrl), 'utf8')) as Source;
  const hamlib = await createHamlib();

  try {
    return {
      version: source.version,
      patches: source.patches.map((patch) => patch.file),
      models: hamlib.models.map((model) => ({
        id: model.id,
        manufacturer: model.manufacturer,
        model: model.model,
        ...(model.limitation === undefined ? {} : { limitation: model.limitation }),
        rates: baudRateCandidates(model),
      })),
    };
  } finally {
    await hamlib.dispose();
  }
}
