import { defineConfig } from '@playwright/test';

import { HARNESS_ORIGIN, SITE_DEV_ORIGIN, SITE_ORIGIN } from './tests/browser/servers';

/**
 * Every server the specs need serves a production build, so the artifact users
 * get is what is exercised, including the `new URL(..., import.meta.url)` wasm
 * lookup the bundler rewrites:
 *
 *   4174  the package test harness      (mise run build-harness)
 *   4176  the documentation site        (mise run build-site)
 *
 * (tests/browser/servers.ts holds the addresses; the harness is `baseURL`.)
 *
 * The React `vite` dev server is here for the same reason in the other
 * direction: a bundler rewrites the asset the module loader looks up, and it
 * does so differently in dev than in a build, so `dev-server.spec.ts` keeps
 * both paths working.
 *
 * Every spec runs in Chromium and in Firefox.  Neither needs the browser's own
 * Web Serial: the specs inject a double for `navigator.serial`, so what the two
 * projects compare is the library itself - Asyncify, streams, timers and the
 * bundled wasm lookup - in two engines that ship Web Serial on the desktop.
 */
export default defineConfig({
  testDir: 'tests/browser',
  /* The browser fixtures are injected as compiled text, so they are built
   * before any spec (and its fixtures.ts import) is loaded. */
  globalSetup: './tests/browser/fixtures/compile.ts',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: [['list']],
  expect: {
    timeout: 15_000,
  },
  timeout: 120_000,
  use: {
    baseURL: `${HARNESS_ORIGIN}/`,
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'npm run preview --workspace tests/harness',
      url: `${HARNESS_ORIGIN}/`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: 'npm run preview --workspace site',
      url: `${SITE_ORIGIN}/demo/`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: 'npm run dev --workspace site',
      url: `${SITE_DEV_ORIGIN}/demo/`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
    {
      name: 'firefox',
      use: { browserName: 'firefox' },
    },
  ],
});
