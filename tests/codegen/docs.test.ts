// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';

import { commentBlock, parseUpstreamDocs, renderDoc } from '../../packages/hamlib-codegen/src/docs.ts';
import type { DocTarget } from '../../packages/hamlib-codegen/src/docs.ts';
import type { TypeBinding } from '../../packages/hamlib-codegen/src/types.ts';

/* Shaped like Hamlib's own src/rig.c, BUILTINFUNC dance included. */
const RIG_C = `
/**
 * \\brief set the frequency of the target VFO
 * \\param rig   The rig handle
 * \\param vfo   The target VFO
 * \\param freq  The frequency to set to
 *
 *  Sets the frequency of the target VFO.
 *
 * \\return RIG_OK if the operation has been successful, otherwise
 * a negative value if an error occurred (in which case, cause is
 * set appropriately).
 *
 * \\sa rig_get_freq()
 */
#if BUILTINFUNC
#undef rig_set_freq
int rig_set_freq(RIG *rig, vfo_t vfo, freq_t freq, const char *func)
#define rig_set_freq(r,v,f) rig_set_freq(r,v,f,__builtin_FUNCTION())
#else
int rig_set_freq(RIG *rig, vfo_t vfo, freq_t freq)
#endif
{
    return RIG_OK;
}

/**
 * \\brief get the mode of the target VFO
 * \\param rig   The rig handle
 * \\param vfo   The target VFO
 * \\param mode  The location where to store the current mode
 * \\param width The location where to store the current passband width
 *
 *  Retrieves the mode of the target VFO. The value stored at \\a mode
 *  equals RIG_MODE_NONE when the mode is not defined.
 *
 *  Note that if either \\a mode or \\a width is NULL, -RIG_EINVAL is returned.
 *
 * Example:
 * \\code
 *   err = rig_get_mode(rig, RIG_VFO_CURR, &mode, &width);
 * \\endcode
 *
 * \\return RIG_OK if the operation has been successful, otherwise
 * a negative value if an error occurred.
 *
 * \\sa rig_set_mode(), rig_unbound()
 */
int HAMLIB_API rig_get_mode(RIG *rig, vfo_t vfo, rmode_t *mode, pbwidth_t *width)
{
    return RIG_OK;
}

/* Not Doxygen: never picked up. */
int HAMLIB_API rig_undocumented(RIG *rig)
{
    return RIG_OK;
}
`;

function binding(native: string, extra: Partial<TypeBinding> = {}): TypeBinding {
  return { category: 'number', boundary: 'double', ts: 'number', native, ...extra };
}

const MODE = binding('rmode_t', { category: 'enum', boundary: 'string', ts: 'string', enumStr: 'rig_strrmode' });

const METHODS = new Map([
  ['rig_set_freq', 'setFrequency'],
  ['rig_get_freq', 'getFrequency'],
  ['rig_get_mode', 'getMode'],
  ['rig_set_mode', 'setMode'],
  ['rig_strrmode', 'strRmode'],
]);

describe('upstream documentation', () => {
  const docs = parseUpstreamDocs([RIG_C]);

  it('finds each documented definition, across preprocessor lines', () => {
    expect([...docs.keys()]).toEqual(['rig_set_freq', 'rig_get_mode']);
    expect(docs.get('rig_set_freq')?.params.get('freq')).toBe('The frequency to set to');
  });

  it('renders a setter: argument by its JavaScript name, no status boilerplate', () => {
    const target: DocTarget = {
      symbol: 'rig_set_freq',
      arguments: [{ c: 'freq', js: 'freq', binding: binding('freq_t') }],
      result: { kind: 'void' },
    };

    expect(renderDoc(docs.get('rig_set_freq'), target, METHODS)).toEqual([
      'Set the frequency of the target VFO.',
      '',
      'Sets the frequency of the target VFO.',
      '',
      "From Hamlib's documentation of `rig_set_freq()`.",
      '',
      '@param freq - The frequency to set to. In hertz.',
      '@see {@link RawRig.getFrequency}',
    ]);
  });

  it('renders a getter: outputs become the returned fields, C-only prose is dropped', () => {
    const target: DocTarget = {
      symbol: 'rig_get_mode',
      arguments: [],
      result: {
        kind: 'object',
        fields: [
          { c: 'mode', js: 'mode', binding: MODE },
          { c: 'width', js: 'passband', binding: binding('pbwidth_t') },
        ],
      },
    };

    expect(renderDoc(docs.get('rig_get_mode'), target, METHODS)).toEqual([
      'Get the mode of the target VFO.',
      '',
      'Retrieves the mode of the target VFO. The value stored at `mode` equals `RIG_MODE_NONE` when the mode is not defined.',
      '',
      "From Hamlib's documentation of `rig_get_mode()`.",
      '',
      '@returns An object with:',
      '',
      '- `mode`: The current mode. Named as {@link RawRig.strRmode} spells it: `RIG_MODE_USB` is `"USB"`.',
      '- `passband`: The current passband width. In hertz.',
      '@see {@link RawRig.setMode}',
      '@see `rig_unbound()`',
    ]);
  });

  it('renders nothing for a call upstream does not document', () => {
    expect(renderDoc(undefined, { symbol: 'rig_undocumented', arguments: [], result: { kind: 'void' } }, METHODS))
      .toBeNull();
  });

  it('wraps without splitting inline tags and escapes a comment terminator', () => {
    const block = commentBlock([
      `${'word '.repeat(14)}{@link RawRig.strRmode} and */ here`,
    ], '  ');

    expect(block).toEqual([
      '  /**',
      `   * ${'word '.repeat(14).trimEnd()}`,
      '   * {@link RawRig.strRmode} and *\\/ here',
      '   */',
    ]);
  });
});
