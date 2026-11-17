// SPDX-License-Identifier: MIT

/**
 * The name vocabularies of Hamlib's enums, read from the pinned release.
 *
 * Hamlib's `rig_parse_*`/`rig_str*` codecs translate through fixed tables in
 * `src/misc.c` (`mode_str[]`, `vfo_str[]`, ...).  Those tables are the whole
 * vocabulary a name-typed argument accepts, so the generator turns each one
 * into a string-literal union instead of typing the argument `string`.  An
 * enum with no upstream codec is named from its own constants, as clang
 * reports them; {@link ENUMS} says which source each enum uses.
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

import type { AstEnum, AstEnumConstant } from './ast.ts';
import { ENUMS, type EnumRecord, type NameSource } from './enums.ts';

/** One enum's names, resolved from its {@link EnumRecord}. */
export interface NameVocabulary {
  readonly record: EnumRecord;
  /** Where the names come from, for the doc comment. */
  readonly source: string;
  /** Every accepted name, in table order, aliases included. */
  readonly names: readonly string[];
  /**
   * For a record named from its constants: the C constant behind each name,
   * in the same order, and how C code spells the type.
   */
  readonly constants?: readonly AstEnumConstant[];
  readonly spelling?: string;
}

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

const STRING_ENTRY = /^"((?:[^"\\]|\\.)*)",?$/;

/**
 * The strings of one `static const char *const <table>[] = { ... };` array,
 * one `"<text>",` per line, under the same strict grammar as
 * {@link parseTable}.
 */
export function parseStringArray(source: string, table: string): string[] {
  const lines = source.split('\n');
  const header = lines.findIndex((line) => new RegExp(`^static const char \\*const ${table}\\[\\]\\s*=$`).test(line.trim()));

  if (header < 0 || lines[header + 1]?.trim() !== '{') {
    fail(`no "static const char *const ${table}[] =" array followed by "{"`);
  }

  const strings: string[] = [];

  for (let index = header + 2; index < lines.length; index++) {
    const line = (lines[index] as string).trim();

    if (line === '};') {
      if (strings.length === 0) {
        fail(`${table} has no entries`);
      }

      return strings;
    }

    const entry = STRING_ENTRY.exec(line);

    if (!entry) {
      fail(`${table}: line ${index + 1} is not a "<text>", entry: ${line}`);
    }

    strings.push(entry[1] as string);
  }

  return fail(`${table} is not closed by "};"`);
}

/**
 * Hamlib's text for each error code, indexed by the code: `rigerror_table[]`
 * in `src/rig.c`, which `rigerror()` reads.
 */
export function loadErrorMessages(sourceDir: string): readonly string[] {
  const file = path.join(sourceDir, 'rig.c');
  let source: string;

  try {
    source = readFileSync(file, 'utf8');
  } catch (error) {
    fail(`cannot read ${file}: ${String(error)}`);
  }

  return parseStringArray(source, 'rigerror_table');
}

type ConstantSource = Extract<NameSource, { readonly prefix: string }>;

/** The names of a record named from the enum constants clang reports. */
export function constantNames(
  record: EnumRecord,
  source: ConstantSource,
  enums: ReadonlyMap<string, AstEnum>,
): NameVocabulary {
  const declared = enums.get(record.enumName);

  if (!declared || declared.constants.length === 0) {
    fail(`the AST has no constants for ${record.enumName}`);
  }

  const constants = declared.constants.filter((entry) => !source.exclude?.includes(entry.name));
  const names = constants.map((entry) => {
    if (!entry.name.startsWith(source.prefix)) {
      fail(`${record.enumName} constant ${entry.name} does not start with ${source.prefix}`);
    }

    const stem = entry.name.slice(source.prefix.length);

    return source.rename?.[entry.name] ?? (source.upper ? stem : stem.toLowerCase().replaceAll('_', '-'));
  });

  for (const name of [...Object.keys(source.rename ?? {}), ...(source.exclude ?? [])]) {
    if (!declared.constants.some((entry) => entry.name === name)) {
      fail(`${record.enumName} has no constant ${name} to rename or exclude`);
    }
  }

  return {
    record,
    /* The transport's own enums are the ones the JS library reads. */
    source: `the \`${declared.spelling}\` constants in ${record.constEnum ? 'native/web_serial.h' : "Hamlib's rig.h"}`,
    names,
    constants,
    spelling: declared.spelling,
  };
}

/** Every vocabulary of {@link ENUMS}, from the pinned `src/misc.c` and the AST. */
export function loadVocabularies(
  sourceDir: string,
  enums: ReadonlyMap<string, AstEnum>,
): readonly NameVocabulary[] {
  const file = path.join(sourceDir, 'misc.c');
  let source: string;

  try {
    source = readFileSync(file, 'utf8');
  } catch (error) {
    fail(`cannot read ${file}: ${String(error)}`);
  }

  return ENUMS.map((record): NameVocabulary => {
    const from = record.source;

    if ('table' in from) {
      return { record, source: `\`${from.table}[]\` in Hamlib's src/misc.c`, names: parseTable(source, from.table) };
    }

    if ('stringifier' in from) {
      const name = from.stringifier.split(' ').at(-1) as string;

      return { record, source: `\`${name}()\` in Hamlib's src/misc.c`, names: parseSwitchNames(source, from.stringifier) };
    }

    return constantNames(record, from, enums);
  });
}
