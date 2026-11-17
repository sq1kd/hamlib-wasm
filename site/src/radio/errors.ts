/**
 * What a panel says when something fails.
 *
 * The library's messages already name the rig, the rate and what to check, so
 * they are shown as they are, with two exceptions a reader would misread.
 * Duck-typed rather than `instanceof HamlibError`, so the landing page can
 * report a failure without loading the library.
 */
import type { HamlibErrorCode } from 'hamlib-wasm';

export function failureMessage(cause: unknown): string {
  const { name, code } = (cause ?? {}) as { name?: string; code?: HamlibErrorCode };

  /* The port chooser dismissed: a DOMException straight from Web Serial, or
   * the library's mapping of one. */
  if (name === 'NotFoundError' || code === 'PORT_PERMISSION_DENIED') {
    return 'No port chosen.';
  }

  /* Auto-detect asks one rate at a time, so the library's message would name
   * only the last rate tried. */
  if (code === 'RIG_UNRESPONSIVE') {
    return 'The radio did not answer at any baud rate. Check the cable and its CAT settings.';
  }

  return cause instanceof Error ? cause.message : String(cause);
}
