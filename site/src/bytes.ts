/** A download size for a reader: `1234567` → `1.2 MB`. */
export function megabytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}
