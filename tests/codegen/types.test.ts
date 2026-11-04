// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';

import {
  bindType,
  settingBinding,
  settingNamespaceFor,
  valueBinding,
} from '../../packages/hamlib-codegen/src/types.ts';

describe('settingNamespaceFor', () => {
  it('selects the namespace from the operation suffix', () => {
    expect(settingNamespaceFor('rig_get_level')).toBe('level');
    expect(settingNamespaceFor('rig_set_level')).toBe('level');
    expect(settingNamespaceFor('rig_get_func')).toBe('func');
    expect(settingNamespaceFor('rig_set_parm')).toBe('parm');
  });

  it('returns null for symbols without a setting suffix', () => {
    expect(settingNamespaceFor('rig_get_freq')).toBeNull();
    expect(settingNamespaceFor('rig_get_levels')).toBeNull();
  });

  it('binds each namespace to its own parse/stringify vocabulary', () => {
    expect(settingBinding('level')).toMatchObject({
      category: 'enum',
      boundary: 'string',
      native: 'setting_t',
      enumStr: 'rig_strlevel',
      enumParse: 'rig_parse_level',
      enumNone: 'RIG_LEVEL_NONE',
    });
    expect(settingBinding('func').enumStr).toBe('rig_strfunc');
    expect(settingBinding('parm').enumStr).toBe('rig_strparm');
  });

  it('only gives levels and parameters a value predicate', () => {
    expect(valueBinding('level')?.valuePredicate).toBe('RIG_LEVEL_IS_FLOAT');
    expect(valueBinding('parm')?.valuePredicate).toBe('RIG_PARM_IS_FLOAT');
    expect(valueBinding('func')).toBeNull();
  });
});

describe('bindType numeric table', () => {
  it('maps a known integer type to a JS number', () => {
    expect(bindType('unsigned int')).toEqual({
      category: 'number',
      boundary: 'double',
      ts: 'number',
      native: 'unsigned int',
    });
    expect(bindType('freq_t')).toMatchObject({ category: 'number', ts: 'number' });
  });

  it('maps an unknown type to null', () => {
    expect(bindType('struct opaque_blob')).toBeNull();
    expect(bindType('void')).toBeNull();
  });
});
