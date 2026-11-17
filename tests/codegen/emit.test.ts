// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';

import type { AstFunction } from '../../packages/hamlib-codegen/src/ast.ts';
import { classifyFunction } from '../../packages/hamlib-codegen/src/classify.ts';
import { operationFacts } from '../../packages/hamlib-codegen/src/emit/common.ts';
import { emitOperations } from '../../packages/hamlib-codegen/src/emit/cpp.ts';

function declaration(
  name: string,
  params: readonly (readonly [string, string])[],
  result = 'int',
): AstFunction {
  return {
    name,
    result,
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
function emit(sources: readonly AstFunction[] = declarations): string {
  const facts = sources.map((fn) => {
    const classified = classifyFunction(fn, new Set<string>(), () => null);

    if ('reason' in classified) {
      throw new Error(`${fn.name} was refused: ${classified.reason}`);
    }

    return operationFacts(classified, new Set<string>());
  });

  return emitOperations(facts);
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

describe('emitOperations argument conversion', () => {
  it('refuses a name Hamlib does not know in a value-returning helper too', () => {
    const code = emit([
      declaration('rig_passband_normal', [['rig', 'RIG *'], ['mode', 'rmode_t']], 'pbwidth_t'),
    ]);

    expect(code).toContain('rmode_t value0 = rig_parse_mode(arg0.c_str());');
    expect(code).toContain('if (value0 == RIG_MODE_NONE) { return failure<NumberResult>(-RIG_EINVAL); }');
  });

  it('reports a helper through the same result value object as a getter', () => {
    const code = emit([declaration('rig_get_info', [['rig', 'RIG *']], 'const char *')]);

    expect(code).toContain('TextResult getInfo(int handle)');
    expect(code).toContain('result.value = textOrEmpty(returned);');
  });
});
