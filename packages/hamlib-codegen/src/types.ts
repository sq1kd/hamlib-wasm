// SPDX-License-Identifier: MIT

/**
 * The single C-to-TypeScript/C++ type mapping.
 *
 * This is the only place that decides how a Hamlib C type crosses into
 * Wasm and TypeScript.  It is deliberately total and fail-closed: a type that
 * is not listed here is *unsupported*, and any operation that would need it is
 * refused during generation rather than bound with a guess.  That is what lets
 * the generator be trusted: the compiler's AST supplies the exact C type, and
 * this table decides, by name, whether the generator knows how to move it.
 *
 * Name-typed enums are described in enums.ts: their names cross through the
 * upstream `rig_parse_*`/`rig_str*` pair, or through the pair the generator
 * emits from the enum's own constants.  Enums with neither cross as their
 * underlying integer, which is lossless and mechanical.
 *
 * Authored as TypeScript and run directly by Node's type stripping, so this
 * file must stay erasable (no enums, namespaces or parameter properties).
 */

import { codecOf, enumRecordFor, type SettingNamespace } from './enums.ts';

export type { SettingNamespace } from './enums.ts';

/** How a mapped value is represented on the Embind boundary. */
export type BoundaryType = 'int' | 'double' | 'bool' | 'string';

/** The coarse handling category, which drives the emitted conversion code. */
export type TypeCategory = 'number' | 'boolean' | 'string' | 'enum' | 'struct';

export interface TypeBinding {
  readonly category: TypeCategory;
  /** C++ type used for the value object field or the Embind argument. */
  readonly boundary: BoundaryType;
  /** The TypeScript type the caller sees. */
  readonly ts: string;
  /** Native C type used for the local that talks to Hamlib. */
  readonly native: string;
  /** Upstream stringifier, for `enum` bindings. */
  readonly enumStr?: string;
  /** Upstream parser, for `enum` bindings. */
  readonly enumParse?: string;
  /** Parser sentinel that means "not a valid name". */
  readonly enumNone?: string;
  /**
   * For an `enum` binding whose stringifier answers `NULL` for a value it has
   * no name for (a generated codec): every name it returns is in the union, so
   * an unnamed value is a failure rather than a name outside the type.
   */
  readonly strictNames?: boolean;
  /**
   * For a `value_t` binding, the macro that says whether the value is stored
   * as a float (`.f`) or an integer (`.i`) for this setting namespace.
   */
  readonly valuePredicate?: string;
  /**
   * For a `value_t` binding with no name-space predicate, the union member to
   * read or write unconditionally.  `rig_get_ant`/`rig_set_ant` store their
   * option in `.i` (Hamlib's own `rigctl` makes the same assumption), so no
   * runtime type is needed.
   */
  readonly valueAccess?: 'i' | 'f';
  /** For a `struct` binding, the generated projection this value crosses as. */
  readonly projection?: ProjectionSpec;
  /**
   * For a `boolean` binding over a C type that is not `bool`: the constants
   * `true` and `false` stand for.  An input becomes `value ? on : off`, an
   * output `value != off`, so no enum value is assumed to be 0 or 1.
   */
  readonly flag?: { readonly on: string; readonly off: string };
}

/** A two-state C value that the public surface types as `boolean`. */
export function flagBinding(native: string, on: string, off: string): TypeBinding {
  return { category: 'boolean', boundary: 'bool', ts: 'boolean', native, flag: { on, off } };
}

/** Two-member OFF/ON enums: their name is the only thing that is not a boolean. */
const FLAG_ENUMS: Readonly<Record<string, { readonly on: string; readonly off: string }>> = {
  split_t: { on: 'RIG_SPLIT_ON', off: 'RIG_SPLIT_OFF' },
  dcd_t: { on: 'RIG_DCD_ON', off: 'RIG_DCD_OFF' },
};

/** One field of a projected C struct. */
export interface ProjectionField {
  /** The public field name, which a naming override may change. */
  readonly name: string;
  /** The C struct member read or written, never renamed. */
  readonly member: string;
  readonly binding: TypeBinding;
  /** Length of a `char[N]` field, which crosses as a string. */
  readonly charArray: number | null;
}

/**
 * A by-value projection of a C struct.
 *
 * Hamlib passes structs by pointer and they contain pointers, unions and
 * function pointers that cannot cross the Wasm boundary.  A projection keeps
 * only the fields that do cross, and records why the rest were dropped, so the
 * result is an honest partial view rather than a guessed layout.
 */
export interface ProjectionSpec {
  /** The C type name as written in the signature, e.g. `channel_t`. */
  readonly type: string;
  /** The record tag, e.g. `channel`. */
  readonly tag: string;
  /** The generated C++/Embind name, e.g. `RigChannel`. */
  readonly cpp: string;
  readonly fields: readonly ProjectionField[];
  readonly dropped: readonly { readonly name: string; readonly reason: string }[];
}

/** How a `value_t` is stored for each namespace; `func` carries no value. */
const VALUE_PREDICATES: Readonly<Record<SettingNamespace, string | null>> = {
  level: 'RIG_LEVEL_IS_FLOAT',
  parm: 'RIG_PARM_IS_FLOAT',
  func: null,
};

/**
 * The setting namespace of an operation, from its symbol suffix.
 *
 * `setting_t` is one C type used for three separate name spaces (levels,
 * functions, parameters), so which parser and sentinel apply depends on the
 * function, not on the type alone.
 */
export function settingNamespaceFor(symbol: string): SettingNamespace | null {
  if (symbol.endsWith('_level')) {
    return 'level';
  }

  if (symbol.endsWith('_func')) {
    return 'func';
  }

  if (symbol.endsWith('_parm')) {
    return 'parm';
  }

  return null;
}

/** A `setting_t` parameter, its name vocabulary chosen by namespace. */
export function settingBinding(namespace: SettingNamespace): TypeBinding {
  return enumBinding('setting_t', 'setting_t', namespace) as TypeBinding;
}

/**
 * A `value_t` binding, or `null` when the namespace has no float predicate
 * (only levels and parameters carry a value; extended tokens are
 * backend-defined and stay refused).
 */
export function valueBinding(namespace: SettingNamespace): TypeBinding | null {
  const predicate = VALUE_PREDICATES[namespace];

  if (!predicate) {
    return null;
  }

  return {
    category: 'number',
    boundary: 'double',
    ts: 'number',
    native: 'value_t',
    valuePredicate: predicate,
  };
}

/** Integer and floating types that cross losslessly as a JS `number`. */
const NUMBER_NATIVE: ReadonlySet<string> = new Set([
  'int',
  'unsigned int',
  'short',
  'unsigned short',
  'long',
  'unsigned long',
  'long long',
  'unsigned long long',
  'int8_t',
  'uint8_t',
  'int16_t',
  'uint16_t',
  'int32_t',
  'uint32_t',
  'int64_t',
  'uint64_t',
  'size_t',
  'float',
  'double',
  'freq_t',
  'pbwidth_t',
  'shortfreq_t',
  'tone_t',
  'ant_t',
  /* Mask and scalar-only types with no name vocabulary: they cross losslessly
   * as their underlying number.  (`setting_t` as a *value* is a bit mask; as a
   * parameter it is resolved per name space before this table is consulted.) */
  'setting_t',
  'rig_model_t',
  'agc_level_e',
  /* Opaque backend token (`typedef long`) and enums with no name vocabulary of
   * their own: they cross losslessly as their underlying number, which is what
   * the `rig_str*`/`rig_parse_*` codec and the `rig_ext_*` lookups need. */
  'hamlib_token_t',
  'chan_type_t',
  'rig_status_e',
  'rig_comm_status_t',
  'rig_spectrum_mode_e',
  'rig_conf_e',
]);

/** The binding of an enum whose names cross into C, or `null` when it has no codec. */
function enumBinding(enumName: string, native: string, namespace?: SettingNamespace): TypeBinding | null {
  const record = enumRecordFor(enumName, namespace);
  const codec = record === undefined ? null : codecOf(record);

  if (!record?.names || codec === null) {
    return null;
  }

  return {
    category: 'enum',
    boundary: 'string',
    native,
    ts: record.names.type,
    enumStr: codec.str,
    enumParse: codec.parse,
    enumNone: codec.none,
    strictNames: record.codec === 'generated',
  };
}

/** A clang type spelling with its whitespace collapsed. */
export function normalizeType(qualType: string): string {
  return qualType.replace(/\s+/g, ' ').trim();
}

/** Strip the `enum `/`struct `/`union ` tag and a leading `const`. */
export function bareType(qualType: string): string {
  return normalizeType(qualType)
    .replace(/^const /, '')
    .replace(/^(?:enum|struct|union) /, '')
    .trim();
}

/** The pointee of a single-level pointer, or `null` when it is not one. */
export function pointeeType(qualType: string): string | null {
  const type = normalizeType(qualType);

  if (!type.endsWith('*') || type.endsWith('**')) {
    return null;
  }

  return type.slice(0, -1).replace(/^const /, '').trim();
}

/**
 * Map one C type to its binding, or `null` when the generator does not know
 * how to move it.  A `null` is a hard refusal at the operation level.
 */
export function bindType(qualType: string): TypeBinding | null {
  const normalized = normalizeType(qualType);
  const bare = bareType(qualType);

  if (bare === 'bool' || bare === '_Bool') {
    return { category: 'boolean', boundary: 'bool', ts: 'boolean', native: normalized };
  }

  if (normalized === 'const char *' || normalized === 'char *') {
    return { category: 'string', boundary: 'string', ts: 'string', native: 'const char *' };
  }

  const named = enumBinding(bare, normalized);

  if (named) {
    return named;
  }

  const flagEnum = FLAG_ENUMS[bare];

  if (flagEnum) {
    return flagBinding(normalized, flagEnum.on, flagEnum.off);
  }

  if (NUMBER_NATIVE.has(bare)) {
    return { category: 'number', boundary: 'double', ts: 'number', native: normalized };
  }

  return null;
}
