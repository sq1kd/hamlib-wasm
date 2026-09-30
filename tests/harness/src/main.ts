/// <reference path="../../browser/globals.d.ts" />

/**
 * Test harness entry point.
 *
 * Exposes the built package on the page so Playwright specs can drive it
 * directly with `page.evaluate`, using the same artifacts the example uses.
 * `nativeModule()` additionally loads the published native module, so the
 * transport primitives behind the facade can be exercised on their own.
 */
import * as hamlibWeb from 'hamlib-web';
import createNativeModule from 'hamlib-web/native';
import type { MainModule } from 'hamlib-web/native';

let nativeModule: Promise<MainModule> | null = null;

window.__hamlibHarness = {
  createHamlib: hamlibWeb.createHamlib,
  isHamlibError: (value: unknown): boolean => value instanceof hamlibWeb.HamlibError,
  nativeModule: (): Promise<MainModule> => {
    nativeModule ??= createNativeModule();
    return nativeModule;
  },
};
