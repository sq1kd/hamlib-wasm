#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/**
 * Regenerate the binding surface of packages/hamlib-wasm.
 *
 * Two inputs meet here:
 *
 *   - `hamlib.config.yaml` — the hand-authored config: the operations that need
 *     a bespoke facade body, the value objects that cross the boundary, and the
 *     renames for the generated surface.  Their upstream calls are recorded so
 *     a signature change fails the build instead of changing behaviour
 *     silently.
 *   - the compiler AST of the pinned headers — everything else.  Every
 *     remaining `rig_get_*`/`rig_set_*`/value-returning declaration is
 *     classified into a shape and either generated or listed as a refusal with
 *     a reason.
 *
 * The pinned `src/` directory adds the upstream Doxygen comments, which the
 * public contract carries as TSDoc (see `docs.ts`).
 *
 * Outputs: the generated C++ includes, the strict TypeScript contract and
 * method classes, and a committed coverage report (coverage.json) recording
 * which declarations are bound, which are refused, and the exact signature of
 * every symbol a bespoke operation calls.
 *
 * The config itself is never rewritten: it belongs to the reader, and a tool
 * that reformatted it would bury the review that an upstream bump needs.
 *
 * Run with `--update` to rewrite the generated files; run with `--check` to
 * fail when they are stale; pass `--emitted` to additionally prove the linked
 * module still exposes every configured and generated operation.
 *
 * Authored as TypeScript and run directly by Node's type stripping, so this
 * file must stay erasable (no enums, namespaces or parameter properties).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import { loadAst, type AstIndex } from './ast.ts';
import { canonicalDeclaration, classifyAll, type GeneratedOperation } from './classify.ts';
import { loadConfig, type Model } from './config.ts';
import { loadUpstreamDocs, type UpstreamDoc } from './docs.ts';
import { operationFacts } from './emit/common.ts';
import { emitContract } from './emit/contract.ts';
import { emitCapabilities, emitCodecs, emitEmbind, emitOperations, emitResults } from './emit/cpp.ts';
import { emitMethodFiles } from './emit/methods.ts';
import { emitPolicyHeader, lineSettingsTypes, policyConstants } from './emit/policy.ts';
import { emitNames, emitTransportTypes, errorMessageConstants } from './emit/names.ts';
import { loadErrorMessages, loadVocabularies } from './names.ts';
import type { NameVocabulary } from './names.ts';
import { createProjectionResolver, staleProjectionRenames } from './project.ts';
import type { ProjectionSpec } from './types.ts';

function fail(message: string): never {
  process.stderr.write(`[codegen] error: ${message}\n`);
  process.exit(1);
}

function log(message: string): void {
  process.stdout.write(`[codegen] ${message}\n`);
}

interface Options {
  readonly update: boolean;
  readonly config: string;
  readonly packageDir: string;
  readonly headers: string;
  readonly sources: string;
  readonly emitted: string | null;
}

function parseArgs(argv: readonly string[]): Options {
  const values = new Map<string, string>();
  let update = false;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] as string;

    if (arg === '--update') {
      update = true;
    } else if (arg === '--check') {
      update = false;
    } else if (
      arg === '--config'
      || arg === '--package'
      || arg === '--headers'
      || arg === '--sources'
      || arg === '--emitted'
    ) {
      const value = argv[++index];

      if (value === undefined) {
        fail(`${arg} needs a value`);
      }

      values.set(arg, value);
    } else {
      fail(`unknown argument ${arg}`);
    }
  }

  for (const required of ['--config', '--package', '--headers', '--sources']) {
    if (!values.has(required)) {
      fail(`${required} is required`);
    }
  }

  return {
    update,
    config: values.get('--config') as string,
    packageDir: values.get('--package') as string,
    headers: values.get('--headers') as string,
    sources: values.get('--sources') as string,
    emitted: values.get('--emitted') ?? null,
  };
}

interface Outputs {
  readonly files: readonly (readonly [string, string])[];
  readonly generated: readonly { readonly method: string; readonly arity: number }[];
}

/** Where the generated artifacts live inside the package. */
interface GeneratedPaths {
  readonly coverage: string;
  readonly embind: string;
  readonly codecs: string;
  readonly transport: string;
  readonly policy: string;
  readonly results: string;
  readonly operations: string;
  readonly capabilities: string;
  readonly contract: string;
  readonly names: string;
  readonly methodsDir: string;
}

function outputPaths(packageDir: string): GeneratedPaths {
  const generated = path.join(packageDir, 'native', 'generated');
  const contract = path.join(packageDir, 'src', 'native', 'generated');

  return {
    coverage: path.join(packageDir, 'coverage.json'),
    embind: path.join(generated, 'embind.inc'),
    codecs: path.join(generated, 'codecs.h'),
    transport: path.join(generated, 'transport.d.ts'),
    policy: path.join(generated, 'policy.h'),
    results: path.join(generated, 'results.inc'),
    operations: path.join(generated, 'operations.inc'),
    capabilities: path.join(generated, 'capabilities.inc'),
    contract: path.join(contract, 'operations.ts'),
    names: path.join(contract, 'names.ts'),
    methodsDir: path.join(contract, 'methods'),
  };
}

/** `struct rig_caps` function-pointer member names, for capability gating. */
function capsMembers(ast: AstIndex): Set<string> {
  const caps = ast.records.get('rig_caps');
  const names = new Set<string>();

  for (const field of caps?.fields ?? []) {
    if (field.qualType.includes('(*)')) {
      names.add(field.name);
    }
  }

  return names;
}

/** The upstream symbols a bespoke facade body calls; each is pinned by signature. */
function calledSymbols(model: Model): string[] {
  const symbols = new Set<string>();

  for (const operation of model.operations) {
    for (const symbol of operation.calls) {
      symbols.add(symbol);
    }
  }

  return [...symbols].sort();
}

function signatureOf(ast: AstIndex, symbol: string): string[] {
  return (ast.functions.get(symbol) ?? [])
    .map((fn) => {
      const params = fn.params.map((param) => param.qualType).join(', ');

      return `${fn.result} ${symbol}(${params.length === 0 ? 'void' : params})`;
    })
    .sort();
}

/** Every projection an operation's arguments, outputs or result were built from. */
function projections(operations: readonly GeneratedOperation[]): ProjectionSpec[] {
  return operations.flatMap((operation) =>
    [...operation.arguments, ...operation.outputs].map((value) => value.binding).concat(operation.pure ?? []))
    .flatMap((binding) => (binding.projection ? [binding.projection] : []));
}

interface CoverageReport {
  readonly signatures?: Readonly<Record<string, readonly string[]>>;
}

function readSignatures(file: string): Readonly<Record<string, readonly string[]>> | null {
  if (!existsSync(file)) {
    return null;
  }

  const report = JSON.parse(readFileSync(file, 'utf8')) as CoverageReport;
  const signatures = report.signatures;

  return typeof signatures === 'object' && signatures !== null ? signatures : null;
}

interface Drift {
  readonly symbol: string;
  readonly expected: readonly string[];
  readonly actual: readonly string[];
}

/**
 * Compare every recorded signature with what the AST now says.  A change is a
 * behavioural change and must be reviewed, so `--check` fails and `--update`
 * records the new shape.
 */
function checkSignatures(
  ast: AstIndex,
  recorded: Readonly<Record<string, readonly string[]>>,
  symbols: readonly string[],
): Drift[] {
  const drift: Drift[] = [];

  for (const symbol of symbols) {
    const expected = [...(recorded[symbol] ?? [])].sort();
    const actual = signatureOf(ast, symbol);

    if (expected.join(' | ') !== actual.join(' | ')) {
      drift.push({ symbol, expected, actual });
    }
  }

  return drift;
}

interface EmittedOperation {
  readonly arity: number;
  /** The declared return type, whitespace-normalised. */
  readonly returnType: string;
}

type ModuleDeclaration = ts.InterfaceDeclaration | ts.ClassDeclaration;

function isModuleDeclaration(statement: ts.Statement): statement is ModuleDeclaration {
  return (ts.isInterfaceDeclaration(statement) || ts.isClassDeclaration(statement))
    && statement.name !== undefined;
}

function isExported(node: ts.Node): boolean {
  return ts.canHaveModifiers(node)
    && (ts.getModifiers(node) ?? []).some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    );
}

/**
 * The module facade the emitted declaration exposes.
 *
 * Emscripten always dumps the Embind surface into `EmbindModule`; some
 * versions instead export the facade class/interface directly, under a name
 * ending in `Module`.  A non-exported `WasmModule` stub is deliberately not a
 * candidate: parsing it would look like a module with no operations instead of
 * the hard failure the caller relies on.
 */
function findModuleDeclaration(source: ts.SourceFile): ModuleDeclaration | null {
  const candidates = source.statements.filter(isModuleDeclaration);

  return candidates.find((statement) => statement.name?.text === 'EmbindModule')
    ?? candidates.find(
      (statement) => isExported(statement) && /Module$/.test(statement.name?.text ?? ''),
    )
    ?? null;
}

function methodNameOf(member: ts.MethodSignature | ts.MethodDeclaration): string | null {
  const name = member.name;

  if (name === undefined) {
    return null;
  }

  return ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)
    ? name.text
    : null;
}

/**
 * Parse the emitted `.d.mts` and collect each Embind method with its parameter
 * count and return type.
 *
 * This reads the compiler's own syntax tree instead of slicing lines: wrapping
 * a signature or re-indenting the interface then leaves the result unchanged,
 * while a changed parameter count or return type still shows up.  `arity` is
 * the full declared parameter count, including the leading `handle`, which is
 * what the generator reports for comparison.
 */
export function parseEmitted(declaration: string): Map<string, EmittedOperation> {
  const source = ts.createSourceFile(
    'hamlib-wasm.d.mts',
    declaration,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const module = findModuleDeclaration(source);

  if (module === null) {
    fail('the emitted declaration has no EmbindModule interface');
  }

  const operations = new Map<string, EmittedOperation>();

  for (const member of module.members) {
    if (!ts.isMethodSignature(member) && !ts.isMethodDeclaration(member)) {
      continue;
    }

    const name = methodNameOf(member);

    if (name === null) {
      continue;
    }

    const returnType = member.type === undefined
      ? 'any'
      : member.type.getText(source).replace(/\s+/g, ' ').trim();

    operations.set(name, { arity: member.parameters.length, returnType });
  }

  return operations;
}

function verifyEmitted(
  packageDir: string,
  model: Model,
  generated: readonly { method: string; arity: number }[],
  emittedPath: string,
): void {
  const emitted = parseEmitted(readFileSync(emittedPath, 'utf8'));
  const problems: string[] = [];

  for (const operation of model.operations) {
    const declared = emitted.get(operation.name);

    if (!declared) {
      problems.push(`the built module does not export "${operation.name}"`);
    } else if (declared.arity !== operation.args.length) {
      problems.push(
        `"${operation.name}" took ${declared.arity} arguments in the built module, `
        + `the config declares ${operation.args.length}`,
      );
    }
  }

  for (const operation of generated) {
    const declared = emitted.get(operation.method);

    if (!declared) {
      problems.push(`the built module does not export "${operation.method}"`);
    } else if (declared.arity !== operation.arity) {
      problems.push(
        `"${operation.method}" took ${declared.arity} arguments in the built module, `
        + `the generator declares ${operation.arity}`,
      );
    }
  }

  if (problems.length > 0) {
    fail(
      'the built bindings no longer match the config:\n  - '
      + `${problems.join('\n  - ')}\n`
      + 'Update the config (and the facade implementation) deliberately.',
    );
  }

  log(
    `verified ${model.operations.length + generated.length} operations against `
    + `${path.relative(packageDir, emittedPath)}`,
  );
}

function render(
  paths: GeneratedPaths,
  options: Options,
  model: Model,
  release: string,
  ast: AstIndex,
  upstream: ReadonlyMap<string, UpstreamDoc>,
  vocabularies: readonly NameVocabulary[],
): Outputs {
  const symbols = calledSymbols(model);
  const recorded = readSignatures(paths.coverage);

  if (!options.update && recorded === null) {
    fail(
      `the coverage report is missing at ${path.relative(options.packageDir, paths.coverage)}; `
      + 'run `mise run generate` to write it.',
    );
  }

  const drift = checkSignatures(ast, recorded ?? {}, options.update ? [] : symbols);

  if (drift.length > 0) {
    fail(
      `${drift.map((entry) => `${entry.symbol}: recorded as [${entry.expected.join(' | ')}] `
        + `but now [${entry.actual.join(' | ')}]`).join('\n  - ')}\n`
      + 'A signature change is a behavioural change: review it, then run '
      + '`mise run generate` to record it.',
    );
  }

  const members = capsMembers(ast);
  const projectionRenames = model.overrides?.projections ?? {};
  const { operations, rejections, staleOverrides } = classifyAll(
    ast.functions,
    new Set(model.operations.flatMap((operation) => operation.calls)),
    createProjectionResolver(ast, projectionRenames),
    model.overrides?.operations ?? {},
  );
  const stale = [...staleOverrides, ...staleProjectionRenames(projectionRenames, projections(operations))];

  if (stale.length > 0) {
    fail(`overrides in ${path.basename(options.config)} that rename nothing:\n  - ${stale.join('\n  - ')}`);
  }

  const facts = operations.map((operation) => operationFacts(operation, members));
  const unknownMembers = model.operations
    .filter((operation) => operation.capsMember !== undefined && !members.has(operation.capsMember))
    .map((operation) => `${operation.name}: ${operation.capsMember}`);

  if (unknownMembers.length > 0) {
    fail(`capsMember names no struct rig_caps function pointer: ${unknownMembers.join(', ')}`);
  }

  const signatures: Record<string, readonly string[]> = {};

  for (const symbol of symbols) {
    signatures[symbol] = signatureOf(ast, symbol);
  }

  const coverage = {
    $comment:
      'Generated coverage report: which upstream declarations this generator binds and '
      + 'which it refuses, and why, plus the pinned signature of every symbol a bespoke '
      + 'operation calls.  Diff it on an upstream bump to see what changed.',
    release,
    summary: {
      bespoke: model.operations.length,
      generated: operations.length,
      refused: rejections.length,
    },
    signatures,
    generated: facts
      .map(({ operation, gate }) => ({
        symbol: operation.symbol,
        method: operation.method,
        shape: operation.shape,
        result: operation.result,
        capability: gate === null ? null : operation.method,
      }))
      .sort((a, b) => a.symbol.localeCompare(b.symbol)),
    refused: [...rejections]
      .map((rejection) => ({ symbol: rejection.symbol, reason: rejection.reason }))
      .sort((a, b) => a.symbol.localeCompare(b.symbol)),
  };

  const files: (readonly [string, string])[] = [
    [paths.results, emitResults(model, facts)],
    [paths.codecs, emitCodecs(vocabularies)],
    [paths.transport, emitTransportTypes(vocabularies, lineSettingsTypes(model, vocabularies))],
    [paths.policy, emitPolicyHeader(model, vocabularies)],
    [paths.operations, emitOperations(facts)],
    [paths.capabilities, emitCapabilities(model, facts)],
    [paths.embind, emitEmbind(model, facts)],
    [paths.contract, emitContract(model, facts, {
      upstream,
      parameters: (symbol) => {
        const declarations = ast.functions.get(symbol);

        return declarations ? canonicalDeclaration(declarations).params.map((param) => param.name) : [];
      },
    })],
    [paths.names, emitNames(vocabularies, [
      ...errorMessageConstants(vocabularies, loadErrorMessages(options.sources)),
      ...policyConstants(model, vocabularies),
    ])],
    [paths.coverage, `${JSON.stringify(coverage, null, 2)}\n`],
    ...emitMethodFiles(model, facts).map(
      ({ path: relative, content }) => [path.join(paths.methodsDir, relative), content] as const,
    ),
  ];

  return {
    files,
    generated: facts.map(({ operation, needsHandle, parameters }) => ({
      method: operation.method,
      arity: (needsHandle ? 1 : 0) + parameters.length,
    })),
  };
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const packageDir = path.resolve(options.packageDir);
  const paths = outputPaths(packageDir);
  const { model, release } = loadConfig(path.resolve(options.config));
  const ast = loadAst(path.resolve(options.headers), [path.join(packageDir, 'native', 'web_serial.h')]);
  const upstream = loadUpstreamDocs(path.resolve(options.sources));
  const vocabularies = loadVocabularies(path.resolve(options.sources), ast.enums);
  const built = render(paths, options, model, release, ast, upstream, vocabularies);
  const files = built.files;

  /* Method files are regrouped as operations move between families, so a file
   * that is no longer emitted is stale and must go. */
  const emittedFiles = new Set(files.map(([file]) => file));
  const extraMethods = existsSync(paths.methodsDir)
    ? readdirSync(paths.methodsDir)
      .filter((name) => name.endsWith('.ts'))
      .map((name) => path.join(paths.methodsDir, name))
      .filter((file) => !emittedFiles.has(file))
    : [];

  if (options.update) {
    for (const [file, content] of files) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, content);
    }

    for (const file of extraMethods) {
      unlinkSync(file);
    }

    log(`wrote ${files.length} generated files`);
  } else {
    const stale = files
      .filter(([file, content]) => !existsSync(file) || readFileSync(file, 'utf8') !== content)
      .map(([file]) => path.relative(packageDir, file));

    if (stale.length > 0 || extraMethods.length > 0) {
      const extra = extraMethods.map((file) => path.relative(packageDir, file));
      fail(
        `generated files are out of date: ${[...stale, ...extra].join(', ')}\n`
        + 'Run `mise run generate`, then rebuild.',
      );
    }

    log('generated files are current');
  }

  if (options.emitted) {
    verifyEmitted(packageDir, model, built.generated, path.resolve(options.emitted));
  }
}

/* Importable without side effects: the unit tests load `parseEmitted` from
 * this module, and running the generator there would parse the test runner's
 * argv and exit. */
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
