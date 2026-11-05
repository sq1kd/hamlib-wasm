// SPDX-License-Identifier: MIT

/**
 * Upstream Doxygen, carried onto the generated surface as TSDoc.
 *
 * Hamlib documents its public calls where they are defined, in the `.c`
 * files, not in the headers the AST is built from.  This module reads those
 * comments from the pinned release and rewrites each into a TSDoc block for
 * the method that binds the call:
 *
 *   - the summary, body paragraphs and notes are kept, with `\a name` and
 *     `#type` references turned into code spans and `rig_*()` references into
 *     links to the bound method;
 *   - `\param` entries survive only for the arguments the method takes, under
 *     their JavaScript names; out-parameters become `@returns`;
 *   - the RIG_OK boilerplate, the rig handle and the target VFO the binding
 *     fills in, and `\code` examples (C, which does not apply) are dropped.
 *
 * The text stays Hamlib's (LGPL-2.1-or-later), so each block says where it
 * came from.  A call that has no comment upstream gets no block.
 *
 * Authored as TypeScript and run directly by Node's type stripping, so this
 * file must stay erasable (no enums, namespaces or parameter properties).
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { TypeBinding } from './types.ts';

/** One upstream Doxygen comment, split into the parts the renderer uses. */
export interface UpstreamDoc {
  readonly brief: string;
  /** Description paragraphs, each already joined into one line. */
  readonly body: readonly string[];
  readonly params: ReadonlyMap<string, string>;
  readonly returns: string | null;
  readonly notes: readonly string[];
  readonly see: readonly string[];
}

/** One value crossing the boundary, with the C parameter it came from. */
export interface DocumentedValue {
  /** The C parameter name, as the upstream `\param` names it. */
  readonly c: string;
  /** The JavaScript name: an argument name or a result field. */
  readonly js: string;
  readonly binding: TypeBinding | null;
}

/** What the renderer needs to know about one bound method. */
export interface DocTarget {
  readonly symbol: string;
  /** Arguments, in JavaScript order. */
  readonly arguments: readonly DocumentedValue[];
  /**
   * What the method resolves to: nothing (`void`), a single value, or an
   * object with one field per entry.
   */
  readonly result:
    | { readonly kind: 'void' }
    | { readonly kind: 'value'; readonly value: DocumentedValue | null }
    | { readonly kind: 'object'; readonly fields: readonly DocumentedValue[] };
}

/** Upstream symbol to the public method that binds it. */
export type MethodNames = ReadonlyMap<string, string>;

/**
 * A definition at the start of a line, its comment directly above it.  Only
 * blank lines and preprocessor lines (the `BUILTINFUNC` dance) may separate
 * the two.
 */
const DEFINITION = /\/\*\*((?:(?!\*\/)[\s\S])*)\*\/[ \t]*\n((?:[ \t]*(?:#[^\n]*)?\n)*)[A-Za-z_][^;{}()\n#]*?\b(rig_\w+)\s*\([^;{]*?\)[ \t]*\n(?:[ \t]*(?:#[^\n]*|[A-Za-z_][^;{}\n]*\))?[ \t]*\n)*[ \t]*\{/g;

/** Every documented definition in the given C sources, first one wins. */
export function parseUpstreamDocs(sources: readonly string[]): Map<string, UpstreamDoc> {
  const docs = new Map<string, UpstreamDoc>();

  for (const source of sources) {
    for (const match of source.matchAll(DEFINITION)) {
      const symbol = match[3] as string;

      if (!docs.has(symbol)) {
        const doc = parseComment(match[1] as string);

        if (doc !== null) {
          docs.set(symbol, doc);
        }
      }
    }
  }

  return docs;
}

/** Read every `.c` file of an upstream `src/` directory. */
export function loadUpstreamDocs(sourceDir: string): Map<string, UpstreamDoc> {
  const files = readdirSync(sourceDir)
    .filter((name) => name.endsWith('.c'))
    .sort()
    .map((name) => readFileSync(path.join(sourceDir, name), 'utf8'));

  return parseUpstreamDocs(files);
}

/**
 * Prose about the C calling convention rather than the radio: examples in C,
 * NULL out-pointers, memory the caller must free, and upstream TODOs.  None of
 * it applies once the call is a method returning a value, so such a paragraph
 * is dropped.
 */
const C_ONLY = /^(?:example|todo|fixme)\b|\bNULL\b|\bpointer to a newly\b|\bfree\b/i;

type Section =
  | { readonly kind: 'brief' }
  | { readonly kind: 'param'; readonly name: string }
  | { readonly kind: 'return' }
  | { readonly kind: 'note' }
  | { readonly kind: 'see' }
  | { readonly kind: 'body' };

const COMMAND = /^[\\@](brief|param|returns?|retval|note|sa|see|code|endcode)\b\s*(.*)$/;

/** Split one comment body into its Doxygen sections. */
export function parseComment(comment: string): UpstreamDoc | null {
  const lines = comment.split('\n').map((line) => line.replace(/^[ \t]*\*?[ \t]?/, '').trimEnd());
  const brief: string[] = [];
  const body: string[][] = [[]];
  const params = new Map<string, string[]>();
  const returns: string[] = [];
  const notes: string[][] = [];
  const see: string[] = [];
  let section: Section = { kind: 'body' };
  let inCode = false;

  const push = (text: string): void => {
    switch (section.kind) {
      case 'brief': brief.push(text); break;
      case 'param': params.get(section.name)?.push(text); break;
      case 'return': returns.push(text); break;
      case 'note': notes[notes.length - 1]?.push(text); break;
      case 'see': see.push(text); break;
      case 'body': body[body.length - 1]?.push(text); break;
    }
  };

  for (const raw of lines) {
    const line = raw.trim();

    if (inCode) {
      inCode = !/^[\\@]endcode\b/.test(line);
      continue;
    }

    const command = COMMAND.exec(line);

    if (command !== null) {
      const [, name, rest = ''] = command;

      switch (name) {
        case 'code':
          inCode = true;
          section = { kind: 'body' };
          body.push([]);
          continue;
        case 'endcode':
          continue;
        case 'brief':
          section = { kind: 'brief' };
          break;
        case 'param': {
          const [, param = '', text = ''] = /^(?:\[[a-z,]+\]\s*)?(\S+)\s*(.*)$/.exec(rest) ?? [];

          section = { kind: 'param', name: param };
          params.set(param, []);
          push(text);
          continue;
        }
        case 'note':
          section = { kind: 'note' };
          notes.push([]);
          break;
        case 'sa':
        case 'see':
          section = { kind: 'see' };
          break;
        default:
          section = { kind: 'return' };
          break;
      }

      push(rest);
      continue;
    }

    if (line === '') {
      /* A blank line ends a tagged section; prose after it is description. */
      section = { kind: 'body' };
      body.push([]);
      continue;
    }

    push(line);
  }

  const join = (parts: readonly string[]): string => parts.join(' ').replace(/\s+/g, ' ').trim();
  const paragraphs = body.map(join).filter((text) => text !== '' && !C_ONLY.test(text));

  if (brief.length === 0 && paragraphs.length === 0) {
    return null;
  }

  return {
    brief: join(brief),
    body: paragraphs,
    params: new Map([...params].map(([name, text]) => [name, join(text)])),
    returns: returns.length === 0 ? null : join(returns),
    notes: notes.map(join).filter((text) => text !== '' && !C_ONLY.test(text)),
    see: join(see).split(/[\s,]+/).filter((item) => item !== ''),
  };
}

/**
 * How each name-typed value crosses: the upstream stringifier, and one
 * constant with the name that stands for it, so the C constant in the prose
 * can be matched to what a caller passes.
 */
const NAMED_VALUES: Readonly<Record<string, readonly [constant: string, name: string]>> = {
  rig_strvfo: ['RIG_VFO_A', 'VFOA'],
  rig_strrmode: ['RIG_MODE_USB', 'USB'],
  rig_strptrshift: ['RIG_RPT_SHIFT_PLUS', '+'],
  rig_strvfop: ['RIG_OP_UP', 'UP'],
  rig_strscan: ['RIG_SCAN_VFO', 'VFO'],
  rig_strlevel: ['RIG_LEVEL_STRENGTH', 'STRENGTH'],
  rig_strfunc: ['RIG_FUNC_NB', 'NB'],
  rig_strparm: ['RIG_PARM_BACKLIGHT', 'BACKLIGHT'],
};

/** The RIG_OK/negative-code sentence every status-returning call repeats. */
const STATUS_RETURN = /^RIG_OK if the operation has been successful/i;

/** "The location where to store the current frequency" -> "The current frequency". */
function outputPhrase(text: string): string {
  return capitalize(text.replace(/^(?:the\s+)?location\s+where\s+to\s+store\s+/i, ''));
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function sentence(text: string): string {
  const trimmed = capitalize(text.trim());

  return trimmed === '' || /[.!?:]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** A link to the bound method, or a code span for a call this package does not bind. */
function callReference(symbol: string, methods: MethodNames): string {
  const method = methods.get(symbol);

  return method === undefined ? `\`${symbol}()\`` : `{@link RawRig.${method}}`;
}

/**
 * Rewrite one run of upstream prose as TSDoc text.  Order matters: TSDoc's
 * own syntax is escaped first, so the links and code spans added afterwards
 * survive.
 */
function inline(text: string, names: ReadonlyMap<string, string>, methods: MethodNames): string {
  return text
    .replace(/[{}@]/g, (character) => `\\${character}`)
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\\a\s+([A-Za-z_]\w*)((?:-&gt;\w+)*)/g, (_, name: string, fields: string) =>
      `\`${names.get(name) ?? name}${fields.replace(/-&gt;/g, '.')}\``)
    .replace(/(?<![\w`])#([A-Za-z_]\w*)/g, '`$1`')
    .replace(/(?<![\w`])(rig_\w+)(?:\(\))?/g, (_, symbol: string) => callReference(symbol, methods))
    .replace(/(?<![\w`])(RIG_[A-Z0-9_]+(?:\?+)?)(?![\w`])/g, '`$1`')
    .replace(/\s+/g, ' ')
    .trim();
}

/** C types whose value is a frequency, which upstream prose rarely spells out. */
const HERTZ: ReadonlySet<string> = new Set(['freq_t', 'shortfreq_t', 'pbwidth_t']);

/** The sentence telling a caller how a value is spelled or measured. */
function namedValueHint(binding: TypeBinding | null, methods: MethodNames): string {
  if (binding !== null && HERTZ.has(binding.native)) {
    return ' In hertz.';
  }

  const stringifier = binding?.enumStr;
  const example = stringifier === undefined ? undefined : NAMED_VALUES[stringifier];

  if (stringifier === undefined || example === undefined) {
    return '';
  }

  const [constant, name] = example;

  return ` Named as ${callReference(stringifier, methods)} spells it: \`${constant}\` is \`"${name}"\`.`;
}

/**
 * Render the TSDoc lines (no comment delimiters, no indentation) for one
 * bound method, or `null` when upstream has nothing to say about it.
 */
export function renderDoc(
  doc: UpstreamDoc | undefined,
  target: DocTarget,
  methods: MethodNames,
): string[] | null {
  if (doc === undefined) {
    return null;
  }

  const values = [
    ...target.arguments,
    ...(target.result.kind === 'value' && target.result.value !== null ? [target.result.value] : []),
    ...(target.result.kind === 'object' ? target.result.fields : []),
  ];
  const names = new Map(values.map((value) => [value.c, value.js]));
  const text = (prose: string): string => inline(prose, names, methods);
  const lines: string[] = [];
  const paragraph = (content: string): void => {
    if (content === '') {
      return;
    }

    if (lines.length > 0) {
      lines.push('');
    }

    lines.push(content);
  };

  paragraph(sentence(text(doc.brief)));

  for (const body of doc.body) {
    paragraph(capitalize(text(body)));
  }

  for (const note of doc.notes) {
    paragraph(`Note: ${text(note)}`);
  }

  paragraph(`From Hamlib's documentation of \`${target.symbol}()\`.`);
  lines.push('');

  for (const argument of target.arguments) {
    const description = doc.params.get(argument.c);
    const hint = namedValueHint(argument.binding, methods);

    const described = `${sentence(text(description ?? ''))}${hint}`.trim();

    if (described !== '') {
      lines.push(`@param ${argument.js} - ${described}`);
    }
  }

  const returned = returnsLine(doc, target, text, methods);

  if (returned !== null) {
    const [first, ...rest] = returned;

    lines.push(`@returns ${first}`, ...rest);
  }

  const seeAlso = doc.see.filter((item) => /^rig_\w+(?:\(\))?$/.test(item));

  for (const item of seeAlso) {
    lines.push(`@see ${callReference(item.replace(/\(\)$/, ''), methods)}`);
  }

  while (lines.at(-1) === '') {
    lines.pop();
  }

  return lines;
}

function returnsLine(
  doc: UpstreamDoc,
  target: DocTarget,
  text: (prose: string) => string,
  methods: MethodNames,
): string[] | null {
  const result = target.result;

  if (result.kind === 'void') {
    return null;
  }

  if (result.kind === 'object') {
    const fields = result.fields.map((field) => {
      const description = doc.params.get(field.c);

      const described = `${description === undefined ? '' : sentence(text(outputPhrase(description)))}`
        + namedValueHint(field.binding, methods);

      return `- \`${field.js}\`${described.trim() === '' ? '' : `: ${described.trim()}`}`;
    });

    return fields.length === 0 ? null : ['An object with:', '', ...fields];
  }

  const value = result.value;
  const output = value === null ? undefined : doc.params.get(value.c);

  if (output !== undefined) {
    return [`${sentence(text(outputPhrase(output)))}${namedValueHint(value?.binding ?? null, methods)}`];
  }

  if (doc.returns !== null && !STATUS_RETURN.test(doc.returns)) {
    return [`${sentence(text(doc.returns))}${namedValueHint(value?.binding ?? null, methods)}`];
  }

  return null;
}

/** Width of a comment line's text, after the indentation and ` * `. */
const WRAP = 76;

/**
 * Break one line on spaces, never inside an inline tag or a code span, and
 * keep a list item's continuation indented under its text.
 */
function wrap(line: string): string[] {
  const words = line.match(/\{@[^}]*\}\S*|`[^`]*`\S*|\S+/g) ?? [];
  const hanging = /^(?:- |@param |@returns )/.test(line) ? '  ' : '';
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    if (current !== '' && current.length + 1 + word.length > WRAP) {
      lines.push(current);
      current = `${hanging}${word}`;
    } else {
      current = current === '' ? word : `${current} ${word}`;
    }
  }

  lines.push(current);
  return lines;
}

/** Wrap rendered lines in a comment at the given indentation. */
export function commentBlock(lines: readonly string[], indent: string): string[] {
  return [
    `${indent}/**`,
    ...lines.flatMap(wrap).map((line) =>
      (line === '' ? `${indent} *` : `${indent} * ${line.replace(/\*\//g, '*\\/')}`)),
    `${indent} */`,
  ];
}
