// SPDX-License-Identifier: MIT

/** An Embind `std::vector`: a handle onto Wasm memory, not a JavaScript array. */
interface EmbindVector<T> {
  size(): number;
  get(index: number): T | undefined;
  delete(): void;
}

/**
 * Copy a vector out as a plain array of projected entries and release it.
 * The vector owns Wasm memory until `delete()`; iterating it with `Array.from`
 * would leak that.
 */
export function drainVector<T, R>(vector: EmbindVector<T>, project: (entry: T) => R): R[] {
  const entries: R[] = [];

  try {
    for (let index = 0; index < vector.size(); index++) {
      const entry = vector.get(index);

      if (entry !== undefined) {
        entries.push(project(entry));
      }
    }
  } finally {
    vector.delete();
  }

  return entries;
}
