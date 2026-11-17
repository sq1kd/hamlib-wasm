/**
 * What the specs rely on about Hamlib, by name.
 *
 * The error codes are the package's `RIG_ERRCODES`, generated from
 * `enum rig_errcode_e`.  Hamlib returns the negated value (`-RIG_EIO`), and
 * that is what `HamlibError.hamlibCode` carries; the text is Hamlib's own
 * `rigerror()` text, which the package reports as `hamlibMessage`, spelled out
 * here as the specification.
 */
import { RIG_ERRCODES } from 'hamlib-wasm/raw';

/**
 * Comfortably past Hamlib's default 500 ms cache, so the read that follows is
 * a real transaction rather than the cached answer.  (The package refuses the
 * `cache_timeout` conf, so a spec cannot just turn the cache off.)
 */
export const CACHE_LAPSE_MS = 600;

export const {
  EINVAL: RIG_EINVAL,
  ECONF: RIG_ECONF,
  ETIMEOUT: RIG_ETIMEOUT,
  EIO: RIG_EIO,
  EINTERNAL: RIG_EINTERNAL,
} = RIG_ERRCODES;

/** `hamlibMessage` for each code above. */
export const HAMLIB_MESSAGE = {
  [RIG_EINVAL]: 'Invalid parameter',
  [RIG_ECONF]: 'Invalid configuration',
  [RIG_ETIMEOUT]: 'Communication timed out',
  [RIG_EIO]: 'IO error',
  [RIG_EINTERNAL]: 'Internal Hamlib error',
} as const;
