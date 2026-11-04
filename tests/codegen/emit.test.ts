// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';

import type { AstFunction } from '../../packages/hamlib-codegen/src/ast.ts';
import { classifyFunction } from '../../packages/hamlib-codegen/src/classify.ts';
import { emitOperations } from '../../packages/hamlib-codegen/src/emit.ts';

function declaration(
  name: string,
  params: readonly (readonly [string, string])[],
): AstFunction {
  return {
    name,
    result: 'int',
    params: params.map(([param, qualType]) => ({ name: param, qualType })),
    variadic: false,
  };
}

const declarations: readonly AstFunction[] = [
  declaration('rig_get_freq', [
    ['rig', 'RIG *'],
    ['vfo', 'vfo_t'],
    ['freq', 'freq_t *'],
  ]),
  declaration('rig_set_freq', [
    ['rig', 'RIG *'],
    ['vfo', 'vfo_t'],
    ['freq', 'freq_t'],
  ]),
  declaration('rig_get_marker', [
    ['rig', 'RIG *'],
    ['marker', 'int *'],
  ]),
];

/** Emit the synthetic declarations, failing loudly if one is refused. */
function emit(): string {
  const operations = declarations.map((fn) => {
    const classified = classifyFunction(fn, new Set<string>(), () => null);

    if ('reason' in classified) {
      throw new Error(`${fn.name} was refused: ${classified.reason}`);
    }

    return classified;
  });

  return emitOperations(operations);
}

describe('emitOperations method names', () => {
  it('emits the same names and bodies on every run', () => {
    expect(emit()).toBe(emit());
  });

  it('keeps the generated method names in input order', () => {
    const methods = [...emit().matchAll(/^ {4}\S+ (\w+)\(/gm)].map((match) => match[1]);

    expect(methods).toEqual(['getFreq', 'setFreq', 'getMarker']);
  });
});
