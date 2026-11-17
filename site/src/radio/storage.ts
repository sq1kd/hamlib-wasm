/**
 * What a returning reader chose last time, shared by both panels so the
 * landing page and the demo page remember the same radio.
 *
 * Storage may be disabled, or absent while the site renders at build time; a
 * panel then simply forgets.
 */

/** The model picked last time. */
export const MODEL_KEY = 'hamlib-demo:model';

/** The rate a model last answered at, per model id. */
export function rateKey(modelId: number): string {
  return `hamlib-demo:baud:${String(modelId)}`;
}

export function recall(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Nothing to do: the next visit starts from the defaults. */
  }
}
