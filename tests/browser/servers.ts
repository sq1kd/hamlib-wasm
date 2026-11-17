/**
 * Where the servers playwright.config.ts starts listen.  The config reads these
 * for its `webServer` entries and the harness `baseURL`; a spec that visits
 * another server names it from here.
 */

/** The package test harness (mise run build-harness), the specs' `baseURL`. */
export const HARNESS_ORIGIN = 'http://127.0.0.1:4174';

/** The documentation site's production build (mise run build-site). */
export const SITE_ORIGIN = 'http://127.0.0.1:4176';

/** The documentation site's `vite` dev server. */
export const SITE_DEV_ORIGIN = 'http://127.0.0.1:5176';
