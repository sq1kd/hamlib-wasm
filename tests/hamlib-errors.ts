/**
 * Hamlib's error codes the specs assert, by their `enum rig_errcode_e` names.
 *
 * Hamlib returns the negated value (`-RIG_EIO`), and that is what
 * `HamlibError.hamlibCode` carries.  The text is what the package reports as
 * `hamlibMessage` for each.  The package does not export either yet; when it
 * does, this module becomes a re-export.
 */

export const RIG_EINVAL = 1;
export const RIG_ECONF = 2;
export const RIG_ETIMEOUT = 5;
export const RIG_EIO = 6;
export const RIG_EINTERNAL = 7;

/** `hamlibMessage` for each code above. */
export const HAMLIB_MESSAGE = {
  [RIG_EINVAL]: 'invalid parameter',
  [RIG_ECONF]: 'invalid configuration',
  [RIG_ETIMEOUT]: 'communication timed out',
  [RIG_EIO]: 'I/O error',
  [RIG_EINTERNAL]: 'internal Hamlib error',
} as const;
