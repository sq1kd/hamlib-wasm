// SPDX-License-Identifier: MIT

/**
 * The name vocabularies of Hamlib's enums, read from the pinned source.
 *
 * Hamlib's `rig_parse_*`/`rig_str*` codecs translate through fixed tables in
 * `src/misc.c` (`mode_str[]`, `vfo_str[]`, ...).  Those tables are the whole
 * vocabulary a name-typed argument accepts, so the generator turns each one
 * into a string-literal union instead of typing the argument `string`.
 *
 * The tables are data, not declarations clang's header AST would carry, so
 * they are read from the source with a strict grammar: every line between the
 * table's opening and closing brace must be one `{ <value>, "<name>" },`
 * entry, a blank line or a comment.  Anything else - a preprocessor branch, a
 * second string, a reshaped entry - fails generation, so an upstream change to
 * a table is a build error, never a silently wrong union.  The Node suite
 * checks every name round-trips through the built module.
 *
 * Authored as TypeScript and run directly by Node's type stripping, so this
 * file must stay erasable (no enums, namespaces or parameter properties).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

/** One generated union: its public name and the table it comes from. */
export interface NameVocabulary {
  /** The exported type, e.g. `RigMode`. */
  readonly type: string;
  /** The exported `as const` array, e.g. `RIG_MODES`. */
  readonly constant: string;
  /** Where the names come from, for the doc comment. */
  readonly source: string;
  /** Every accepted name, in table order, aliases included. */
  readonly names: readonly string[];
  /**
   * For an enum Hamlib has no codec for: the C constant behind each name, in
   * the same order.  The generator emits the parse/stringify pair itself.
   */
  readonly constants?: readonly string[];
}

/**
 * Enums with no upstream `rig_str*`/`rig_parse_*` pair, named from their own
 * constants: `RIG_POWER_STANDBY` is `'standby'`.  `codec` names the facade
 * helpers the generator emits (`parsePowerStatus`/`strPowerStatus`).
 */
export const AST_VOCABULARIES: readonly {
  readonly enumName: string;
  readonly type: string;
  readonly constant: string;
  readonly prefix: string;
}[] = [
  { enumName: 'powerstat_t', type: 'PowerStatus', constant: 'POWER_STATUSES', prefix: 'RIG_POWER_' },
  { enumName: 'reset_t', type: 'ResetKind', constant: 'RESET_KINDS', prefix: 'RIG_RESET_' },
];

/** Table name in `src/misc.c` -> the union it becomes. */
const TABLES: readonly { readonly table: string; readonly type: string; readonly constant: string }[] = [
  { table: 'mode_str', type: 'RigMode', constant: 'RIG_MODES' },
  { table: 'vfo_str', type: 'Vfo', constant: 'VFOS' },
  { table: 'rig_level_str', type: 'Level', constant: 'LEVELS' },
  { table: 'rig_func_str', type: 'Func', constant: 'FUNCS' },
  { table: 'rig_parm_str', type: 'Parm', constant: 'PARMS' },
  { table: 'vfo_op_str', type: 'VfoOp', constant: 'VFO_OPS' },
  { table: 'scan_str', type: 'ScanOp', constant: 'SCAN_OPS' },
];

function fail(message: string): never {
  process.stderr.write(`[codegen:names] error: ${message}\n`);
  process.exit(1);
}

const ENTRY = /^\{\s*[^{}",]+,\s*(?:"([^"\\]*)"|NULL)\s*\},?\s*(?:\/\/.*)?$/;

/** The names of one `static const struct { ... } <table>[] = { ... };` table. */
export function parseTable(source: string, table: string): string[] {
  const lines = source.split('\n');
  const header = lines.findIndex((line) => new RegExp(`^\\}\\s*${table}\\[\\]\\s*=\\s*$`).test(line.trim()));

  if (header < 0 || lines[header + 1]?.trim() !== '{') {
    fail(`src/misc.c has no "} ${table}[] =" table followed by "{"`);
  }

  const names: string[] = [];

  for (let index = header + 2; index < lines.length; index++) {
    const line = (lines[index] as string).trim();

    if (line === '};') {
      if (names.length === 0) {
        fail(`${table} has no entries`);
      }

      return names;
    }

    if (line === '' || line.startsWith('//') || (line.startsWith('/*') && line.endsWith('*/'))) {
      continue;
    }

    const entry = ENTRY.exec(line);

    if (!entry) {
      fail(`${table}: line ${index + 1} is not a { value, "name" } entry: ${line}`);
    }

    /* An empty name or NULL is the end-of-table sentinel the codecs stop at. */
    const name = entry[1] ?? '';

    if (name !== '' && !names.includes(name)) {
      names.push(name);
    }
  }

  return fail(`${table} is not closed by "};"`);
}

/**
 * The names a stringifier written as a switch returns: its
 * `return "<name>";` statements are the vocabulary.  `signature` is the
 * function's declaration up to its opening parenthesis.
 */
export function parseSwitchNames(source: string, signature: string): string[] {
  const start = source.indexOf(`${signature}(`);

  if (start < 0) {
    fail(`no ${signature}() to read names from`);
  }

  const end = source.indexOf('\n}\n', start);
  const body = source.slice(start, end);
  const names = [...body.matchAll(/return "([^"\\]+)";/g)].map((match) => match[1] as string);

  if (names.length === 0) {
    fail(`${signature}() returns no names`);
  }

  return [...new Set(names)];
}

/** The union names the type table may use; each one is emitted from a vocabulary below. */
export const VOCABULARY_TYPES: ReadonlySet<string> = new Set([
  ...TABLES.map((table) => table.type),
  'RptrShift',
  'PttState',
  ...AST_VOCABULARIES.map((vocabulary) => vocabulary.type),
]);

/** The vocabularies of {@link AST_VOCABULARIES}, from the enum constants clang reports. */
export function astVocabularies(enums: ReadonlyMap<string, { readonly constants: readonly { readonly name: string }[] }>): NameVocabulary[] {
  return AST_VOCABULARIES.map(({ enumName, type, constant, prefix }) => {
    const declared = enums.get(enumName);

    if (!declared || declared.constants.length === 0) {
      fail(`the AST has no constants for ${enumName}`);
    }

    const constants = declared.constants.map((entry) => entry.name);

    for (const name of constants) {
      if (!name.startsWith(prefix)) {
        fail(`${enumName} constant ${name} does not start with ${prefix}`);
      }
    }

    return {
      type,
      constant,
      source: `the \`${enumName}\` constants in Hamlib's rig.h`,
      names: constants.map((name) => name.slice(prefix.length).toLowerCase()),
      constants,
    };
  });
}

/** Every vocabulary the generator types, read from the pinned `src/misc.c`. */
export function loadVocabularies(sourceDir: string): readonly NameVocabulary[] {
  const file = path.join(sourceDir, 'misc.c');
  let source: string;

  try {
    source = readFileSync(file, 'utf8');
  } catch (error) {
    fail(`cannot read ${file}: ${String(error)}`);
  }

  return [
    ...TABLES.map(({ table, type, constant }) => ({
      type,
      constant,
      source: `\`${table}[]\` in Hamlib's src/misc.c`,
      names: parseTable(source, table),
    })),
    {
      type: 'RptrShift',
      constant: 'RPTR_SHIFTS',
      source: '`rig_strptrshift()` in Hamlib\'s src/misc.c',
      names: parseSwitchNames(source, 'const char *HAMLIB_API rig_strptrshift'),
    },
  ];
}

/**
 * Vocabularies the facade defines itself: the push-to-talk states
 * `pttToString()` in `native/facade.cpp` reports and `stringToPtt()` accepts.
 */
export function facadeVocabularies(facadeFile: string): NameVocabulary[] {
  let source: string;

  try {
    source = readFileSync(facadeFile, 'utf8');
  } catch (error) {
    fail(`cannot read ${facadeFile}: ${String(error)}`);
  }

  return [{
    type: 'PttState',
    constant: 'PTT_STATES',
    source: '`pttToString()` in native/facade.cpp',
    names: parseSwitchNames(source, 'std::string pttToString'),
  }];
}
