import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * The hardware checks: real rigs, driven through the published package.
 *
 * `root` is this directory so the include patterns stay local.  `hamlib-wasm` is
 * *externalized* - the mirror image of the `inline` in
 * tests/hooks/vitest.config.ts - so Node's own loader loads the built ESM entry
 * points and the real `dist/native/hamlib-wasm.wasm` next to them, instead of
 * vite-node transforming them.  What runs against the rig is the artifact an
 * application installs.
 *
 * Files never run in parallel: there is one rig and one serial port, and a
 * second open while the first is live fails as `Resource busy`.  The timeout
 * covers a real open plus a `detectBaudRate()` scan, which is many opens.
 *
 * The reporter is explicit because this suite runs for its output: each test
 * prints one line naming the rig, the port, the rate and the reading, and the
 * default reporter drops what a passing test wrote.  The per-file lines also
 * make it obvious that a run without a selection skipped on purpose.
 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    environment: 'node',
    include: ['*.test.ts'],
    fileParallelism: false,
    reporters: 'verbose',
    testTimeout: 30_000,
    server: {
      deps: {
        external: ['hamlib-wasm'],
      },
    },
  },
});
