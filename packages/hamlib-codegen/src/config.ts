// SPDX-License-Identifier: MIT

/**
 * Load and validate `hamlib.config.yaml`.
 *
 * The config is hand-authored and never rewritten by a tool: it holds the
 * pinned release (also read by the native build), the value objects that cross
 * the Embind boundary, the operations that need a bespoke facade body, and the
 * renames for the mechanically generated surface.
 *
 * Authored as TypeScript and run directly by Node's type stripping, so this
 * file must stay erasable (no enums, namespaces or parameter properties).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { parse } from 'yaml';

import type { OperationOverride } from './classify.ts';
import { VOCABULARY_TYPES } from './enums.ts';

/** How a value object field crosses the Embind boundary. */
const BOUNDARY_TYPES: ReadonlySet<string> = new Set(['int', 'double', 'bool', 'string']);

/**
 * A `["name", "type"]` pair, optionally narrowed: `["state", "string",
 * "PttState"]` crosses Embind as a string and is typed with the vocabulary
 * named third (see names.ts).
 */
export type ConfigPair = readonly [string, string, string?];

export interface ModelResult {
  readonly binding?: string;
  readonly fields: readonly ConfigPair[];
}

/**
 * Where an operation lives in the public surface.
 *
 * `rig` operations become typed methods on a connected rig; `module`
 * operations are the runtime's own primitives (module bootstrap, port
 * registration, open/close ownership) and are never part of the API.
 */
export type OperationScope = 'rig' | 'module';

export interface ModelOperation {
  readonly name: string;
  readonly scope: OperationScope;
  readonly args: readonly ConfigPair[];
  readonly result: string;
  /**
   * The upstream symbols the bespoke facade body calls.  They are excluded
   * from generation, and their pinned signatures are recorded in the coverage
   * report so a drift fails the build.
   */
  readonly calls: readonly string[];
  /**
   * A `ModelInfo` flag the operation is gated on, for the operations the
   * `rig_caps` capacity matrix cannot describe (a backend that drives PTT over
   * the serial RTS/DTR line declares no `get_ptt`/`set_ptt` function pointer).
   */
  readonly capability?: string;
  /**
   * The `struct rig_caps` function pointer the operation needs, which puts it
   * in the generated capability matrix like a generated operation: the
   * bespoke Morse bodies call the backend's `send_morse`/`stop_morse`.
   */
  readonly capsMember?: string;
}

export interface ModelVector {
  readonly type: string;
  readonly binding: string;
}

export interface Model {
  readonly results: Readonly<Record<string, ModelResult>>;
  readonly vectors: readonly ModelVector[];
  readonly operations: readonly ModelOperation[];
  /**
   * The capability flags an operation may be gated on: the `can*` fields of
   * the `ModelInfo` catalogue value object.
   */
  readonly flags: readonly string[];
  /** Declarative renames for the mechanically generated surface. */
  readonly overrides?: {
    /** Per-symbol method/field renames for generated operations. */
    readonly operations?: Readonly<Record<string, OperationOverride>>;
    /** Per-projection-tag field renames, keyed by the C member name. */
    readonly projections?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  };
}

export interface CodegenConfig {
  readonly path: string;
  /** The pinned Hamlib release the surface is generated against. */
  readonly release: string;
  readonly model: Model;
}

function fail(file: string, message: string): never {
  process.stderr.write(`[codegen:config] error: ${path.basename(file)}: ${message}\n`);
  process.exit(1);
}

function asObject(file: string, value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(file, `${what} must be a mapping`);
  }

  return value as Record<string, unknown>;
}

function asArray(file: string, value: unknown, what: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    fail(file, `${what} must be a list`);
  }

  return value;
}

function asString(file: string, value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail(file, `${what} must be a non-empty string`);
  }

  return value;
}

/**
 * A `["name", "type"]` pair.  The types are the Embind boundary types, so a
 * typo is caught here rather than becoming `number` in the emitted contract.
 */
function asPair(file: string, value: unknown, what: string): ConfigPair {
  const pair = asArray(file, value, what);

  if (pair.length !== 2 && pair.length !== 3) {
    fail(file, `${what} must be a ["name", "type"] pair or ["name", "string", "<Vocabulary>"]`);
  }

  const name = asString(file, pair[0], `${what}[0]`);
  const type = asString(file, pair[1], `${what}[1]`);

  if (!BOUNDARY_TYPES.has(type)) {
    fail(file, `${what} has unknown type "${type}"`);
  }

  if (pair.length === 3) {
    const narrowed = asString(file, pair[2], `${what}[2]`);

    if (type !== 'string' || !VOCABULARY_TYPES.has(narrowed)) {
      fail(file, `${what}: only a string can be narrowed, to one of ${[...VOCABULARY_TYPES].join(', ')}`);
    }

    return [name, type, narrowed];
  }

  return [name, type];
}

function readResults(file: string, value: unknown): Readonly<Record<string, ModelResult>> {
  const results: Record<string, ModelResult> = {};

  for (const [name, entry] of Object.entries(asObject(file, value, 'results'))) {
    const result = asObject(file, entry, `results.${name}`);
    const binding = result.binding === undefined
      ? undefined
      : asString(file, result.binding, `results.${name}.binding`);
    const fields = asArray(file, result.fields, `results.${name}.fields`)
      .map((field, index) => asPair(file, field, `results.${name}.fields[${index}]`));

    results[name] = { ...(binding === undefined ? {} : { binding }), fields };
  }

  return results;
}

function readVectors(file: string, value: unknown): readonly ModelVector[] {
  return asArray(file, value, 'vectors').map((entry, index) => {
    const vector = asObject(file, entry, `vectors[${index}]`);

    return {
      type: asString(file, vector.type, `vectors[${index}].type`),
      binding: asString(file, vector.binding, `vectors[${index}].binding`),
    };
  });
}

function readOperations(
  file: string,
  value: unknown,
  flags: readonly string[],
): readonly ModelOperation[] {
  const seen = new Set<string>();

  return asArray(file, value, 'operations').map((entry, index) => {
    const where = `operations[${index}]`;
    const operation = asObject(file, entry, where);
    const name = asString(file, operation.name, `${where}.name`);
    const scope = asString(file, operation.scope, `${where}.scope`);
    const result = asString(file, operation.result, `${where}.result`);

    if (scope !== 'rig' && scope !== 'module') {
      fail(file, `${where}.scope must be "rig" or "module"`);
    }

    if (seen.has(name)) {
      fail(file, `${where}.name duplicates the method name "${name}"`);
    }

    seen.add(name);

    const calls = asArray(file, operation.calls ?? [], `${where}.calls`)
      .map((symbol, position) => asString(file, symbol, `${where}.calls[${position}]`));
    const capability = operation.capability === undefined
      ? undefined
      : asString(file, operation.capability, `${where}.capability`);

    if (capability !== undefined && !flags.includes(capability)) {
      fail(
        file,
        `${where}.capability must be a ModelInfo flag (${flags.join(', ')}), `
        + `not "${capability}"`,
      );
    }

    const capsMember = operation.capsMember === undefined
      ? undefined
      : asString(file, operation.capsMember, `${where}.capsMember`);

    if (capability !== undefined && capsMember !== undefined) {
      fail(file, `${where} is gated either by a capability flag or by a rig_caps member, not both`);
    }

    return {
      name,
      scope,
      args: asArray(file, operation.args, `${where}.args`)
        .map((argument, position) => asPair(file, argument, `${where}.args[${position}]`)),
      result,
      calls,
      ...(capability === undefined ? {} : { capability }),
      ...(capsMember === undefined ? {} : { capsMember }),
    };
  });
}

function readOverrides(file: string, value: unknown): Model['overrides'] {
  const overrides = asObject(file, value, 'overrides');
  const operations: Record<string, OperationOverride> = {};
  const projections: Record<string, Record<string, string>> = {};

  for (const [symbol, entry] of Object.entries(
    asObject(file, overrides.operations ?? {}, 'overrides.operations'),
  )) {
    const override = asObject(file, entry, `overrides.operations.${symbol}`);
    const fields: Record<string, string> = {};

    for (const [field, renamed] of Object.entries(
      asObject(file, override.fields ?? {}, `overrides.operations.${symbol}.fields`),
    )) {
      fields[field] = asString(file, renamed, `overrides.operations.${symbol}.fields.${field}`);
    }

    operations[symbol] = {
      ...(override.method === undefined
        ? {}
        : { method: asString(file, override.method, `overrides.operations.${symbol}.method`) }),
      ...(Object.keys(fields).length === 0 ? {} : { fields }),
    };
  }

  for (const [tag, entry] of Object.entries(
    asObject(file, overrides.projections ?? {}, 'overrides.projections'),
  )) {
    const renames: Record<string, string> = {};

    for (const [member, renamed] of Object.entries(
      asObject(file, entry, `overrides.projections.${tag}`),
    )) {
      renames[member] = asString(file, renamed, `overrides.projections.${tag}.${member}`);
    }

    projections[tag] = renames;
  }

  return {
    ...(Object.keys(operations).length === 0 ? {} : { operations }),
    ...(Object.keys(projections).length === 0 ? {} : { projections }),
  };
}

/** Read the codegen half of the config: everything except `release`. */
export function loadConfig(file: string): CodegenConfig {
  let parsed: unknown;

  try {
    parsed = parse(readFileSync(file, 'utf8'));
  } catch (error) {
    fail(file, `not valid YAML: ${String(error)}`);
  }

  const root = asObject(file, parsed, 'the config');
  const release = asObject(file, root.release, 'release');
  const results = readResults(file, root.results);
  /* The capability flags an operation may be gated on are the `can*` fields of
   * the catalogue value object, so the config validates them against itself. */
  const flags = (results.ModelInfo?.fields ?? [])
    .map(([name]) => name)
    .filter((name) => name.startsWith('can'));

  return {
    path: file,
    release: asString(file, release.version, 'release.version'),
    model: {
      results,
      vectors: readVectors(file, root.vectors),
      operations: readOperations(file, root.operations, flags),
      flags,
      overrides: readOverrides(file, root.overrides ?? {}),
    },
  };
}
