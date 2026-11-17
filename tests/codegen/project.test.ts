// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';

import { indexAst, type JsonNode } from '../../packages/hamlib-codegen/src/ast.ts';
import { createProjectionResolver } from '../../packages/hamlib-codegen/src/project.ts';

/** A clang JSON node for one named member of `record channel`. */
function record(name: string, fields: readonly (readonly [string, string])[], isDefinition = true): JsonNode {
  return {
    kind: 'RecordDecl',
    name,
    ...(isDefinition ? { completeDefinition: true } : {}),
    inner: fields.map(([field, qualType]) => ({
      kind: 'FieldDecl',
      name: field,
      type: { qualType },
    })),
  };
}

const channelFields: readonly (readonly [string, string])[] = [
  ['freq', 'freq_t'],
  ['tx_freq', 'freq_t'],
  ['label', 'char[16]'],
  ['opaque', 'struct opaque_blob *'],
];

describe('struct projections', () => {
  it('includes the declared mappable fields and records the dropped ones', () => {
    const ast = indexAst({
      kind: 'TranslationUnitDecl',
      inner: [
        { kind: 'TypedefDecl', name: 'channel_t', type: { qualType: 'struct channel' } },
        record('channel', channelFields),
      ],
    });
    const spec = createProjectionResolver(ast)('channel_t');

    expect(spec).not.toBeNull();
    expect(spec?.tag).toBe('channel');
    expect(spec?.cpp).toBe('RigChannel');
    expect(spec?.fields.map((field) => field.name)).toEqual(['freq', 'txFreq', 'label']);
    expect(spec?.fields[1]?.member).toBe('tx_freq');
    expect(spec?.fields[2]?.charArray).toBe(16);
    expect(spec?.dropped.map((field) => field.name)).toEqual(['opaque']);
  });

  it('uses the definition that follows a forward declaration', () => {
    const ast = indexAst({
      kind: 'TranslationUnitDecl',
      inner: [
        record('channel', [], false),
        { kind: 'TypedefDecl', name: 'channel_t', type: { qualType: 'struct channel' } },
        record('channel', channelFields),
      ],
    });
    const spec = createProjectionResolver(ast)('channel_t');

    expect(spec?.fields.map((field) => field.name)).toEqual(['freq', 'txFreq', 'label']);
  });

  it('keeps the definition when a forward declaration follows it', () => {
    const ast = indexAst({
      kind: 'TranslationUnitDecl',
      inner: [
        record('channel', channelFields),
        record('channel', [], false),
        { kind: 'TypedefDecl', name: 'channel_t', type: { qualType: 'struct channel' } },
      ],
    });
    const spec = createProjectionResolver(ast)('channel_t');

    expect(spec?.fields.map((field) => field.name)).toEqual(['freq', 'txFreq', 'label']);
  });
});
