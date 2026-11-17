/**
 * TypeDoc plugin: name each documented module after its import specifier.
 *
 * TypeDoc names a module after its source file (`index`, `raw`, ...), but a
 * reader imports `hamlib-wasm`, `hamlib-wasm/raw` and so on, which is what
 * the reference should say.
 */
import { Converter, ReflectionKind } from 'typedoc';
import type { Application } from 'typedoc';

import { ENTRIES } from './entries.ts';

const NAMES: ReadonlyMap<string, string> = new Map(ENTRIES.map((entry) => [entry.module, entry.specifier]));

export function load(app: Application): void {
  app.converter.on(Converter.EVENT_RESOLVE_BEGIN, (context) => {
    for (const module of context.project.getChildrenByKind(ReflectionKind.Module)) {
      module.name = NAMES.get(module.name) ?? module.name;
    }
  });
}
