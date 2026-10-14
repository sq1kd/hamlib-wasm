import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * The hook unit tests: React's own hooks against a stubbed package boundary,
 * in jsdom rather than a browser.
 *
 * `root` is this directory so the include patterns stay local, and the
 * package's built entry point is resolved from the workspace root as usual.
 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    environment: 'jsdom',
    include: ['*.test.tsx'],
    setupFiles: ['./setup.ts'],
    server: {
      deps: {
        /* `hamlib-wasm` is a workspace symlink, which vitest would otherwise
         * hand to Node's own ESM loader - and a module loaded that way cannot
         * be replaced by `vi.mock`.  Inlining it runs the built hooks through
         * vite-node so the stubbed entry point takes effect. */
        inline: ['hamlib-wasm'],
      },
    },
  },
});
