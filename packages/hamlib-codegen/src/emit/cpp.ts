// SPDX-License-Identifier: MIT

/**
 * The generated C++ the facade includes:
 *
 *   native/generated/codecs.h          name codecs for enums Hamlib has none for
 *   native/generated/results.inc       every value object the boundary returns
 *   native/generated/operations.inc    generated Facade method bodies
 *   native/generated/capabilities.inc  the rig_caps capability matrix
 *   native/generated/embind.inc        Embind registrations (bespoke + generated)
 *
 * A JavaScript value crosses into C through {@link convertIn} and a C value
 * comes back through {@link convertOut}, whatever the operation's shape, so
 * every argument is validated the same way and every result packed the same
 * way.
 *
 * Authored as TypeScript and run directly by Node's type stripping, so this
 * file must stay erasable (no enums, namespaces or parameter properties).
 */
import type { GeneratedOperation } from '../classify.ts';
import type { Model } from '../config.ts';
import { codecOf, type UpstreamCodec } from '../enums.ts';
import type { NameVocabulary } from '../names.ts';
import type { TypeBinding } from '../types.ts';
import {
  cppArgument,
  fieldCpp,
  GENERATED_HEADER,
  outName,
  RETURNED,
  resultObjects,
  SOURCE,
  structSpec,
  usedProjections,
  type OperationFacts,
  type ValueObject,
} from './common.ts';

/**
 * `native/generated/codecs.h`: the name codecs of the enums Hamlib has none
 * for, in C both the facade and the serial transport compile.  A parser
 * answers its codec's `-1` sentinel for a name it does not know, a
 * stringifier `NULL` for a value it does not know.
 */
export function emitCodecs(vocabularies: readonly NameVocabulary[]): string {
  const lines: string[] = [GENERATED_HEADER, '', '#ifndef HAMLIB_WASM_CODECS_H', '#define HAMLIB_WASM_CODECS_H', ''];

  lines.push('#include <string.h>', '', '#include "hamlib/rig.h"', '');

  for (const vocabulary of vocabularies) {
    const { constants, spelling } = vocabulary;

    if (vocabulary.record.codec !== 'generated' || !constants || !spelling) {
      continue;
    }

    const codec = codecOf(vocabulary.record, spelling) as UpstreamCodec;

    lines.push(`static inline ${spelling} ${codec.parse}(const char *name)`);
    lines.push('{');
    vocabulary.names.forEach((name, index) => {
      lines.push(`    if (strcmp(name, "${name}") == 0) { return ${constants[index]?.name}; }`);
    });
    lines.push(`    return ${codec.none};`);
    lines.push('}');
    lines.push('');
    lines.push(`static inline const char *${codec.str}(${spelling} value)`);
    lines.push('{');
    lines.push('    switch (value)');
    lines.push('    {');
    vocabulary.names.forEach((name, index) => {
      lines.push(`    case ${constants[index]?.name}: return "${name}";`);
    });
    lines.push('    default: return NULL;');
    lines.push('    }');
    lines.push('}');
    lines.push('');
  }

  lines.push('#endif /* HAMLIB_WASM_CODECS_H */');

  return `${lines.join('\n')}\n`;
}

function emitValueObjectStruct(object: ValueObject): string[] {
  return [
    `struct ${object.name}`,
    '{',
    ...object.fields.map((field) => `    ${fieldCpp(field.boundary)} ${field.name};`),
    '};',
    '',
  ];
}

export function emitResults(model: Model, facts: readonly OperationFacts[], sentinels: ReadonlyMap<string, string>): string {
  const lines = [GENERATED_HEADER, ''];

  for (const spec of usedProjections(facts)) {
    lines.push(...emitValueObjectStruct({
      name: spec.cpp,
      binding: spec.cpp,
      fields: spec.fields.map((field) => ({ name: field.name, boundary: field.binding.boundary })),
    }));
  }

  for (const object of resultObjects(model, facts)) {
    lines.push(...emitValueObjectStruct(object));
  }

  /* A projection a bespoke body returns in a vector gets the same packing as
   * a generated result, so a walked entry and a looked-up one agree. */
  for (const spec of usedProjections(facts).filter((candidate) =>
    model.vectors.some((vector) => vector.type === candidate.cpp))) {
    const context: Context = { result: spec.cpp, symbol: `project${spec.cpp}`, setting: null, sentinels };

    lines.push(`static inline ${spec.cpp} project${spec.cpp}(const ${spec.type} &source)`, '{');
    lines.push(`    ${spec.cpp} result{};`);

    for (const field of spec.fields) {
      if (field.binding.category === 'enum') {
        throw new Error(`${spec.cpp}.${field.name}: a vector element cannot fail on an unnamed value`);
      }

      lines.push(...convertOut(field.binding, `source.${field.member}`, `result.${field.name}`, context, field.charArray)
        .map((line) => `    ${line}`));
    }

    lines.push('    return result;', '}', '');
  }

  return `${lines.join('\n')}\n`;
}

/* ------------------------------------------------------------------ */
/* operations                                                          */
/* ------------------------------------------------------------------ */

/** Native local holding a converted argument; distinct from the parameter. */
function valueName(index: number): string {
  return `value${index}`;
}

/** The C++ parameter list of a generated operation's Embind function. */
export function cppParameters(facts: OperationFacts): string[] {
  return [
    ...(facts.needsHandle ? ['int handle'] : []),
    ...facts.parameters.map((parameter) => (parameter.binding.category === 'struct'
      ? `const ${structSpec(parameter.binding).cpp} & ${parameter.local}`
      : `${cppArgument(parameter.binding.boundary)} ${parameter.local}`)),
  ];
}

/** What a conversion writes to: a new local, or a member of a struct local. */
interface Target {
  readonly name: string;
  readonly declare: boolean;
}

/** What a conversion may need from its operation. */
interface Context {
  readonly result: string;
  readonly symbol: string;
  /** The `setting_t` local a `value_t` is interpreted against. */
  readonly setting: string | null;
  /** The name of each parser's sentinel, when its vocabulary names it (names.ts). */
  readonly sentinels: ReadonlyMap<string, string>;
}

/** A C string literal; vocabulary names never need escaping beyond this. */
function cString(text: string): string {
  return JSON.stringify(text);
}

function assign(target: Target, type: string, expression: string): string {
  const declaration = type.endsWith('*') ? `${type}${target.name}` : `${type} ${target.name}`;

  return `${target.declare ? declaration : target.name} = ${expression};`;
}

function settingOf(binding: TypeBinding, context: Context): string {
  if (context.setting === null) {
    throw new Error(`${context.symbol}: a value_t needs a setting_t argument to be read against`);
  }

  return `${binding.valuePredicate}(${context.setting})`;
}

/**
 * Convert the boundary value `source` into the C value Hamlib takes.  A name
 * Hamlib does not know, or a number an integer type cannot hold exactly,
 * fails the call with `-RIG_EINVAL` before it reaches Hamlib, wherever it
 * appears, a struct member included.
 */
function convertIn(binding: TypeBinding, source: string, target: Target, context: Context, charArray: number | null = null): string[] {
  if (binding.category === 'struct') {
    return [
      `${binding.native} ${target.name}{};`,
      ...structSpec(binding).fields.flatMap((field) => convertIn(
        field.binding,
        `${source}.${field.name}`,
        { name: `${target.name}.${field.member}`, declare: false },
        context,
        field.charArray,
      )),
    ];
  }

  if (charArray !== null) {
    return [`std::strncpy(${target.name}, ${source}.c_str(), sizeof(${target.name}) - 1);`];
  }

  if (binding.category === 'enum') {
    const sentinel = context.sentinels.get(binding.enumParse as string);
    const unknown = sentinel === undefined
      ? `${target.name} == ${binding.enumNone}`
      : `${target.name} == ${binding.enumNone} && ${source} != ${cString(sentinel)}`;

    return [
      assign(target, binding.native, `${binding.enumParse}(${source}.c_str())`),
      `if (${unknown}) { return failure<${context.result}>(-RIG_EINVAL); }`,
    ];
  }

  if (binding.valueAccess || binding.valuePredicate) {
    if (!target.declare) {
      throw new Error(`${context.symbol}: a value_t struct member is not supported`);
    }

    const float = `${target.name}.f = (float) ${source};`;
    const integer = checkedNumber(source, `${target.name}.i`, context);
    const store = binding.valueAccess === 'f'
      ? float
      : binding.valueAccess === 'i'
        ? integer
        : `if (${settingOf(binding, context)}) { ${float} } else ${integer}`;

    return [`value_t ${target.name}{};`, store];
  }

  if (binding.category === 'string') {
    return [assign(target, 'const char *', `${source}.c_str()`)];
  }

  if (binding.flag) {
    return [assign(target, binding.native, `${source} ? ${binding.flag.on} : ${binding.flag.off}`)];
  }

  if (binding.category === 'boolean') {
    return [assign(target, binding.native, source)];
  }

  return [
    ...(target.declare ? [`${binding.native} ${target.name}{};`] : []),
    checkedNumber(source, target.name, context),
  ];
}

/**
 * Store a JavaScript number in `destination` through the facade's
 * `fromNumber`, which refuses a fraction or an out-of-range value for an
 * integer type instead of truncating it.
 */
function checkedNumber(source: string, destination: string, context: Context): string {
  return `if (!fromNumber(${source}, &${destination})) { return failure<${context.result}>(-RIG_EINVAL); }`;
}

/**
 * Convert the C value `source` into the result field `destination`.  The
 * public type promises one of the vocabulary's names, so the sentinel is
 * reported by the name the vocabulary gives it (`rig_strrmode()` answers `""`
 * for `RIG_MODE_NONE`, which `mode_str[]` calls `"None"`), and any other value
 * the stringifier has no name for fails the call with `-RIG_EPROTO`.
 */
function convertOut(
  binding: TypeBinding,
  source: string,
  destination: string,
  context: Context,
  charArray: number | null,
): string[] {
  if (binding.category === 'enum') {
    const sentinel = context.sentinels.get(binding.enumParse as string);

    return [
      ...(sentinel === undefined ? [] : [`if (${source} == ${binding.enumNone}) { ${destination} = ${cString(sentinel)}; }`]),
      `${sentinel === undefined ? '' : 'else '}if (const char *text = ${binding.enumStr}(${source}); text != nullptr && *text != '\\0') { ${destination} = text; }`,
      `else { return failure<${context.result}>(-RIG_EPROTO, "${context.symbol} returned a ${binding.native} Hamlib does not name"); }`,
    ];
  }

  if (binding.category === 'string') {
    return [charArray === null
      ? `${destination} = textOrEmpty(${source});`
      : `${destination} = std::string(${source});`];
  }

  if (binding.category === 'boolean') {
    return [binding.flag ? `${destination} = ${source} != ${binding.flag.off};` : `${destination} = ${source};`];
  }

  if (binding.valueAccess) {
    return [`${destination} = (double) ${source}.${binding.valueAccess};`];
  }

  if (binding.valuePredicate) {
    return [`${destination} = ${settingOf(binding, context)} ? (double) ${source}.f : (double) ${source}.i;`];
  }

  return [`${destination} = (double) ${source};`];
}

function callArguments(operation: GeneratedOperation): string[] {
  let out = 0;

  return operation.plan.map((entry) => {
    switch (entry.kind) {
      case 'rig':
        return 'rig';
      case 'target-vfo':
        return 'RIG_VFO_CURR';
      case 'out':
        return `&${outName(out++)}`;
      case 'value':
        /* Hamlib passes every struct by pointer, so a built struct local is
         * handed over by address. */
        return operation.arguments[entry.argument]?.binding.category === 'struct'
          ? `&${valueName(entry.argument)}`
          : valueName(entry.argument);
      default:
        throw new Error(`unreachable plan for ${operation.symbol}`);
    }
  });
}

/** The body of a generated method, after the rig (if any) is in hand. */
function operationBody(facts: OperationFacts, sentinels: ReadonlyMap<string, string>): string[] {
  const { operation, result } = facts;
  const settingIndex = operation.arguments.findIndex((argument) => argument.binding.native === 'setting_t');
  const context: Context = {
    result,
    symbol: operation.symbol,
    setting: settingIndex >= 0 ? valueName(settingIndex) : null,
    sentinels,
  };
  const lines: string[] = [];
  const seeds: string[] = [];

  for (const [index, parameter] of facts.parameters.entries()) {
    const member = operation.arguments[index]?.member;

    if (member === undefined) {
      lines.push(...convertIn(parameter.binding, parameter.local, { name: valueName(index), declare: true }, context));
      continue;
    }

    /* A struct output upstream reads before it fills: the input lands in its member. */
    const output = operation.outputs.findIndex((candidate) => candidate.parameter === operation.arguments[index]?.parameter);
    seeds.push(...convertIn(parameter.binding, parameter.local, { name: `${outName(output)}.${member.name}`, declare: false }, context));
  }

  for (const [index, output] of operation.outputs.entries()) {
    lines.push(`${output.binding.native} ${outName(index)}{};`);
  }

  lines.push(...seeds);

  const call = `${operation.symbol}(${callArguments(operation).join(', ')})`;
  /* The projection never reads a freed member, so it goes before any return. */
  const frees = operation.outputs.flatMap((output, index) =>
    (output.frees ?? []).map((member) => `std::free(${outName(index)}.${member});`));
  const pack = facts.fields.flatMap((field) =>
    convertOut(field.binding, field.source, `result.${field.name}`, context, field.charArray));

  if (lines.length > 0) {
    lines.push('');
  }

  if (operation.shape !== 'pure') {
    lines.push(`int rc = ${call};`, ...frees, '', `if (rc != RIG_OK) { return failure<${result}>(rc); }`, '');
    lines.push(`${result} result = ok<${result}>();`, ...pack);
  } else if (operation.pure?.category === 'struct') {
    /* A lookup returns NULL when nothing matches. */
    lines.push(`const ${operation.pure.native} *${SOURCE} = ${call};`, '');
    lines.push(`if (!${SOURCE}) { return failure<${result}>(-RIG_EINVAL, "${operation.symbol} matched nothing"); }`, '');
    lines.push(`${result} result = ok<${result}>();`, ...pack);
  } else {
    lines.push(`const auto ${RETURNED} = ${call};`, `${result} result = ok<${result}>();`, ...pack);
  }

  lines.push('return result;');

  return lines;
}

function indent(lines: readonly string[], depth: number): string[] {
  return lines.map((line) => (line === '' ? '' : `${' '.repeat(depth)}${line}`));
}

function emitOperation(facts: OperationFacts, sentinels: ReadonlyMap<string, string>): string[] {
  const { result } = facts;
  const lines = [`    ${result} ${facts.operation.method}(${cppParameters(facts).join(', ')})`, '    {'];

  if (facts.needsHandle) {
    lines.push(`        return withRig<${result}>(handle, [&](RIG *rig)`);
    lines.push('        {');
    lines.push(...indent(operationBody(facts, sentinels), 12));
    lines.push('        });');
  } else {
    lines.push('        webserial_clear_error();', '');
    lines.push(...indent(operationBody(facts, sentinels), 8));
  }

  lines.push('    }');

  return lines;
}

export function emitOperations(facts: readonly OperationFacts[], sentinels: ReadonlyMap<string, string>): string {
  const lines: string[] = [GENERATED_HEADER, ''];

  for (const fact of facts) {
    lines.push(...emitOperation(fact, sentinels), '');
  }

  return `${lines.join('\n')}\n`;
}

/* ------------------------------------------------------------------ */
/* capabilities and Embind                                             */
/* ------------------------------------------------------------------ */

export function emitCapabilities(model: Model, facts: readonly OperationFacts[]): string {
  const lines: string[] = [GENERATED_HEADER, ''];

  lines.push('    std::vector<std::string> capabilities(int modelId)');
  lines.push('    {');
  lines.push('        std::vector<std::string> available;');
  lines.push('        const struct rig_caps *caps = rig_get_caps((rig_model_t) modelId);');
  lines.push('');
  lines.push('        if (!caps) { return available; }');
  lines.push('');

  const gated = [
    ...model.operations.flatMap((operation) =>
      (operation.capsMember === undefined ? [] : [[operation.name, operation.capsMember] as const])),
    ...facts.flatMap((fact) => (fact.gate === null ? [] : [[fact.operation.method, fact.gate] as const])),
  ];

  for (const [name, member] of gated) {
    lines.push(`        if (caps->${member} != NULL) { available.push_back("${name}"); }`);
  }

  for (const fact of facts.filter((candidate) => candidate.gate === null)) {
    lines.push(`        available.push_back("${fact.operation.method}");`);
  }

  lines.push('');
  lines.push('        return available;');
  lines.push('    }');

  return `${lines.join('\n')}\n`;
}

function emitValueObject(cppType: string, binding: string, fields: readonly string[]): string[] {
  const lines = [`    emscripten::value_object<${cppType}>("${binding}")`];

  for (const field of fields) {
    lines.push(`    .field("${field}", &${cppType}::${field})`);
  }

  lines[lines.length - 1] += ';';
  return lines;
}

function emitFunction(name: string, parameters: readonly string[], call: string): string[] {
  return [
    `    emscripten::function("${name}", +[](${parameters.join(', ')})`,
    '    {',
    `        return ${call};`,
    '    });',
  ];
}

export function emitEmbind(model: Model, facts: readonly OperationFacts[]): string {
  const lines: string[] = [GENERATED_HEADER];

  for (const object of resultObjects(model, facts)) {
    lines.push('', ...emitValueObject(object.name, object.binding, object.fields.map((field) => field.name)));
  }

  for (const spec of usedProjections(facts)) {
    lines.push('', ...emitValueObject(spec.cpp, spec.cpp, spec.fields.map((field) => field.name)));
  }

  for (const vector of model.vectors) {
    lines.push('', `    emscripten::register_vector<${vector.type}>("${vector.binding}");`);
  }

  lines.push('', '    emscripten::register_vector<std::string>("StringList");');
  lines.push('', ...emitFunction('capabilities', ['int modelId'], 'facade().capabilities(modelId)'));

  for (const operation of model.operations) {
    lines.push('', ...emitFunction(
      operation.name,
      operation.args.map(([name, type]) => `${cppArgument(type)} ${name}`),
      `facade().${operation.name}(${operation.args.map(([name]) => name).join(', ')})`,
    ));
  }

  for (const fact of facts) {
    const call = [...(fact.needsHandle ? ['handle'] : []), ...fact.parameters.map((parameter) => parameter.local)];

    lines.push('', ...emitFunction(
      fact.operation.method,
      cppParameters(fact),
      `facade().${fact.operation.method}(${call.join(', ')})`,
    ));
  }

  return `${lines.join('\n')}\n`;
}
