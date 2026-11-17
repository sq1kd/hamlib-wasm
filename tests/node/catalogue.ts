/**
 * Catalogue lookups for the Node and hardware tests.
 *
 * tests/browser/fixtures/helpers.ts is the one lookup the repository has: the
 * browser specs call it in the page as `window.__testHelpers.catalogueModel`,
 * and this wraps the same function.  The hardware suite has no setup file, so
 * the `window` alias is installed here before the helpers publish on it.
 */
import './setup.ts';
import '../browser/fixtures/helpers.ts';

import type { RigModel } from 'hamlib-wasm/raw';

/** The catalogue entry for `manufacturer` `model`, or a throw naming its siblings. */
export function catalogueModel(models: readonly RigModel[], manufacturer: string, model: string): RigModel {
  return window.__testHelpers.catalogueModel(models, manufacturer, model);
}
