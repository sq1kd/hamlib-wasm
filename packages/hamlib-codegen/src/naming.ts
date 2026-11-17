// SPDX-License-Identifier: MIT

/**
 * How a C name becomes a generated one.  Every generated method, field and
 * type name follows these two rules; `hamlib.config.yaml` only records the
 * names that are a real rename rather than a respelling.
 *
 * Authored as TypeScript and run directly by Node's type stripping, so this
 * file must stay erasable (no enums, namespaces or parameter properties).
 */

/** `chan_list` -> `ChanList`; `getSplitMode` -> `GetSplitMode`. */
export function pascalCase(name: string): string {
  return name
    .split('_')
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join('');
}

/** `tx_freq` -> `txFreq`; `get_rptr_offs` -> `getRptrOffs`. */
export function camelCase(name: string): string {
  const pascal = pascalCase(name);

  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}
