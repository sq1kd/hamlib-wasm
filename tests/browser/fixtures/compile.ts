/**
 * Playwright global setup: compile the in-page browser fixtures.
 *
 * tests/browser/fixtures.ts reads `fixtures/generated/*.js` as *text* and
 * injects it with `addInitScript`, so the fixtures must be compiled before any
 * spec is loaded.  Running the fixtures' own `tsc` project here keeps the two
 * in step without teaching the mise tasks about generated fixtures.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** The repository root, three directories up from tests/browser/fixtures. */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const TSC = fileURLToPath(new URL('../../../node_modules/.bin/tsc', import.meta.url));
const PROJECT = fileURLToPath(new URL('./tsconfig.json', import.meta.url));

export default function globalSetup(): void {
  const result = spawnSync(TSC, ['-p', PROJECT], { cwd: ROOT, stdio: 'inherit' });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`the browser fixtures failed to compile (tsc exited ${result.status})`);
  }
}
