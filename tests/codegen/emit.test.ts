// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';

import type { AstFunction } from '../../packages/hamlib-codegen/src/ast.ts';
import { classifyFunction } from '../../packages/hamlib-codegen/src/classify.ts';
import { operationFacts } from '../../packages/hamlib-codegen/src/emit/common.ts';
import { emitOperations } from '../../packages/hamlib-codegen/src/emit/cpp.ts';
import { macroConstants } from '../../packages/hamlib-codegen/src/emit/names.ts';
import { bindType, type ProjectionSpec, type TypeBinding } from '../../packages/hamlib-codegen/src/types.ts';

function declaration(
  name: string,
  params: readonly (readonly [string, string])[],
  result = 'int',
): AstFunction {
  return {
    name,
    result,
    params: params.map(([param, qualType]) => ({ name: param, qualType })),
    variadic: false,
  };
}

const declarations: readonly AstFunction[] = [
  declaration('rig_get_freq', [
    ['rig', 'RIG *'],
    ['vfo', 'vfo_t'],
    ['freq', 'freq_t *'],
  ]),
  declaration('rig_set_freq', [
    ['rig', 'RIG *'],
    ['vfo', 'vfo_t'],
    ['freq', 'freq_t'],
  ]),
  declaration('rig_get_marker', [
    ['rig', 'RIG *'],
    ['marker', 'int *'],
  ]),
];

/** The sentinel names `names.ts` reads from the pinned `src/misc.c`. */
const SENTINELS: ReadonlyMap<string, string> = new Map([
  ['rig_parse_mode', 'None'],
  ['rig_parse_rptr_shift', 'None'],
]);

/** Emit the synthetic declarations, failing loudly if one is refused. */
function emit(sources: readonly AstFunction[] = declarations, sentinels: ReadonlyMap<string, string> = SENTINELS): string {
  const facts = sources.map((fn) => {
    const classified = classifyFunction(fn, new Set<string>(), () => null);

    if ('reason' in classified) {
      throw new Error(`${fn.name} was refused: ${classified.reason}`);
    }

    return operationFacts(classified, new Set<string>());
  });

  return emitOperations(facts, sentinels);
}

describe('emitOperations method names', () => {
  it('emits the same names and bodies on every run', () => {
    expect(emit()).toBe(emit());
  });

  it('keeps the generated method names in input order', () => {
    const methods = [...emit().matchAll(/^ {4}\S+ (\w+)\(/gm)].map((match) => match[1]);

    expect(methods).toEqual(['getFreq', 'setFreq', 'getMarker']);
  });
});

describe('emitOperations argument conversion', () => {
  it('refuses a name Hamlib does not know in a value-returning helper too', () => {
    const code = emit([
      declaration('rig_passband_normal', [['rig', 'RIG *'], ['mode', 'rmode_t']], 'pbwidth_t'),
    ]);

    expect(code).toContain('rmode_t value0 = rig_parse_mode(arg0.c_str());');
    expect(code).toContain('if (value0 == RIG_MODE_NONE && arg0 != "None") { return failure<NumberResult>(-RIG_EINVAL); }');
  });

  it('refuses every name the parser answers its sentinel for when the vocabulary does not name the sentinel', () => {
    const code = emit([declaration('rig_set_rptr_shift', [['rig', 'RIG *'], ['vfo', 'vfo_t'], ['rptr_shift', 'rptr_shift_t']])], new Map());

    expect(code).toContain('if (value0 == RIG_RPT_SHIFT_NONE) { return failure<CodeResult>(-RIG_EINVAL); }');
  });

  it('accepts the sentinel by its own name, which is a real setting', () => {
    const code = emit([declaration('rig_set_rptr_shift', [['rig', 'RIG *'], ['vfo', 'vfo_t'], ['rptr_shift', 'rptr_shift_t']])]);

    expect(code).toContain('if (value0 == RIG_RPT_SHIFT_NONE && arg0 != "None") { return failure<CodeResult>(-RIG_EINVAL); }');
  });
});

describe('emitOperations result conversion', () => {
  const getMode = declaration('rig_get_mode', [
    ['rig', 'RIG *'],
    ['vfo', 'vfo_t'],
    ['mode', 'rmode_t *'],
    ['width', 'pbwidth_t *'],
  ]);

  it('reports the sentinel by the name its vocabulary gives it', () => {
    /* `rig_strrmode(RIG_MODE_NONE)` is "", which is not a `RigMode`. */
    expect(emit([getMode])).toContain('if (out0 == RIG_MODE_NONE) { result.mode = "None"; }');
  });

  it('fails on any other value the stringifier has no name for', () => {
    const code = emit([getMode]);

    expect(code).toContain('else if (const char *text = rig_strrmode(out0); text != nullptr && *text != \'\\0\') { result.mode = text; }');
    expect(code).toContain('else { return failure<GetModeResult>(-RIG_EPROTO, "rig_get_mode returned a rmode_t Hamlib does not name"); }');
  });

  it('reports a helper through the same result value object as a getter', () => {
    const code = emit([declaration('rig_get_info', [['rig', 'RIG *']], 'const char *')]);

    expect(code).toContain('TextResult getInfo(int handle)');
    expect(code).toContain('result.value = textOrEmpty(returned);');
  });
});

describe('emitOperations struct outputs', () => {
  const channel: ProjectionSpec = {
    type: 'channel_t',
    tag: 'channel',
    cpp: 'RigChannel',
    fields: [
      { name: 'channelNum', member: 'channel_num', binding: bindType('int') as TypeBinding, charArray: null },
      { name: 'vfo', member: 'vfo', binding: bindType('vfo_t') as TypeBinding, charArray: null },
    ],
    dropped: [{ name: 'ext_levels', reason: 'field type struct ext_list * is not mappable' }],
  };
  const getChannel = declaration('rig_get_channel', [
    ['rig', 'RIG *'],
    ['vfox', 'vfo_t'],
    ['chan', 'channel_t *'],
    ['read_only', 'int'],
  ]);

  function code(): string {
    const classified = classifyFunction(getChannel, new Set<string>(), (type) => (type === 'channel_t' ? channel : null), {
      chan: { reads: ['vfo', 'channel_num'], frees: ['ext_levels'] },
    });

    if ('reason' in classified) {
      throw new Error(classified.reason);
    }

    return emitOperations([operationFacts(classified, new Set<string>())], SENTINELS);
  }

  it('seeds the members upstream reads before the call', () => {
    expect(code()).toContain([
      'channel_t out0{};',
      '            out0.vfo = rig_parse_vfo(arg0.c_str());',
      '            if (out0.vfo == RIG_VFO_NONE) { return failure<RigChannelResult>(-RIG_EINVAL); }',
      '            if (!fromNumber(arg1, &out0.channel_num)) { return failure<RigChannelResult>(-RIG_EINVAL); }',
    ].join('\n'));
  });

  it('frees what upstream allocates for the caller on every path after the call', () => {
    expect(code()).toContain('int rc = rig_get_channel(rig, RIG_VFO_CURR, &out0, value2);\n            std::free(out0.ext_levels);\n');
  });
});

describe('macroConstants', () => {
  const header = [
    '/**',
    ' * \\brief Macro for bandpass to be set to normal',
    ' * \\def RIG_PASSBAND_NORMAL',
    ' */',
    '#define RIG_PASSBAND_NORMAL     s_Hz(0)',
    '',
    '#define RIG_PASSBAND_NOCHANGE   s_Hz(-1)',
  ].join('\n');

  it('exports each macro with its evaluated value and the brief above its #define', () => {
    expect(macroConstants(new Map([['RIG_PASSBAND_NORMAL', 0], ['RIG_PASSBAND_NOCHANGE', -1]]), header)).toEqual([
      "/** Macro for bandpass to be set to normal: `RIG_PASSBAND_NORMAL` in Hamlib's rig.h. */",
      'export const RIG_PASSBAND_NORMAL = 0;',
      '',
      "/** `RIG_PASSBAND_NOCHANGE` in Hamlib's rig.h. */",
      'export const RIG_PASSBAND_NOCHANGE = -1;',
      '',
    ]);
  });
});
