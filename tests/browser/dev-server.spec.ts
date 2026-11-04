/**
 * The dev server.
 *
 * A module loader resolves the wasm relative to its own URL, and the bundler
 * serving that module rewrites the lookup: the *build* path (the preview
 * servers the other specs use) and the *dev* path rewrite it differently.  A
 * single template-literal lookup made Vite dev read `./native/${file}` as a
 * glob, which it resolved to a module import of every file in the directory -
 * the wasm among them, as a JavaScript stub - so the module never instantiated
 * and the page sat on "loading…".
 *
 * This asserts the observable outcome in dev: the version the module reports
 * renders, and the browser really fetched the binary.
 */
import { expect, test } from '@playwright/test';

const REACT_DEV_URL = 'http://127.0.0.1:5176/demo/';

test('the documentation site demo instantiates the module in dev mode', async ({ page }) => {
  const failures: string[] = [];

  page.on('pageerror', (error) => {
    failures.push(error.message);
  });

  await page.goto(REACT_DEV_URL);
  await page.getByTestId('load-demo').click();

  /* The element reads "Hamlib: loading…" until the whole chain resolved:
   * the module, its default asset lookup and the wasm. */
  await expect(page.getByTestId('hamlib-version')).toContainText('Hamlib 4.', {
    timeout: 30_000,
  });

  const wasm = await page.evaluate(() => performance.getEntriesByType('resource')
    .filter((entry) => entry.name.includes('hamlib-wasm.wasm'))
    .map((entry) => {
      const resource = entry as PerformanceResourceTiming;

      return { url: resource.name, bytes: resource.transferSize };
    }));

  /* The real binary, not the stub a glob lookup hands back. */
  expect(wasm.length).toBeGreaterThan(0);
  expect(Math.max(...wasm.map((entry) => entry.bytes))).toBeGreaterThan(1_000_000);
  expect(wasm.every((entry) => !entry.url.includes('?import'))).toBe(true);
  expect(failures).toEqual([]);
});
