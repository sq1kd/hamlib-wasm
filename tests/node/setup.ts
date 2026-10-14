/**
 * Node has no `window`; the emulated rigs in tests/browser/fixtures do.
 *
 * `rigs.ts` is a standalone browser script that publishes its registry on
 * `window.__fakeRigRegistry`, exactly as it does in the page.  Aliasing
 * `window` to the global object is what lets the same, single source of
 * emulator protocols run here - no second implementation to keep in step.
 */
(globalThis as { window?: unknown }).window ??= globalThis;
