// SPDX-License-Identifier: MIT

/**
 * `src/native/generated/methods/*.ts`: a real, typed method per operation,
 * split by family so a family reads (and reviews on an upstream bump) on its
 * own.
 *
 * Authored as TypeScript and run directly by Node's type stripping, so this
 * file must stay erasable (no enums, namespaces or parameter properties).
 */
import type { Model, ModelOperation } from '../config.ts';
import { pascalCase } from '../naming.ts';
import {
  bespokeOperations,
  GENERATED_HEADER,
  Imports,
  type ImportModule,
  type OperationFacts,
} from './common.ts';
import {
  bespokeParameters,
  bespokeSignature,
  bespokeValue,
  bespokeVector,
  generatedSignature,
  publicString,
} from './surface.ts';

/** One generated file, by its path relative to `src/native/generated/methods`. */
export interface MethodFile {
  readonly path: string;
  readonly content: string;
}

const METHOD_IMPORTS: Readonly<Record<ImportModule, string>> = {
  embind: '../../hamlib-wasm.mjs',
  names: '../names.js',
  confparams: '../../confparams.js',
  operations: '../operations.js',
  base: './base.js',
};

/**
 * Family order also fixes the class inheritance chain: each file extends the
 * one before it.  A symbol joins the first family one of whose patterns it
 * matches, and every pattern has to match a generated symbol, so a rule an
 * upstream change left behind fails generation instead of lingering.
 */
const FAMILY_RULES: readonly (readonly [string, readonly RegExp[]])[] = [
  ['codec', [/^rig_str/, /^rig_parse_/]],
  ['ext', [/^rig_ext_/, /^rig_get_ext_/, /^rig_set_ext_/]],
  ['settings', [/level$/, /func$/, /parm$/]],
  ['memory', [/mem/, /channel/, /bank/]],
  ['vfo', [/vfo/, /split/, /rit/, /xit/, /rptr/, /scan/, /twiddle/, /uplink/]],
  ['control', [/freq/, /mode/, /ant/, /dcd/, /powerstat/, /reset/, /clock/, /ctcss/, /dcs/]],
  ['info', [/info/, /passband/, /setting2idx/, /idx2setting/]],
];

const FALLBACK_FAMILY = 'misc';

/** The family a symbol's method is emitted into, and the pattern that put it there. */
function familyMatch(symbol: string): { readonly family: string; readonly pattern: RegExp | null } {
  for (const [family, patterns] of FAMILY_RULES) {
    const pattern = patterns.find((candidate) => candidate.test(symbol));

    if (pattern) {
      return { family, pattern };
    }
  }

  return { family: FALLBACK_FAMILY, pattern: null };
}

export function familyOf(symbol: string): string {
  return familyMatch(symbol).family;
}

/** The generated method body: the queue slot, the capability gate, the result check. */
function methodLines(facts: OperationFacts, imports: Imports): string[] {
  const { method } = facts.operation;
  const signature = generatedSignature(facts, imports);
  const args = [...(facts.needsHandle ? ['this.handle()'] : []), ...facts.parameters.map((parameter) => parameter.name)];
  const lines = [`  async ${method}(${signature.parameters}): Promise<${signature.result}> {`];

  if (facts.gate !== null) {
    lines.push(`    this.available('${method}');`);
  }

  /* Every native call takes the queue slot, a "pure" helper included: calling
   * it while another native call is suspended would re-enter the unwound
   * Asyncify stack.  Inside a compound the scope runs this directly, because
   * the body already owns the slot. */
  lines.push(`    return this.serialized('${method}', async () => {`);
  lines.push(`      const result = await this.native().${method}(${args.join(', ')});`);
  lines.push(`      if (result.code !== 0) { throw this.failed(result, '${method}'); }`);

  const unpack = (field: OperationFacts['fields'][number]): string => {
    const access = `result.${field.name}`;

    return field.binding.boundary === 'string' ? publicString(access, field.binding.ts, method, imports) : access;
  };

  if (facts.projection) {
    lines.push(`      return ${imports.value('confparams', facts.projection.project)}(result);`);
  } else if (facts.unwrapsValue) {
    lines.push(`      return ${unpack(facts.fields[0] as OperationFacts['fields'][number])};`);
  } else if (facts.operation.shape !== 'set') {
    lines.push(`      return { ${facts.fields.map((field) => `${field.name}: ${unpack(field)}`).join(', ')} };`);
  }

  lines.push('    });');
  lines.push('  }');

  return lines;
}

/**
 * One bespoke method body.  The shape follows the declared result, so a config
 * entry needs no hand-written TypeScript: a code-only result returns `void`, a
 * single-value result unwraps its field, a vector result is collected into a
 * plain array and the native vector is freed.
 */
function bespokeMethodLines(model: Model, operation: ModelOperation, imports: Imports): string[] {
  const { name } = operation;
  const signature = bespokeSignature(model, operation, imports);
  const call = `this.native().${name}(${['this.handle()', ...bespokeParameters(operation).map(([parameter]) => parameter)].join(', ')})`;
  const lines = [`  async ${name}(${signature.parameters}): Promise<${signature.result}> {`];

  if (operation.capability !== undefined) {
    lines.push(`    this.available('${name}');`);
  }

  if (operation.result.endsWith('[]')) {
    lines.push(`    return this.serialized('${name}', async () =>`);
    lines.push(`      ${imports.value('confparams', bespokeVector(operation).collect)}(await ${call}));`);
    lines.push('  }');

    return lines;
  }

  lines.push(`    return this.serialized('${name}', async () => {`);
  lines.push(`      const result = await ${call};`);
  lines.push(`      if (result.code !== 0) { throw this.failed(result, '${name}'); }`);

  const value = bespokeValue(model, operation);

  if (value !== null) {
    const access = `result.${value[0]}`;

    lines.push(`      return ${value[1] === 'string' ? publicString(access, value[2] ?? 'string', name, imports) : access};`);
  }

  lines.push('    });');
  lines.push('  }');

  return lines;
}

function baseFile(): string {
  const imports = new Imports();
  imports.type('operations', 'NativeOperations');
  const proto = imports.value('names', 'RIG_ERRCODES');

  return `${GENERATED_HEADER}

${imports.render(METHOD_IMPORTS).join('\n')}

/** The low-level call result: a Hamlib code plus the transport error text. */
export interface GeneratedCallResult {
  readonly code: number;
  readonly error: unknown;
}

/**
 * Shared plumbing for the generated rig methods.  \`src/raw.ts\` supplies the
 * implementation: the native module, the current handle, the single call queue,
 * the capability gate and the error conversion.
 */
export abstract class GeneratedRigBase {
  protected abstract native(): NativeOperations;

  protected abstract handle(): number;

  protected abstract serialized<T>(
    operation: string,
    work: () => Promise<T>,
  ): Promise<T>;

  protected abstract available(operation: string): void;

  protected abstract failed(result: GeneratedCallResult, operation: string): Error;

  /**
   * \`value\` as one of \`names\`.  The C side only reports a name its codec
   * knows, so anything else is a protocol failure, never a value outside the
   * type.
   */
  protected named<T extends string>(names: readonly T[], value: unknown, operation: string): T {
    const text = String(value);
    const name = names.find((candidate) => candidate === text);

    if (name === undefined) {
      throw this.failed({ code: -${proto}.EPROTO, error: \`"\${text}" is not one of \${names.join(', ')}\` }, operation);
    }

    return name;
  }
}
`;
}

/** A class in the chain: its imports, its doc line and its methods. */
function classFile(
  className: string,
  previous: { readonly className: string; readonly path: string },
  doc: readonly string[],
  methods: (imports: Imports) => string[][],
): string {
  const imports = new Imports();
  const bodies = methods(imports);
  const rendered = imports.render(METHOD_IMPORTS);
  const lines = [GENERATED_HEADER, ''];

  if (rendered.length > 0) {
    lines.push(...rendered, '');
  }

  lines.push(`import { ${previous.className} } from '${previous.path}';`, '');
  lines.push(...doc);
  lines.push(`export abstract class ${className} extends ${previous.className} {`);

  for (const body of bodies) {
    lines.push('', ...body);
  }

  lines.push('}', '');

  return lines.join('\n');
}

function indexFile(className: string, path: string): string {
  return `${GENERATED_HEADER}

import type { GeneratedPublicOperations } from '../operations.js';
import { ${className} } from '${path}';

/**
 * Every generated operation as a real, typed method, assembled from the family
 * classes.  \`RawRigHandle\` extends this; \`tsc\` proves the methods satisfy
 * \`GeneratedPublicOperations\`.
 */
export abstract class GeneratedRigMethods
  extends ${className}
  implements GeneratedPublicOperations {}
`;
}

/** The generated method files. */
export function emitMethodFiles(model: Model, facts: readonly OperationFacts[]): readonly MethodFile[] {
  const grouped = new Map<string, OperationFacts[]>();
  const used = new Set<RegExp>();

  for (const fact of facts) {
    const { family, pattern } = familyMatch(fact.operation.symbol);
    grouped.set(family, [...(grouped.get(family) ?? []), fact]);

    if (pattern) {
      used.add(pattern);
    }
  }

  const unused = FAMILY_RULES.flatMap(([family, patterns]) =>
    patterns.filter((pattern) => !used.has(pattern)).map((pattern) => `${family} ${pattern}`));

  if (unused.length > 0) {
    throw new Error(`family rules that place no generated operation: ${unused.join(', ')}`);
  }

  const bespoke = bespokeOperations(model);
  const files: MethodFile[] = [{ path: 'base.ts', content: baseFile() }];
  let previous = { className: 'GeneratedRigBase', path: './base.js' };

  /* Bespoke methods sit at the head of the chain: their bodies are the only
   * ones the generator cannot write from the AST, so they read first. */
  if (bespoke.length > 0) {
    files.push({
      path: 'bespoke.ts',
      content: classFile('BespokeMethods', previous, [
        '/**',
        ' * Operations whose C++ body is hand-written in `native/facade.cpp`:',
        ' * buffers a signature cannot describe, the table walkers, extended',
        ' * settings and PTT.',
        ' * The method itself is generated from the config like every other.',
        ' */',
      ], (imports) => bespoke.map((operation) => bespokeMethodLines(model, operation, imports))),
    });
    previous = { className: 'BespokeMethods', path: './bespoke.js' };
  }

  for (const family of [...FAMILY_RULES.map(([name]) => name), FALLBACK_FAMILY]) {
    const members = grouped.get(family);

    if (!members) {
      continue;
    }

    const className = `${pascalCase(family)}Methods`;

    files.push({
      path: `${family}.ts`,
      content: classFile(className, previous, [`/** Generated operations in the ${family} family. */`], (imports) =>
        members.map((fact) => methodLines(fact, imports))),
    });
    previous = { className, path: `./${family}.js` };
  }

  files.push({ path: 'index.ts', content: indexFile(previous.className, previous.path) });

  return files;
}
