// SPDX-License-Identifier: MIT

/**
 * Every Hamlib enum the generated surface speaks by name, one record each.
 *
 * A record says where the enum's names come from, how a name crosses into C
 * (an upstream `rig_str*`/`rig_parse_*` pair, or a pair the generator emits
 * itself), and what the TypeScript side calls the names.  The type table
 * (types.ts), the vocabulary loader (names.ts) and every emitter read the same
 * record, so an enum is described once.
 *
 * Authored as TypeScript and run directly by Node's type stripping, so this
 * file must stay erasable (no enums, namespaces or parameter properties).
 */

/** The `setting_t` namespaces, distinguished by the operation symbol. */
export type SettingNamespace = 'level' | 'func' | 'parm';

/** An upstream parser/stringifier pair and the parser's "no such name" sentinel. */
export interface UpstreamCodec {
  readonly str: string;
  readonly parse: string;
  readonly none: string;
}

/**
 * Where the names come from:
 *
 *  - `table`: a `{ value, "name" }` table in Hamlib's `src/misc.c`, the
 *    vocabulary its upstream codec translates through;
 *  - `stringifier`: the `return "<name>";` statements of a switch stringifier
 *    in `src/misc.c`;
 *  - `constants`: the enum's own constants, as clang reports them.  The prefix
 *    is dropped and the rest is lower-cased with `_` as `-` (`RIG_PTT_ON_MIC` is
 *    `'on-mic'`), or kept as written for an `upper` record (`RIG_ECONF` is
 *    `ECONF`).  `rename` replaces a derived name, `exclude` drops a sentinel.
 */
export type NameSource =
  | { readonly table: string }
  | { readonly stringifier: string }
  | {
    readonly prefix: string;
    readonly upper?: boolean;
    readonly rename?: Readonly<Record<string, string>>;
    readonly exclude?: readonly string[];
  };

export interface EnumRecord {
  /** The C type a signature names, e.g. `vfo_t`; `setting_t` is split by namespace. */
  readonly enumName: string;
  readonly namespace?: SettingNamespace;
  /** The exported string-literal union, e.g. `RigMode`, and its `as const` array. */
  readonly names?: { readonly type: string; readonly constant: string };
  /** An exported `{ name: value }` map of the constants, and the union of its values. */
  readonly values?: { readonly type: string; readonly constant: string };
  readonly source: NameSource;
  /**
   * How a name crosses into C: an upstream pair, `'generated'` for the
   * `parse<Type>`/`str<Type>` pair the generator emits into `codecs.h`, or
   * `null` when only TypeScript uses the names.
   */
  readonly codec: UpstreamCodec | 'generated' | null;
}

export const ENUMS: readonly EnumRecord[] = [
  {
    enumName: 'rmode_t',
    names: { type: 'RigMode', constant: 'RIG_MODES' },
    source: { table: 'mode_str' },
    codec: { str: 'rig_strrmode', parse: 'rig_parse_mode', none: 'RIG_MODE_NONE' },
  },
  {
    enumName: 'vfo_t',
    names: { type: 'Vfo', constant: 'VFOS' },
    source: { table: 'vfo_str' },
    codec: { str: 'rig_strvfo', parse: 'rig_parse_vfo', none: 'RIG_VFO_NONE' },
  },
  {
    enumName: 'setting_t',
    namespace: 'level',
    names: { type: 'Level', constant: 'LEVELS' },
    source: { table: 'rig_level_str' },
    codec: { str: 'rig_strlevel', parse: 'rig_parse_level', none: 'RIG_LEVEL_NONE' },
  },
  {
    enumName: 'setting_t',
    namespace: 'func',
    names: { type: 'Func', constant: 'FUNCS' },
    source: { table: 'rig_func_str' },
    codec: { str: 'rig_strfunc', parse: 'rig_parse_func', none: 'RIG_FUNC_NONE' },
  },
  {
    enumName: 'setting_t',
    namespace: 'parm',
    names: { type: 'Parm', constant: 'PARMS' },
    source: { table: 'rig_parm_str' },
    codec: { str: 'rig_strparm', parse: 'rig_parse_parm', none: 'RIG_PARM_NONE' },
  },
  {
    enumName: 'vfo_op_t',
    names: { type: 'VfoOp', constant: 'VFO_OPS' },
    source: { table: 'vfo_op_str' },
    codec: { str: 'rig_strvfop', parse: 'rig_parse_vfo_op', none: 'RIG_OP_NONE' },
  },
  {
    enumName: 'scan_t',
    names: { type: 'ScanOp', constant: 'SCAN_OPS' },
    source: { table: 'scan_str' },
    codec: { str: 'rig_strscan', parse: 'rig_parse_scan', none: 'RIG_SCAN_NONE' },
  },
  {
    enumName: 'rptr_shift_t',
    names: { type: 'RptrShift', constant: 'RPTR_SHIFTS' },
    source: { stringifier: 'const char *HAMLIB_API rig_strptrshift' },
    codec: { str: 'rig_strptrshift', parse: 'rig_parse_rptr_shift', none: 'RIG_RPT_SHIFT_NONE' },
  },
  {
    enumName: 'powerstat_t',
    names: { type: 'PowerStatus', constant: 'POWER_STATUSES' },
    source: { prefix: 'RIG_POWER_' },
    codec: 'generated',
  },
  {
    enumName: 'reset_t',
    names: { type: 'ResetKind', constant: 'RESET_KINDS' },
    source: { prefix: 'RIG_RESET_' },
    codec: 'generated',
  },
  {
    enumName: 'ptt_t',
    names: { type: 'PttState', constant: 'PTT_STATES' },
    source: { prefix: 'RIG_PTT_' },
    codec: 'generated',
  },
  {
    enumName: 'serial_parity_e',
    names: { type: 'SerialParity', constant: 'SERIAL_PARITIES' },
    source: { prefix: 'RIG_PARITY_' },
    codec: 'generated',
  },
  {
    enumName: 'serial_handshake_e',
    names: { type: 'SerialHandshake', constant: 'SERIAL_HANDSHAKES' },
    source: { prefix: 'RIG_HANDSHAKE_', rename: { RIG_HANDSHAKE_XONXOFF: 'xon-xoff' } },
    codec: 'generated',
  },
  {
    enumName: 'rig_debug_level_e',
    names: { type: 'DebugLevel', constant: 'DEBUG_LEVELS' },
    values: { type: 'DebugLevelValue', constant: 'DEBUG_LEVEL_VALUES' },
    source: { prefix: 'RIG_DEBUG_' },
    codec: null,
  },
  {
    enumName: 'rig_errcode_e',
    values: { type: 'RigErrcode', constant: 'RIG_ERRCODES' },
    source: { prefix: 'RIG_', upper: true, exclude: ['RIG_EEND'] },
    codec: null,
  },
  {
    enumName: 'rig_conf_e',
    values: { type: 'RigConfType', constant: 'RIG_CONF_TYPES' },
    source: { prefix: 'RIG_CONF_', upper: true },
    codec: null,
  },
];

/** The record a C type binds through, or `undefined` when it has none. */
export function enumRecordFor(enumName: string, namespace?: SettingNamespace): EnumRecord | undefined {
  return ENUMS.find((record) => record.enumName === enumName && record.namespace === namespace);
}

/**
 * The C pair a record's names cross through, or `null` when only TypeScript
 * uses them.  A generated pair answers `-1`, which no constant of the enums
 * it covers uses, for a name it does not know; `spelling` is how the C code
 * the sentinel appears in names the type.
 */
export function codecOf(record: EnumRecord, spelling = record.enumName): UpstreamCodec | null {
  if (record.codec !== 'generated') {
    return record.codec;
  }

  const type = record.names?.type;

  if (type === undefined) {
    throw new Error(`${record.enumName} has a generated codec but no names`);
  }

  return { str: `str${type}`, parse: `parse${type}`, none: `(${spelling}) -1` };
}

/** The record whose names form the union `type`, e.g. `PttState`. */
export function recordOfVocabulary(type: string): EnumRecord | undefined {
  return ENUMS.find((record) => record.names?.type === type);
}

/** The union names a config pair may narrow a string to. */
export const VOCABULARY_TYPES: ReadonlySet<string> = new Set(
  ENUMS.flatMap((record) => (record.names ? [record.names.type] : [])),
);
