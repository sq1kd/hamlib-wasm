/**
 * The emulated rigs, from the browser fixture, for the Node tests.
 *
 * tests/browser/fixtures/rigs.ts is a protocol emulator and nothing else: it
 * decodes host bytes and returns reply bytes.  Importing it here (its own file,
 * not a copy) is what keeps one source of truth for every CAT protocol this
 * repository tests, in the browser and in Node alike.
 */
import '../browser/fixtures/rigs.ts';

/** Instantiate an emulated rig by its registry name. */
export function fakeRig(name = 'kenwood-ts480'): FakeRig {
  const factory = window.__fakeRigRegistry[name];

  if (!factory) {
    throw new Error(`unknown emulated rig "${name}"`);
  }

  return factory();
}
