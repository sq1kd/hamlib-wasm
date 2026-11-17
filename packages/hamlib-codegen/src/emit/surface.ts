// SPDX-License-Identifier: MIT

/**
 * The public TypeScript shape of every operation: its parameters and what it
 * resolves to.  The contract declares it and the method classes implement
 * it, so both read it from here.
 *
 * Authored as TypeScript and run directly by Node's type stripping, so this
 * file must stay erasable (no enums, namespaces or parameter properties).
 */
import type { ConfigPair, Model, ModelOperation } from '../config.ts';
import { recordOfVocabulary } from '../enums.ts';
import {
  bespokeResultFields,
  parameterNames,
  publicProjection,
  tsArgument,
  type Imports,
  type OperationFacts,
} from './common.ts';

export interface Signature {
  /** `name: Type` entries. */
  readonly parameters: string;
  /** The type the method's promise resolves to. */
  readonly result: string;
}

/** What a generated operation's public method takes and resolves to. */
export function generatedSignature(facts: OperationFacts, imports: Imports): Signature {
  const parameters = facts.parameters
    .map((parameter) => `${parameter.name}: ${imports.ts(parameter.binding)}`)
    .join(', ');

  if (facts.operation.shape === 'set') {
    return { parameters, result: 'void' };
  }

  if (facts.projection) {
    return { parameters, result: imports.type('confparams', facts.projection.element) };
  }

  if (facts.unwrapsValue) {
    return { parameters, result: imports.ts((facts.fields[0] as OperationFacts['fields'][number]).binding) };
  }

  const fields = facts.fields.map((field) => `${field.name}: ${imports.ts(field.binding)}`).join('; ');

  return { parameters, result: `{ ${fields} }` };
}

/** The TypeScript type of a config pair: its narrowed vocabulary, or its boundary type. */
export function pairType([, type, narrowed]: ConfigPair, imports: Imports): string {
  return narrowed === undefined ? tsArgument(type) : imports.narrowed(narrowed);
}

/** The public parameters of a bespoke operation: its native arguments minus the handle. */
export function bespokeParameters(operation: ModelOperation): readonly ConfigPair[] {
  const [handle, ...rest] = operation.args;

  if (handle?.[0] !== 'handle') {
    throw new Error(`rig operation ${operation.name} must take the handle first`);
  }

  const names = parameterNames(rest.map(([name]) => name));

  return rest.map(([, type, narrowed], index) =>
    (narrowed === undefined ? [names[index] as string, type] : [names[index] as string, type, narrowed]));
}

/**
 * The one field a bespoke result carries besides `code` and `error`, or
 * `null` for a code-only result.
 */
export function bespokeValue(model: Model, operation: ModelOperation): ConfigPair | null {
  const values = bespokeResultFields(model, operation.result)
    .filter(([name]) => name !== 'code' && name !== 'error');

  if (values.length > 1) {
    throw new Error(`${operation.name}: a bespoke result carries one value, ${operation.result} has ${values.length}`);
  }

  return values[0] ?? null;
}

/** The public projection a bespoke vector result is drained through. */
export function bespokeVector(operation: ModelOperation): ReturnType<typeof publicProjection> & object {
  const projection = publicProjection(operation.result.slice(0, -2));

  if (!projection) {
    throw new Error(`${operation.name}: no public projection drains ${operation.result}`);
  }

  return projection;
}

export function bespokeSignature(model: Model, operation: ModelOperation, imports: Imports): Signature {
  const parameters = bespokeParameters(operation)
    .map((pair) => `${pair[0]}: ${pairType(pair, imports)}`)
    .join(', ');

  if (operation.result.endsWith('[]')) {
    return { parameters, result: `${imports.type('confparams', bespokeVector(operation).element)}[]` };
  }

  const value = bespokeValue(model, operation);

  return { parameters, result: value === null ? 'void' : pairType(value, imports) };
}

/**
 * The expression a string result field becomes in the public surface.
 * `String()` unboxes the `EmbindString` the declaration names; a vocabulary
 * whose names the C side checks (a generated codec) is narrowed through
 * `named()`, which fails on anything else, and one an upstream stringifier
 * spells is typed by its table.
 */
export function publicString(access: string, type: string, operation: string, imports: Imports): string {
  if (type === 'string') {
    return `String(${access})`;
  }

  const record = recordOfVocabulary(type);

  if (!record?.names) {
    throw new Error(`${type} is not a generated vocabulary`);
  }

  return record.codec === 'generated'
    ? `this.named(${imports.value('names', record.names.constant)}, ${access}, '${operation}')`
    : `String(${access}) as ${imports.narrowed(type)}`;
}
