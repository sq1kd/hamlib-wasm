import { defineConfig } from '@playwright/test';

/**
 * Every server the specs need serves a production build, so the artifact users
 * get is what is exercised:
 *
 *   4173  the Vanilla TypeScript example (mise run build-example)
 *   4174  the package test harness      (mise run build-harness)
 *   4175  the React landing page        (mise run build-react)
 *
 * The two `vite` dev servers are here for the same reason in the other
 * direction: a bundler rewrites the asset the module loader looks up, and it
 * does so differently in dev than in a build, so `dev-server.spec.ts` keeps
 * both paths working.
 *
 * Serving built output is deliberate: it is the artifact users get, including
 * the `new URL(..., import.meta.url)` wasm lookup the bundler rewrites.
 */
export default defineConfig({
  testDir: 'tests/browser',
  /* The browser fixtures are injected as compiled text, so they are built
   * before any spec (and its fixtures.ts import) is loaded. */
  globalSetup: './tests/browser/fixtures/compile.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: [['list']],
  expect: {
    timeout: 15_000,
  },
  timeout: 120_000,
  use: {
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'npm run preview --workspace examples/basic',
      url: 'http://127.0.0.1:4173/',
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: 'npm run preview --workspace tests/harness',
      url: 'http://127.0.0.1:4174/',
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: 'npm run preview --workspace examples/react',
      url: 'http://127.0.0.1:4175/',
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: 'npm run dev --workspace examples/basic',
      url: 'http://127.0.0.1:5173/',
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: 'npm run dev --workspace examples/react',
      url: 'http://127.0.0.1:5174/',
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
        baseURL: 'http://127.0.0.1:4173',
      },
    },
  ],
});
