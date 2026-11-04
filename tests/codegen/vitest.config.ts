import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * The codegen unit tests: the generator's pure transforms, run against
 * hand-built clang ASTs and a committed Embind declaration excerpt.
 *
 * `root` is this directory so the include patterns stay local.  The generator
 * sources are imported by relative path, which needs no build: they are plain
 * erasable TypeScript.
 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    environment: 'node',
    include: ['*.test.ts'],
  },
});
