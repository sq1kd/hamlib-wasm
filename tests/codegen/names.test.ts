import { describe, expect, it } from 'vitest';

import { parseSwitchNames, parseTable } from '../../packages/hamlib-codegen/src/names.ts';

const MISC = `
static const struct
{
    rmode_t mode;
    const char *str;
} mode_str[] =
{
    { RIG_MODE_CW, "CW" },
    { RIG_MODE_CWR, "CWR" },
    { RIG_MODE_CWR, "CW-R" },   // an alias the parser also accepts
    { RIG_MODE_CW, "CW" },

    { RIG_MODE_NONE, "" },
};

static const struct { scan_t s; const char *str; } scan_str_shape;
} scan_str[] =
{
    { RIG_SCAN_STOP, "STOP" },
    { -1, NULL },
};

const char *HAMLIB_API rig_strptrshift(rptr_shift_t shift)
{
    switch (shift)
    {
    case RIG_RPT_SHIFT_MINUS:
        return "-";

    case RIG_RPT_SHIFT_NONE:
        return "None";
    }

    return NULL;
}
`;

describe('parseTable', () => {
  it('reads every name once, aliases included, up to the sentinel', () => {
    expect(parseTable(MISC, 'mode_str')).toEqual(['CW', 'CWR', 'CW-R']);
  });

  it('treats a NULL name as the end-of-table sentinel', () => {
    expect(parseTable(MISC, 'scan_str')).toEqual(['STOP']);
  });
});

describe('parseSwitchNames', () => {
  it('reads the names a switch stringifier returns', () => {
    expect(parseSwitchNames(MISC, 'const char *HAMLIB_API rig_strptrshift')).toEqual(['-', 'None']);
  });
});
