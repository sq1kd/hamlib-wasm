import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * The Node transport checks: the built package, run by Node itself, against the
 * emulated rigs the browser suite already uses.
 *
 * `root` is this directory so the include patterns stay local.  `hamlib-wasm` is
 * *externalized* - the mirror image of the `inline` in
 * tests/hooks/vitest.config.ts - so Node's own loader loads the built ESM
 * entry point and the real `dist/native/hamlib-wasm.wasm` next to it, instead of
 * vite-node transforming them.  What is under test is the published artifact.
 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    environment: 'node',
    include: ['*.test.ts'],
    setupFiles: ['./setup.ts'],
    server: {
      deps: {
        external: ['hamlib-wasm'],
      },
    },
  },
});
