// SPDX-License-Identifier: MIT

/**
 * Build by-value projections of the C structs an operation uses.
 *
 * Hamlib passes structs by pointer, and those structs mix scalars, enums,
 * `char[N]` buffers, pointers, unions and unions-of-arrays.  A projection keeps
 * exactly the fields that can cross the Wasm boundary - a mapped scalar/enum, a
 * `char[N]` as a string - and records every dropped field with its reason, so
 * the generated view is a documented partial, never a guessed layout.
 *
 * Struct tags are reached through the typedef the signature actually names
 * (`channel_t` -> `struct channel`), because Hamlib typedefs anonymous structs
 * under a descriptive name.
 *
 * Authored as TypeScript and run directly by Node's type stripping, so this
 * file must stay erasable (no enums, namespaces or parameter properties).
 */
import type { AstIndex } from './ast.ts';
import { bindType, type ProjectionField, type ProjectionSpec, type TypeBinding } from './types.ts';

const CHAR_ARRAY = /^char\s*\[\s*(\d+)\s*\]$/;

/** `chan_list` -> `ChanList`; `confparams` -> `Confparams`. */
function pascalTag(tag: string): string {
  return tag
    .split('_')
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join('');
}

/** Resolve a C type name to a projection, or `null` when it is not a struct. */
export type ProjectionResolver = (typeName: string) => ProjectionSpec | null;

/** Per-tag public field renames, keyed by tag then by the C member name. */
export type ProjectionRenames = Readonly<Record<string, Readonly<Record<string, string>>>>;

export function createProjectionResolver(
  ast: AstIndex,
  renames: ProjectionRenames = {},
): ProjectionResolver {
  const cache = new Map<string, ProjectionSpec | null>();

  return (typeName: string): ProjectionSpec | null => {
    if (cache.has(typeName)) {
      return cache.get(typeName) ?? null;
    }

    const spec = build(ast, typeName, renames);
    cache.set(typeName, spec);
    return spec;
  };
}

function build(ast: AstIndex, typeName: string, renames: ProjectionRenames): ProjectionSpec | null {
  const type = typeName
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^const /, '')
    .replace(/^(struct|enum|union) /, '');

  if (type.endsWith('*')) {
    return null;
  }

  const typedef = ast.typedefs.get(type);
  const tag = typedef?.startsWith('struct ')
    ? typedef.slice('struct '.length).trim()
    : (ast.records.has(type) ? type : null);

  if (!tag) {
    return null;
  }

  const record = ast.records.get(tag);

  if (!record) {
    return null;
  }

  const fields: ProjectionField[] = [];
  const dropped: { name: string; reason: string }[] = [];
  const rename = renames[tag] ?? {};

  for (const field of record.fields) {
    const name = rename[field.name] ?? field.name;
    const charArray = CHAR_ARRAY.exec(field.qualType);

    if (charArray) {
      const stringBinding: TypeBinding = {
        category: 'string',
        boundary: 'string',
        ts: 'string',
        native: field.qualType,
      };

      fields.push({
        name,
        member: field.name,
        binding: stringBinding,
        charArray: Number(charArray[1]),
      });
      continue;
    }

    const binding = bindType(field.qualType);

    if (!binding) {
      dropped.push({ name: field.name, reason: `field type ${field.qualType} is not mappable` });
      continue;
    }

    fields.push({ name, member: field.name, binding, charArray: null });
  }

  return { type, tag, cpp: `Rig${pascalTag(tag)}`, fields, dropped };
}
