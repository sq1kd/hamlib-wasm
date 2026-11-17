interface NetworkInformation {
  readonly saveData?: boolean;
  readonly effectiveType?: string;
}

/**
 * Whether the reader asked to save data, or is on a 2G-class link: then no
 * page fetches the Hamlib module unprompted.  Browsers without the Network
 * Information API (Firefox, Safari) are never constrained.
 */
export function constrainedConnection(): boolean {
  const connection = (navigator as { connection?: NetworkInformation }).connection;

  return connection?.saveData === true || connection?.effectiveType === 'slow-2g' || connection?.effectiveType === '2g';
}
