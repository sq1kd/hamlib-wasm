// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';

import type { AstFunction } from '../../packages/hamlib-codegen/src/ast.ts';
import {
  canonicalDeclaration,
  classifyAll,
  classifyFunction,
  type GeneratedOperation,
} from '../../packages/hamlib-codegen/src/classify.ts';

/** A declaration in the shape `classifyFunction` consumes. */
function declaration(
  name: string,
  params: readonly string[],
  result = 'int',
  variadic = false,
): AstFunction {
  return {
    name,
    result,
    params: params.map((qualType, index) => ({ name: `p${index}`, qualType })),
    variadic,
  };
}

const manualSymbols = new Set<string>();
function classify(
  name: string,
  params: readonly string[],
  result = 'int',
): GeneratedOperation | { readonly symbol: string; readonly reason: string } {
  return classifyFunction(declaration(name, params, result), manualSymbols, () => null);
}

function operation(
  name: string,
  params: readonly string[],
  result = 'int',
): GeneratedOperation {
  const classified = classify(name, params, result);

  if ('reason' in classified) {
    throw new Error(`${name} was refused: ${classified.reason}`);
  }

  return classified;
}

function rejectionReason(name: string): string {
  const classified = classify(name, ['RIG *']);

  if (!('reason' in classified)) {
    throw new Error(`${name} was classified instead of refused`);
  }

  return classified.reason;
}

describe('canonicalDeclaration', () => {
  it('picks the declaration with the fewest parameters', () => {
    const wide = declaration('rig_scan', ['RIG *', 'scan_t', 'int']);
    const narrow = declaration('rig_scan', ['RIG *', 'scan_t']);

    expect(canonicalDeclaration([wide, narrow])).toBe(narrow);
  });

  it('prefers the non-variadic declaration at equal arity', () => {
    const variadic = declaration('rig_scan', ['RIG *', 'scan_t'], 'int', true);
    const fixed = declaration('rig_scan', ['RIG *', 'scan_t'], 'int', false);

    expect(canonicalDeclaration([variadic, fixed])).toBe(fixed);
  });

  it('lets the parameter count outrank variadicness', () => {
    const fixed = declaration('rig_scan', ['RIG *', 'scan_t']);
    const variadic = declaration('rig_scan', ['RIG *'], 'int', true);

    expect(canonicalDeclaration([fixed, variadic])).toBe(variadic);
  });
});

describe('classifyFunction pointer direction', () => {
  it('treats a const pointer parameter as an input', () => {
    const classified = operation('rig_set_marker', ['RIG *', 'const int *']);

    expect(classified.shape).toBe('set');
    expect(classified.arguments).toHaveLength(1);
    expect(classified.outputs).toHaveLength(0);
    expect(classified.plan).toEqual([
      { kind: 'rig' },
      { kind: 'value', argument: 0 },
    ]);
  });

  it('treats a non-const pointer parameter as an output', () => {
    const classified = operation('rig_get_marker', ['RIG *', 'int *']);

    expect(classified.shape).toBe('get');
    expect(classified.arguments).toHaveLength(0);
    expect(classified.outputs.map((output) => output.field)).toEqual(['p1']);
    expect(classified.plan).toEqual([{ kind: 'rig' }, { kind: 'out' }]);
  });
});

describe('classifyFunction exclusions', () => {
  it('refuses an EXCLUDED_EXACT symbol with its reason', () => {
    expect(rejectionReason('rig_password'))
      .toBe('excluded: machine-local, raw-bus or credential surface');
  });

  it('refuses the Morse queue calls, which need the worker thread', () => {
    expect(rejectionReason('rig_send_morse'))
      .toBe('excluded: queued for the Morse worker thread this build does not start');
  });

  it('refuses a symbol matching EXCLUDED_PATTERNS', () => {
    expect(rejectionReason('rig_get_conf')).toBe(
      'excluded by policy (threads, transport or unsafe surface)',
    );
  });

  it('refuses a NOT_IN_REFERENCE_SURFACE symbol', () => {
    expect(rejectionReason('rig_get_resolution')).toBe(
      'excluded: not called by the upstream rigctl reference client',
    );
  });
});

describe('classifyAll overrides', () => {
  const functions = new Map([
    ['rig_set_split_freq', [declaration('rig_set_split_freq', ['RIG *', 'vfo_t', 'freq_t'])]],
    ['rig_license', [declaration('rig_license', [], 'const char *')]],
  ]);

  function stale(overrides: Parameters<typeof classifyAll>[3]): readonly string[] {
    return classifyAll(functions, manualSymbols, () => null, overrides).staleOverrides;
  }

  it('names fields in camelCase without an override', () => {
    const [operation] = classifyAll(new Map([[
      'rig_set_split_freq',
      [{ name: 'rig_set_split_freq', result: 'int', variadic: false, params: [
        { name: 'rig', qualType: 'RIG *' },
        { name: 'vfo', qualType: 'vfo_t' },
        { name: 'tx_freq', qualType: 'freq_t' },
      ] }],
    ]]), manualSymbols, () => null).operations;

    expect(operation?.arguments.map((argument) => argument.field)).toEqual(['txFreq']);
  });

  it('accepts an override that renames a generated method', () => {
    expect(stale({ rig_set_split_freq: { method: 'setTxFrequency' } })).toEqual([]);
  });

  it('reports an override for a symbol that is not generated', () => {
    expect(stale({ rig_license: { method: 'license' } })).toEqual([
      'rig_license: not generated (excluded: not called by the upstream rigctl reference client)',
    ]);
  });

  it('reports an override that renames nothing', () => {
    expect(stale({ rig_set_split_freq: { method: 'setSplitFreq' } })).toHaveLength(1);
    expect(stale({ rig_set_split_freq: { fields: { tx_freq: 'txFreq' } } })).toHaveLength(1);
  });
});
