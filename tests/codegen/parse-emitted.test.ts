// SPDX-License-Identifier: MIT
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parseEmitted } from '../../packages/hamlib-codegen/src/cli.ts';

const fixture = readFileSync(
  fileURLToPath(new URL('./fixtures/embind-module.d.mts', import.meta.url)),
  'utf8',
);

/** Flatten a parse result so two declarations can be compared exactly. */
function snapshot(declaration: string): string {
  return [...parseEmitted(declaration)]
    .map(([name, operation]) => `${name}(${operation.arity}): ${operation.returnType}`)
    .join('\n');
}

/** Wrap every method signature onto several lines, as a formatter might. */
function wrapSignatures(declaration: string): string {
  return declaration.replace(
    /^ {2}(\w+)\((.*)\): (.+);$/gm,
    (_line: string, name: string, parameters: string, result: string) => {
      const body = parameters.trim() === ''
        ? ''
        : `\n    ${parameters.split(',').map((parameter) => parameter.trim()).join(',\n    ')}\n  `;

      return `  ${name}(${body}): ${result};`;
    },
  );
}

describe('parseEmitted', () => {
  it('collects the module methods with their arity and return type', () => {
    const operations = parseEmitted(fixture);

    expect([...operations.keys()]).toEqual([
      'listModels',
      'capabilities',
      'lookupMemCaps',
      'settingToIdx',
      'idxToSetting',
      'initialize',
      'closeRig',
      'setFrequency',
    ]);
    expect(operations.get('listModels')).toEqual({ arity: 0, returnType: 'RigModelList' });
    expect(operations.get('capabilities')).toEqual({ arity: 1, returnType: 'StringList' });
    expect(operations.get('lookupMemCaps')).toEqual({ arity: 2, returnType: 'RigChanList' });
    expect(operations.get('setFrequency')).toEqual({ arity: 2, returnType: 'CodeResult' });
  });

  it('ignores non-method members such as constructor properties', () => {
    expect(parseEmitted(fixture).has('RigModelList')).toBe(false);
  });

  it('is unchanged by indentation, line wrapping and blank lines', () => {
    const reformatted = wrapSignatures(fixture).replace(/\n/g, '\n\n');

    expect(reformatted).not.toBe(fixture);
    expect(snapshot(reformatted)).toBe(snapshot(fixture));
  });

  it('reports a changed parameter count', () => {
    const changed = fixture.replace(
      'lookupMemCaps(_0: number, _1: number): RigChanList;',
      'lookupMemCaps(_0: number, _1: number, _2: number): RigChanList;',
    );

    expect(changed).not.toBe(fixture);
    expect(parseEmitted(changed).get('lookupMemCaps')?.arity).toBe(3);
    expect(snapshot(changed)).not.toBe(snapshot(fixture));
  });

  it('reports a changed return type', () => {
    const changed = fixture.replace('initialize(): CodeResult;', 'initialize(): number;');

    expect(changed).not.toBe(fixture);
    expect(parseEmitted(changed).get('initialize')).toEqual({ arity: 0, returnType: 'number' });
    expect(snapshot(changed)).not.toBe(snapshot(fixture));
  });
});
