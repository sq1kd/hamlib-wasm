// SPDX-License-Identifier: MIT

/**
 * Turn clang AST signatures into bindable operations — or refuse them.
 *
 * Hamlib's public API is regular enough that three families of declaration can
 * be generated mechanically:
 *
 *   get   `int rig_get_x(RIG *, vfo_t, T *out [, U *out2 …])`
 *   set   `int rig_set_x(RIG *, vfo_t, T value …)`
 *   pure  a value-returning helper, e.g. `const char *rig_license(void)`
 *
 * The shape has to be *proved* from the declaration rather than assumed.  Every
 * function is either classified into a known shape with fully-mapped types, or
 * recorded as a rejection with a reason.  Nothing is bound on a guess: a `null`
 * type binding, an unexpected arity, an unclassifiable shape or a pointer the
 * generator cannot place all end in the rejection list, which the driver
 * writes to the coverage report and audits.
 *
 * Authored as TypeScript and run directly by Node's type stripping, so this
 * file must stay erasable (no enums, namespaces or parameter properties).
 */
import type { AstFunction } from './ast.ts';
import { camelCase, pascalCase } from './naming.ts';
import type { ProjectionResolver } from './project.ts';
import {
  bindType,
  bareType,
  flagBinding,
  normalizeType,
  pointeeType,
  settingBinding,
  settingNamespaceFor,
  valueBinding,
  type SettingNamespace,
  type TypeBinding,
} from './types.ts';

export type GeneratedShape = 'get' | 'set' | 'pure';

/** The shared result value objects and the per-operation ones. */
export type FlatResult = 'NumberResult' | 'TextResult' | 'BoolResult' | 'CodeResult';

export interface OperationArgument {
  /** JavaScript-facing argument name. */
  readonly name: string;
  /** Result field name, for getter outputs. */
  readonly field: string;
  readonly binding: TypeBinding;
  /** The parameter this value came from, for the emitted call. */
  readonly parameter: number;
}

/** How one C parameter is supplied when the generated body calls Hamlib. */
export type ParameterPlan =
  | { readonly kind: 'rig' }
  | { readonly kind: 'target-vfo' }
  | { readonly kind: 'value'; readonly argument: number }
  | { readonly kind: 'out' };

export interface GeneratedOperation {
  readonly symbol: string;
  /** camelCase method name, e.g. `rig_set_split_freq` -> `setSplitFreq`. */
  readonly method: string;
  readonly shape: GeneratedShape;
  /** Value inputs, in JavaScript argument order. */
  readonly arguments: readonly OperationArgument[];
  /** Getter outputs, in declaration order. */
  readonly outputs: readonly OperationArgument[];
  /** The Embind result type: `CodeResult`, a flat result, or `<Pascal>Result`. */
  readonly result: string;
  /** The returned type of a `pure` operation. */
  readonly pure: TypeBinding | null;
  /** One entry per C parameter, in declaration order. */
  readonly plan: readonly ParameterPlan[];
}

export interface Rejection {
  readonly symbol: string;
  readonly reason: string;
}

/**
 * A naming override for a generated operation.  The generator's names are
 * mechanical camelCase (`rig_idx2setting` -> `idx2setting`, `tx_freq` ->
 * `txFreq`), so a public name or field that still reads badly is renamed here
 * rather than by hand-writing the operation.
 */
export interface OperationOverride {
  /** Replaces the camelCase method name. */
  readonly method?: string;
  /** Renames argument/output fields, keyed by the generated field name. */
  readonly fields?: Readonly<Record<string, string>>;
}

/**
 * Why an override does not apply to `operation`, or `null` when every part of
 * it renames something the generator emits differently.
 */
function overrideProblem(operation: GeneratedOperation, override: OperationOverride): string | null {
  if (override.method === operation.method) {
    return `method ${override.method} is already the generated name`;
  }

  const fields = new Set([...operation.arguments, ...operation.outputs].map((value) => value.field));

  for (const field of Object.keys(override.fields ?? {})) {
    if (!fields.has(field)) {
      return `has no field ${field} (fields: ${[...fields].join(', ') || 'none'})`;
    }
  }

  return null;
}

function applyOverride(
  operation: GeneratedOperation,
  override: OperationOverride | undefined,
): GeneratedOperation {
  if (!override) {
    return operation;
  }

  const rename = (argument: OperationArgument): OperationArgument =>
    override.fields?.[argument.field] === undefined
      ? argument
      : { ...argument, field: override.fields[argument.field] as string };

  return {
    ...operation,
    method: override.method ?? operation.method,
    arguments: operation.arguments.map(rename),
    outputs: operation.outputs.map(rename),
  };
}

export interface Classification {
  readonly operations: readonly GeneratedOperation[];
  readonly rejections: readonly Rejection[];
  /** Overrides that name nothing generated, or rename nothing; generation fails on any. */
  readonly staleOverrides: readonly string[];
}

/**
 * Symbols the browser build must not generate, for reasons the type system
 * cannot see: policy (credentials, raw bus), a second thread, or the transport
 * not being a plain serial port.  Shape-driven rejection handles the rest.
 */
const EXCLUDED_EXACT: ReadonlySet<string> = new Set([
  'rig_cookie',
  'rig_data_pointer',
  'rig_lock',
  'rig_get_lock_mode',
  'rig_set_lock_mode',
  'rig_make_md5',
  'rig_password',
  'rig_password_generate_secret',
  'rig_flush',
  'rig_flush_force',
  'rig_band_changed',
  'rig_no_restore_ai',
  'rig_set_vfo_opt',
  'rig_check_backend',
  'rig_get_function_ptr',
  'rig_probe',
  'rig_probe_all',
  'rig_register',
  'rig_unregister',
  'rig_load_backend',
  'rig_load_all_backends',
  'rig_list_foreach_model',
]);

/**
 * Operations that take a caller-supplied array whose length the signature does
 * not give (`channel_t chans[]`, `const freq_range_t *list`).  Binding them
 * would mean guessing a size; upstream also leaves `*_mem_all` unfinished
 * (`#if 0` parm handling, `-RIG_ENIMPL`), so they stay refused with that reason
 * rather than bound with a guessed buffer.
 */
const EXCLUDED_ARRAYS: ReadonlySet<string> = new Set([
  'rig_get_mem_all',
  'rig_set_mem_all',
  'rig_get_mem_all_cb',
  'rig_set_mem_all_cb',
  'rig_get_chan_all',
  'rig_set_chan_all',
  'rig_get_chan_all_cb',
  'rig_set_chan_all_cb',
  'rig_get_range',
]);

/**
 * Symbol families the browser build must not generate, matched by name.
 * Shape-driven rejection handles the rest; these are policy or transport
 * reasons the type system cannot see.
 */
const EXCLUDED_PATTERNS: readonly RegExp[] = [
  /^rig_cm108_/,
  /^rig_get_caps_/,
  /^rig_(get|set)_conf/,
  /^rig_get_cache/,
  /^rig_set_cache/,
  /^rig_(get|set|need)_debug/,
  /^rig_date_/,
];

/**
 * Operations whose only parameter besides the rig is the VFO they act on, so
 * the generated method takes no arguments and targets the current VFO.
 */
const VFO_ACTIONS: ReadonlySet<string> = new Set(['rig_stop_voice_mem']);

/**
 * The Morse calls.  `rig_send_morse` only pushes the text onto a queue that a
 * worker thread drains, `rig_stop_morse` resets that queue, and
 * `rig_wait_morse` waits on it; this build starts no such thread, so binding
 * them would queue text nobody sends.  The bespoke `sendMorse`/`stopMorse`
 * facade bodies call the backend's own `send_morse`/`stop_morse` instead.
 */
const MORSE_QUEUE: ReadonlySet<string> = new Set([
  'rig_send_morse',
  'rig_stop_morse',
  'rig_wait_morse',
]);

/**
 * Declarations that are bindable, but that the reference client never calls:
 * the upstream `rigctl`/`rigctld` sources under `tests/` are the yardstick for
 * what a Hamlib client actually needs, and these twenty-one never appear
 * there.  (The capability predicates `rig_has_scan`/`rig_has_vfo_op` are *not*
 * in this set: `dumpcaps.c`/`dumpstate.c`, which rigctl and rigctld link in,
 * enumerate the extension tables through `rig_token_foreach` and
 * `rig_ext_level|func|parm_foreach` and call `rig_has_vfo_op`, and
 * `rig_has_scan` is the documented sibling predicate.)
 *
 * Three groups, all reachable only as extra API noise on the raw surface:
 *
 *  - bare codec names whose `rig_sprintf_*` twin is the call a client makes
 *    (`rig_strfunc`, `rig_strparm`, `rig_strscan`, `rig_strvfop`,
 *    `rig_strmtype`, `rig_strspectrummode`, `rig_strcommstatus`,
 *    `rig_stragclevel`, `rig_parse_mtype`); the generated setters and getters
 *    keep calling the parses and stringifiers they need internally;
 *  - introspection the reference client never performs (`rig_license`,
 *    `rig_copyright`, `rig_is_model`, `rig_confparam_lookup`,
 *    `rig_ext_token_lookup`, `rig_get_resolution`, `rig_mem_count`);
 *  - the AGC level codecs and the tracking pair (`rig_levelagcstr`,
 *    `rig_levelagcvalue`, `rig_valueagclevel`, `rig_get_trn`, `rig_set_trn`).
 */
const NOT_IN_REFERENCE_SURFACE: ReadonlySet<string> = new Set([
  'rig_confparam_lookup',
  'rig_copyright',
  'rig_ext_token_lookup',
  'rig_get_resolution',
  'rig_get_trn',
  'rig_is_model',
  'rig_levelagcstr',
  'rig_levelagcvalue',
  'rig_license',
  'rig_mem_count',
  'rig_parse_mtype',
  'rig_set_trn',
  'rig_stragclevel',
  'rig_strcommstatus',
  'rig_strfunc',
  'rig_strmtype',
  'rig_strparm',
  'rig_strscan',
  'rig_strspectrummode',
  'rig_strvfop',
  'rig_valueagclevel',
]);

/**
 * Symbol families handled with the raw-token (`setting_t`/enum → number) param
 * and result mode rather than the name mapping: the `rig_parse_*` name→token
 * and `rig_str*` token→name codec, and the `rig_ext_*` table walkers.  Without
 * it `rig_strvfo(name)` would parse the name and stringify it straight back.
 */
const TOKEN_SYMBOLS: readonly RegExp[] = [/^rig_str/, /^rig_parse_/, /^rig_ext_/];

/**
 * Value-returning helpers whose `value_t` result is always stored in `.i`.
 * Hamlib's own `rigctl` assumes the `rig_get_ant`/`rig_set_ant` option is an
 * integer, and `src/misc.c` stores every value the same way.
 */
const VALUE_T_INT_SYMBOLS: ReadonlySet<string> = new Set([
  'rig_get_ant',
  'rig_set_ant',
]);

/** A `value_t` whose union member is fixed by the symbol, not by a predicate. */
const INT_VALUE_BINDING: TypeBinding = {
  category: 'number',
  boundary: 'double',
  ts: 'number',
  native: 'value_t',
  valueAccess: 'i',
};

/** Force an enum binding to cross as its underlying number, for the codec. */
function asToken(binding: TypeBinding | null): TypeBinding | null {
  if (binding?.category !== 'enum') {
    return binding;
  }

  return { category: 'number', boundary: 'double', ts: 'number', native: binding.native };
}

/**
 * Value-returning helpers whose C result is `int`, so on the type alone they
 * look like error codes.  Only policy can tell an index (`rig_setting2idx`)
 * from a status.
 */
const PURE_INT_SYMBOLS: ReadonlySet<string> = new Set([
  'rig_setting2idx',
]);

/**
 * `int` parameters that are on/off flags, by symbol and C parameter name: a
 * function's status, and whether a channel read may change the rig.  The type
 * alone is just `int`; Hamlib documents these as booleans.
 */
const FLAG_PARAMETERS: Readonly<Record<string, ReadonlySet<string>>> = {
  rig_set_func: new Set(['status']),
  rig_get_func: new Set(['status']),
  rig_set_ext_func: new Set(['status']),
  rig_get_ext_func: new Set(['status']),
  rig_get_channel: new Set(['read_only']),
};

function flagOverride(symbol: string, parameter: string, binding: TypeBinding): TypeBinding {
  return FLAG_PARAMETERS[symbol]?.has(parameter) && binding.native.replace(/\s*\*$/, '') === 'int'
    ? flagBinding('int', '1', '0')
    : binding;
}

/** `rig_get_rptr_offs` -> `getRptrOffs`; `rig_scan` -> `scan`. */
function methodName(symbol: string): string {
  return camelCase(symbol.startsWith('rig_') ? symbol.slice(4) : symbol);
}

/**
 * Why a symbol is excluded, or `null` when it is not.  The reason distinguishes
 * an irreducible surface (credentials, a second thread, a caller-owned array)
 * from one this build merely does not implement (the asynchronous data path),
 * so an upstream bump shows a real delta instead of one opaque bucket.
 */
function exclusionReason(symbol: string): string | null {
  if (EXCLUDED_ARRAYS.has(symbol)) {
    return 'excluded: caller-owned array whose length the signature does not give';
  }

  if (NOT_IN_REFERENCE_SURFACE.has(symbol)) {
    return 'excluded: not called by the upstream rigctl reference client';
  }

  if (EXCLUDED_EXACT.has(symbol)) {
    return 'excluded: machine-local, raw-bus or credential surface';
  }

  if (MORSE_QUEUE.has(symbol)) {
    return 'excluded: queued for the Morse worker thread this build does not start';
  }

  if (/_callback$/.test(symbol)) {
    return 'excluded: needs the asynchronous data path, disabled in this single-threaded build';
  }

  if (EXCLUDED_PATTERNS.some((pattern) => pattern.test(symbol))) {
    return 'excluded by policy (threads, transport or unsafe surface)';
  }

  return null;
}

/** Pick the canonical declaration when Hamlib declares a symbol more than once. */
export function canonicalDeclaration(declarations: readonly AstFunction[]): AstFunction {
  return [...declarations].sort((a, b) => {
    if (a.params.length !== b.params.length) {
      return a.params.length - b.params.length;
    }

    return Number(a.variadic) - Number(b.variadic);
  })[0] as AstFunction;
}

function flatResultFor(binding: TypeBinding): FlatResult {
  switch (binding.boundary) {
    case 'bool':
      return 'BoolResult';
    case 'string':
      return 'TextResult';
    default:
      return 'NumberResult';
  }
}

/** A stable, non-empty field name for a C parameter: `tx_freq` -> `txFreq`. */
function fieldName(name: string, index: number): string {
  const trimmed = name.trim();
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed) ? camelCase(trimmed) : `value${index}`;
}

/**
 * Bind one parameter or pointee type.
 *
 * `setting_t` and `value_t` are shared C types whose meaning depends on the
 * operation's name space, so they are resolved from the namespace before the
 * generic registry is consulted.  Anything the registry does not know is tried
 * as a struct projection.
 *
 * A `value_t` is a union whose member is chosen by the `setting_t` argument, so
 * the emitted code has to test that argument; without one (an operation that
 * takes a bare `hamlib_token_t`, e.g. `rig_get_ext_level`) there is nothing to
 * test and the value is refused rather than read from a guessed member.
 */
function parameterBinding(
  type: string,
  namespace: SettingNamespace | null,
  resolveProjection: ProjectionResolver,
  tokenMode: boolean,
  valueOverride: TypeBinding | null,
  hasSettingArgument: boolean,
): TypeBinding | null {
  const bare = bareType(type);

  if (bare === 'setting_t') {
    const binding = namespace === null ? bindType(type) : settingBinding(namespace);

    return tokenMode ? asToken(binding) : binding;
  }

  if (bare === 'value_t') {
    if (valueOverride) {
      return valueOverride;
    }

    return namespace === null || !hasSettingArgument ? null : valueBinding(namespace);
  }

  const direct = bindType(type);

  if (direct) {
    return tokenMode ? asToken(direct) : direct;
  }

  const projection = resolveProjection(bare);

  return projection
    ? { category: 'struct', boundary: 'int', ts: projection.cpp, native: type, projection }
    : null;
}

/**
 * Bind a result type, following one pointer level to reach a struct.  In token
 * mode an enum result crosses as its number, so `rig_parse_vfo("VFOA")` returns
 * the `vfo_t` token instead of re-stringifying it.
 */
function resultBinding(
  type: string,
  resolveProjection: ProjectionResolver,
  tokenMode: boolean,
  valueOverride: TypeBinding | null,
): TypeBinding | null {
  if (bareType(type) === 'value_t' && valueOverride) {
    return valueOverride;
  }

  const direct = bindType(type);

  if (direct) {
    return tokenMode ? asToken(direct) : direct;
  }

  const name = pointeeType(type) ?? bareType(type);
  const projection = resolveProjection(name);

  return projection
    ? { category: 'struct', boundary: 'int', ts: projection.cpp, native: name, projection }
    : null;
}

/**
 * Classify one declaration.
 *
 * `manualSymbols` are the upstream symbols a hand-written facade method already
 * covers; they are skipped here so the generator never duplicates them.
 */
export function classifyFunction(
  fn: AstFunction,
  manualSymbols: ReadonlySet<string>,
  resolveProjection: ProjectionResolver,
): GeneratedOperation | Rejection {
  const symbol = fn.name;
  const namespace = settingNamespaceFor(symbol);
  const tokenMode = TOKEN_SYMBOLS.some((pattern) => pattern.test(symbol));
  const valueOverride = VALUE_T_INT_SYMBOLS.has(symbol) ? INT_VALUE_BINDING : null;
  /* The predicate a `value_t` binding needs tests the `setting_t` argument, so
   * an operation without one cannot bind a `value_t`. */
  const hasSettingArgument = fn.params.some(
    (param) => bareType(param.qualType) === 'setting_t',
  );

  if (manualSymbols.has(symbol)) {
    return { symbol, reason: 'implemented by a hand-written facade method' };
  }

  const exclusion = exclusionReason(symbol);

  if (exclusion !== null) {
    return { symbol, reason: exclusion };
  }

  if (fn.variadic) {
    return { symbol, reason: 'variadic' };
  }

  const rigIndexes = fn.params
    .map((param, index) => (normalizeType(param.qualType) === 'RIG *' ? index : -1))
    .filter((index) => index >= 0);

  /* --- pure: a value-returning helper, not an error code ----------------- */
  if (normalizeType(fn.result) !== 'int' || PURE_INT_SYMBOLS.has(symbol)) {
    if (rigIndexes.length > 1) {
      return { symbol, reason: 'more than one RIG * handle' };
    }

    const bound = resultBinding(fn.result, resolveProjection, tokenMode, valueOverride);

    if (!bound) {
      return { symbol, reason: `returns unmapped type ${fn.result || 'void'}` };
    }

    /* A capability predicate answers for the one name it was given: the
     * result is that bit or none (`scan_ops & scan`, `has_get_level & level`),
     * so it crosses as a boolean, never re-stringified through the codec. */
    const pure = symbol.startsWith('rig_has_')
      ? flagBinding(normalizeType(fn.result), '1', '0')
      : bound;

    const plan: ParameterPlan[] = [];
    const args: OperationArgument[] = [];

    for (let index = 0; index < fn.params.length; index++) {
      const param = fn.params[index] as { name: string; qualType: string };

      if (normalizeType(param.qualType) === 'RIG *') {
        plan.push({ kind: 'rig' });
        continue;
      }

      const type = normalizeType(param.qualType);
      const binding = parameterBinding(type, namespace, resolveProjection, tokenMode, valueOverride, hasSettingArgument);

      if (!binding) {
        return { symbol, reason: `parameter type ${type} is not mappable` };
      }

      plan.push({ kind: 'value', argument: args.length });
      args.push({
        name: `arg${args.length}`,
        field: fieldName(param.name, args.length),
        binding,
        parameter: index,
      });
    }

    return {
      symbol,
      method: methodName(symbol),
      shape: 'pure',
      arguments: args,
      outputs: [],
      result: pure.category === 'struct' ? `${pascalCase(methodName(symbol))}Result` : flatResultFor(pure),
      pure,
      plan,
    };
  }

  if (rigIndexes.length !== 1) {
    return { symbol, reason: 'does not take exactly one RIG * handle' };
  }

  const plan: ParameterPlan[] = [];
  const outputs: number[] = [];
  const scalarInputs: number[] = [];
  const vfoInputs: number[] = [];
  const bindings = new Map<number, TypeBinding>();

  for (let index = 0; index < fn.params.length; index++) {
    const param = fn.params[index] as { name: string; qualType: string };
    const type = normalizeType(param.qualType);

    if (type === 'RIG *') {
      plan.push({ kind: 'rig' });
      continue;
    }

    const pointee = pointeeType(type);

    if (pointee !== null) {
      /* A `const T *` is a read-only argument (`set_channel`); a non-const
       * `T *` is an output (`get_channel`).  `const char *` is a string. */
      const isConst = /^const /.test(type);
      const direct = bindType(type);

      if (isConst) {
        const binding = direct ?? parameterBinding(pointee, namespace, resolveProjection, tokenMode, valueOverride, hasSettingArgument);

        if (!binding) {
          return { symbol, reason: `parameter type ${type} is not mappable` };
        }

        scalarInputs.push(index);
        bindings.set(index, binding);
        plan.push({ kind: 'value', argument: -1 });
        continue;
      }

      const binding = direct ?? parameterBinding(pointee, namespace, resolveProjection, tokenMode, valueOverride, hasSettingArgument);

      if (!binding || binding.category === 'string') {
        return { symbol, reason: `output of type ${type} is not mappable` };
      }

      outputs.push(index);
      bindings.set(index, flagOverride(symbol, param.name, binding));
      plan.push({ kind: 'out' });
      continue;
    }

    const binding = parameterBinding(type, namespace, resolveProjection, tokenMode, valueOverride, hasSettingArgument);

    if (!binding) {
      return { symbol, reason: `parameter type ${type} is not mappable` };
    }

    if (bareType(type) === 'vfo_t') {
      vfoInputs.push(index);
    } else {
      scalarInputs.push(index);
    }

    bindings.set(index, flagOverride(symbol, param.name, binding));
    plan.push({ kind: 'value', argument: -1 });
  }

  if (outputs.length >= 1 && vfoInputs.length <= 1) {
    if (vfoInputs.length === 1) {
      plan[vfoInputs[0] as number] = { kind: 'target-vfo' };
    }

    const inputArguments: OperationArgument[] = scalarInputs.map((index, position) => {
      const param = fn.params[index] as { name: string; qualType: string };

      return {
        name: `arg${position}`,
        field: fieldName(param.name, position),
        binding: bindings.get(index) as TypeBinding,
        parameter: index,
      };
    });

    const outputArguments: OperationArgument[] = outputs.map((index, position) => {
      const param = fn.params[index] as { name: string; qualType: string };

      return {
        name: 'value',
        field: fieldName(param.name, position),
        binding: bindings.get(index) as TypeBinding,
        parameter: index,
      };
    });

    const rebuilt = plan.map((entry, index) => {
      if (entry.kind !== 'value') {
        return entry;
      }

      const position = inputArguments.findIndex((argument) => argument.parameter === index);

      return position >= 0 ? { kind: 'value' as const, argument: position } : entry;
    });

    const first = outputArguments[0] as OperationArgument;
    const singleScalar = outputArguments.length === 1 && first.binding.category !== 'struct';

    return {
      symbol,
      method: methodName(symbol),
      shape: 'get',
      arguments: inputArguments,
      outputs: outputArguments,
      result: singleScalar ? flatResultFor(first.binding) : `${pascalCase(methodName(symbol))}Result`,
      pure: null,
      plan: rebuilt,
    };
  }

  if (outputs.length === 0 && scalarInputs.length + vfoInputs.length >= 1) {
    const valueParams = [...scalarInputs, ...vfoInputs].sort((a, b) => a - b);

    /* A lone vfo_t parameter is the value itself (`rig_set_vfo`) unless the
     * operation is an action on the current VFO (`rig_stop_voice_mem`);
     * otherwise the first vfo_t is the target and any further vfo_t is a
     * value. */
    const loneValue = valueParams.length === 1 && vfoInputs.length === 1
      && !VFO_ACTIONS.has(symbol);
    const targetIndex = loneValue ? -1 : vfoInputs[0] ?? -1;

    if (targetIndex >= 0) {
      plan[targetIndex] = { kind: 'target-vfo' };
    }

    const arguments_: OperationArgument[] = [];

    for (const index of valueParams) {
      if (index === targetIndex) {
        continue;
      }

      const param = fn.params[index] as { name: string; qualType: string };

      arguments_.push({
        name: `arg${arguments_.length}`,
        field: fieldName(param.name, arguments_.length),
        binding: bindings.get(index) as TypeBinding,
        parameter: index,
      });
    }

    if (arguments_.length === 0 && !VFO_ACTIONS.has(symbol)) {
      return { symbol, reason: 'no value parameters' };
    }

    const rebuilt = plan.map((entry, index) => {
      if (entry.kind !== 'value') {
        return entry;
      }

      const position = arguments_.findIndex((argument) => argument.parameter === index);

      return position >= 0 ? { kind: 'value' as const, argument: position } : entry;
    });

    return {
      symbol,
      method: methodName(symbol),
      shape: 'set',
      arguments: arguments_,
      outputs: [],
      result: 'CodeResult',
      pure: null,
      plan: rebuilt,
    };
  }

  return {
    symbol,
    reason: `unclassifiable shape (${outputs.length} outputs, `
      + `${scalarInputs.length + vfoInputs.length} inputs)`,
  };
}

/** Classify every declaration the AST knows, dropping duplicate method names. */
export function classifyAll(
  functions: ReadonlyMap<string, readonly AstFunction[]>,
  manualSymbols: ReadonlySet<string>,
  resolveProjection: ProjectionResolver,
  overrides: Readonly<Record<string, OperationOverride>> = {},
): Classification {
  const operations: GeneratedOperation[] = [];
  const rejections: Rejection[] = [];
  const staleOverrides: string[] = [];
  const methods = new Set<string>();

  for (const [symbol, declarations] of functions) {
    if (!symbol.startsWith('rig_') || declarations.length === 0) {
      continue;
    }

    const outcome = classifyFunction(
      canonicalDeclaration(declarations),
      manualSymbols,
      resolveProjection,
    );

    if ('reason' in outcome) {
      if (!manualSymbols.has(symbol) && symbol.startsWith('rig_')) {
        rejections.push(outcome);
      }

      continue;
    }

    const override = overrides[symbol];
    const problem = override === undefined ? null : overrideProblem(outcome, override);

    if (problem !== null) {
      staleOverrides.push(`${symbol}: ${problem}`);
    }

    const operation = applyOverride(outcome, override);

    if (methods.has(operation.method)) {
      rejections.push({ symbol, reason: `method name ${operation.method} already generated` });
      continue;
    }

    methods.add(operation.method);
    operations.push(operation);
  }

  const generated = new Set(operations.map((operation) => operation.symbol));

  for (const symbol of Object.keys(overrides)) {
    if (!generated.has(symbol)) {
      const refused = rejections.find((rejection) => rejection.symbol === symbol);
      staleOverrides.push(`${symbol}: not generated${refused ? ` (${refused.reason})` : ''}`);
    }
  }

  return { operations, rejections, staleOverrides };
}
