// SPDX-License-Identifier: MIT

/**
 * Compiler-accurate view of the pinned upstream headers.
 *
 * Everything the generator needs to know about Hamlib's public types and
 * functions comes from clang's own AST of the pinned release, not from a
 * hand-maintained table or a regular-expression heuristic.  Running clang is
 * the only way to be certain what a declaration means after typedefs, macros
 * and conditional compilation have been resolved, so an unmapped type is a
 * hard failure rather than a guess.
 *
 * The compiler and sysroot are taken from the pinned emsdk on PATH (the same
 * one that builds the Wasm module), and the translation unit is compiled for
 * `wasm32-unknown-emscripten`, so the AST matches the target being shipped.
 *
 * Authored as TypeScript and run directly by Node's type stripping, so this
 * file must stay erasable (no enums, namespaces or parameter properties).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface AstParam {
  readonly name: string;
  readonly qualType: string;
}

export interface AstFunction {
  readonly name: string;
  /** Return type, e.g. `int`, `const char *`. */
  readonly result: string;
  readonly params: readonly AstParam[];
  readonly variadic: boolean;
}

export interface AstEnumConstant {
  readonly name: string;
  /** The value clang evaluated, or the previous constant's plus one. */
  readonly value: number;
}

export interface AstEnum {
  readonly name: string;
  /** How C code names the type: `enum serial_parity_e`, or the typedef `ptt_t`. */
  readonly spelling: string;
  readonly constants: readonly AstEnumConstant[];
}

export interface AstRecordField {
  readonly name: string;
  readonly qualType: string;
}

export interface AstRecord {
  readonly name: string;
  readonly fields: readonly AstRecordField[];
}

export interface AstIndex {
  /** Every declaration of a function, keyed by symbol name. */
  readonly functions: ReadonlyMap<string, readonly AstFunction[]>;
  readonly enums: ReadonlyMap<string, AstEnum>;
  readonly records: ReadonlyMap<string, AstRecord>;
  readonly typedefs: ReadonlyMap<string, string>;
}

/**
 * The subset of a `clang -ast-dump=json` node this module reads.  Exported so
 * tests can build AST fixtures in clang's own shape instead of invoking clang.
 */
export interface JsonNode {
  readonly id?: string;
  readonly kind?: string;
  readonly name?: string;
  readonly type?: { readonly qualType?: string };
  readonly variadic?: boolean;
  readonly inner?: readonly JsonNode[];
  readonly storageClass?: string;
  readonly isImplicit?: boolean;
  /** Set by clang on a record definition, absent on a forward declaration. */
  readonly completeDefinition?: boolean;
  /**
   * On the type a `typedef enum { ... } name;` wraps, the anonymous enum it
   * owns: `decl` with `isTagOwned` (an `EnumType`), or `ownedTagDecl` (an
   * `ElaboratedType`), depending on the clang release.
   */
  readonly ownedTagDecl?: { readonly id?: string };
  readonly decl?: { readonly id?: string };
  readonly isTagOwned?: boolean;
  /** The evaluated value of a `ConstantExpr`, as decimal text. */
  readonly value?: string;
}

function fail(message: string): never {
  process.stderr.write(`[codegen:ast] error: ${message}\n`);
  process.exit(1);
}

interface Emsdk {
  readonly clangxx: string;
  readonly sysrootInclude: string;
}

/**
 * Locate the clang and sysroot that belong to the emsdk currently on PATH.
 *
 * The generator must use the pinned toolchain: a host clang would parse a
 * different libc and a different target, so the AST would not describe the
 * module being built.
 */
export function resolveEmsdk(): Emsdk {
  let emcc: string;

  try {
    emcc = execFileSync('which', ['emcc'], { encoding: 'utf8' }).trim();
  } catch {
    fail('emcc is not on PATH; run this through `mise run generate`.');
  }

  const emscriptenDir = path.dirname(emcc);
  const clangxx = path.resolve(emscriptenDir, '..', 'bin', 'clang++');
  const sysrootInclude = path.resolve(emscriptenDir, 'cache', 'sysroot', 'include');

  if (!existsSync(clangxx)) {
    fail(`the emsdk clang++ is missing at ${clangxx}`);
  }

  if (!existsSync(sysrootInclude)) {
    fail(`the emsdk sysroot is missing at ${sysrootInclude}`);
  }

  return { clangxx, sysrootInclude };
}

function asNode(value: unknown): JsonNode {
  return value as JsonNode;
}

function walk(node: JsonNode, visit: (node: JsonNode) => void): void {
  visit(node);

  if (!node.inner) {
    return;
  }

  for (const child of node.inner) {
    walk(child, visit);
  }
}

/** The return type is everything before the parameter list in a function type. */
function returnTypeOf(node: JsonNode): string {
  const qualType = node.type?.qualType ?? '';
  /* Clang writes `int (RIG *, …)` for a scalar return but `const char *(…)`
   * for a pointer return, so split at the first paren, not at " (". */
  const open = qualType.indexOf('(');

  return (open < 0 ? qualType : qualType.slice(0, open)).trim();
}

function paramsOf(node: JsonNode): AstParam[] {
  const params: AstParam[] = [];

  for (const child of node.inner ?? []) {
    if (child.kind !== 'ParmVarDecl') {
      continue;
    }

    params.push({
      name: child.name ?? '',
      qualType: (child.type?.qualType ?? '').trim(),
    });
  }

  return params;
}

function functionOf(node: JsonNode): AstFunction {
  return {
    name: node.name ?? '',
    result: returnTypeOf(node),
    params: paramsOf(node),
    variadic: node.variadic === true,
  };
}

/** The value clang folded an enum initializer to: its first `ConstantExpr`. */
function initializerValue(constant: JsonNode): number | null {
  let value: number | null = null;

  walk(constant, (node) => {
    if (value === null && node.kind === 'ConstantExpr' && node.value !== undefined) {
      value = Number(node.value);
    }
  });

  return value;
}

function enumOf(node: JsonNode, name: string, spelling: string): AstEnum {
  const constants: AstEnumConstant[] = [];
  let next = 0;

  for (const child of node.inner ?? []) {
    if (child.kind === 'EnumConstantDecl') {
      const value = initializerValue(child) ?? next;
      constants.push({ name: child.name ?? '', value });
      next = value + 1;
    }
  }

  return { name, spelling, constants };
}

function recordOf(node: JsonNode): AstRecord {
  const fields: AstRecordField[] = [];

  for (const child of node.inner ?? []) {
    if (child.kind === 'FieldDecl') {
      fields.push({
        name: child.name ?? '',
        qualType: (child.type?.qualType ?? '').trim(),
      });
    }
  }

  return { name: node.name ?? '', fields };
}

/**
 * Index a clang AST dump.
 *
 * Exported for the unit tests, which feed hand-built nodes in clang's JSON
 * shape; `loadAst` is the production path that shells out to clang.
 */
export function indexAst(root: JsonNode): AstIndex {
  const functions = new Map<string, AstFunction[]>();
  const enums = new Map<string, AstEnum>();
  const records = new Map<string, AstRecord>();
  const completeRecords = new Set<string>();
  const typedefs = new Map<string, string>();
  /* `typedef enum { ... } powerstat_t;` declares an unnamed enum and names it
   * through the typedef that follows; it is indexed under that name. */
  const anonymousEnums = new Map<string, JsonNode>();

  walk(root, (node) => {
    switch (node.kind) {
      case 'FunctionDecl': {
        if (!node.name || node.isImplicit) {
          return;
        }

        const list = functions.get(node.name) ?? [];
        list.push(functionOf(node));
        functions.set(node.name, list);
        break;
      }

      case 'EnumDecl': {
        if (node.name && !enums.has(node.name)) {
          enums.set(node.name, enumOf(node, node.name, `enum ${node.name}`));
        } else if (!node.name && node.id) {
          anonymousEnums.set(node.id, node);
        }

        break;
      }

      case 'RecordDecl':
      case 'CXXRecordDecl': {
        if (!node.name) {
          break;
        }

        const existing = records.get(node.name);
        const record = recordOf(node);
        const isDefinition = node.completeDefinition === true;

        /* A forward declaration (`struct foo;`) can precede the definition and
         * carries no fields.  Keep the complete definition - clang marks it,
         * and a field-bearing node is the best fallback - so a projection is
         * never silently empty. */
        if (
          existing === undefined
          || (isDefinition && !completeRecords.has(node.name))
          || record.fields.length > existing.fields.length
        ) {
          records.set(node.name, record);

          if (isDefinition) {
            completeRecords.add(node.name);
          }
        }

        break;
      }

      case 'TypedefDecl': {
        if (node.name && node.type?.qualType) {
          typedefs.set(node.name, node.type.qualType.trim());
        }

        const wrapped = node.inner?.[0];
        const owned = wrapped?.ownedTagDecl?.id ?? (wrapped?.isTagOwned ? wrapped.decl?.id : undefined);
        const anonymous = owned === undefined ? undefined : anonymousEnums.get(owned);

        if (node.name && anonymous && !enums.has(node.name)) {
          enums.set(node.name, enumOf(anonymous, node.name, node.name));
        }

        break;
      }

      default:
        break;
    }
  });

  return { functions, enums, records, typedefs };
}

/**
 * Dump and index the AST of `hamlib/rig.h` from the pinned headers, plus any
 * project header whose declarations the generator also reads (the serial
 * transport's status codes).
 *
 * A scratch translation unit is created so clang is invoked exactly as it
 * would be for a real source file; the JSON is then parsed and reduced to the
 * declarations the generator reasons about.
 */
export function loadAst(includeDir: string, projectHeaders: readonly string[] = []): AstIndex {
  const rigHeader = path.join(includeDir, 'hamlib', 'rig.h');

  if (!existsSync(rigHeader)) {
    fail(`the upstream headers are missing at ${rigHeader}`);
  }

  const { clangxx, sysrootInclude } = resolveEmsdk();
  const scratch = mkdtempSync(path.join(tmpdir(), 'hamlib-ast-'));

  try {
    const tu = path.join(scratch, 'tu.cpp');
    writeFileSync(tu, ['<hamlib/rig.h>', ...projectHeaders.map((header) => JSON.stringify(header))]
      .map((header) => `#include ${header}\n`)
      .join(''));

    let stdout: string;

    try {
      stdout = execFileSync(
        clangxx,
        [
          '--target=wasm32-unknown-emscripten',
          '-fsyntax-only',
          '-x',
          'c++',
          '-std=c++17',
          `-isystem${sysrootInclude}`,
          `-I${includeDir}`,
          '-Xclang',
          '-ast-dump=json',
          tu,
        ],
        { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 },
      );
    } catch (error) {
      fail(`clang could not parse hamlib/rig.h: ${String(error)}`);
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(stdout);
    } catch (error) {
      fail(`the clang AST was not valid JSON: ${String(error)}`);
    }

    return indexAst(asNode(parsed));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Read a source file the AST refers to, for drift reporting. */
export function readHeader(includeDir: string, relative: string): string {
  return readFileSync(path.join(includeDir, relative), 'utf8');
}
