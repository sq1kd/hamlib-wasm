/**
 * Catalogue lookups for the Node and hardware tests, matched the way the
 * in-page `window.__testHelpers.catalogueModel` matches them in the browser:
 * by manufacturer and model, as `hamlib.models` reports both.
 */
import type { RigModel } from 'hamlib-wasm/raw';

/** The catalogue entry for `manufacturer` `model`, or a throw naming its siblings. */
export function catalogueModel(
  models: readonly RigModel[],
  manufacturer: string,
  model: string,
): RigModel {
  const found = models.find(
    (candidate) => candidate.manufacturer === manufacturer && candidate.model === model,
  );

  if (found) {
    return found;
  }

  const siblings = models
    .filter((candidate) => candidate.manufacturer === manufacturer)
    .map((candidate) => candidate.model);

  throw new Error(
    `${manufacturer} ${model} is not in the catalogue; `
    + `${manufacturer} entries: ${siblings.join(', ') || 'none'}`,
  );
}
