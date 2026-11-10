/**
 * Development only: `?emulate` on the dev server swaps Web Serial for the test
 * suite's double, answering as the emulated Kenwood TS-480, so both panels
 * connect, poll and take every control with no radio on the desk.
 *
 * The scripts are the suite's own (tests/browser/fixtures), loaded through a
 * glob the type checker does not follow; a production build drops them.
 */

/** The model the double speaks; the panels pick it while emulating. */
export const EMULATED_MODEL = 'TS-480';

const FIXTURES = import.meta.env.DEV
  ? import.meta.glob(['../../../tests/browser/fixtures/rigs.ts', '../../../tests/browser/fixtures/fake-serial.ts'])
  : {};

let installed: Promise<boolean> | undefined;

/** Install the double when asked for; whether the page is emulating. */
export function emulate(): Promise<boolean> {
  installed ??= (async () => {
    if (!import.meta.env.DEV || !new URLSearchParams(location.search).has('emulate')) {
      return false;
    }

    /* The registry of rigs first: the port picks its rig from it. */
    await FIXTURES['../../../tests/browser/fixtures/rigs.ts']?.();
    await FIXTURES['../../../tests/browser/fixtures/fake-serial.ts']?.();

    return 'serial' in navigator;
  })();

  return installed;
}
