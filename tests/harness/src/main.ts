/// <reference path="../../browser/globals.d.ts" />

/**
 * Test harness entry point.
 *
 * Exposes the built package on the page so Playwright specs can drive it
 * directly with `page.evaluate`, using the same artifacts the example uses.
 * `nativeModule()` additionally loads the published native module, so the
 * transport primitives behind the facade can be exercised on their own.
 *
 * Both package entries are published: `hamlib-web/native` (createHamlib) and
 * the easy `hamlib-web` (createEasy and capabilitiesOf), so a spec can drive
 * either surface against the same emulator.
 */
import { capabilitiesOf, createEasy } from 'hamlib-web';
import * as hamlibWeb from 'hamlib-web/native';
import createNativeModule from 'hamlib-web/wasm';
import type { MainModule } from 'hamlib-web/wasm';

let nativeModule: Promise<MainModule> | null = null;

window.__hamlibHarness = {
  createHamlib: hamlibWeb.createHamlib,
  createEasy,
  capabilitiesOf,
  isHamlibError: (value: unknown): boolean => value instanceof hamlibWeb.HamlibError,
  nativeModule: (): Promise<MainModule> => {
    nativeModule ??= createNativeModule();
    return nativeModule;
  },
};
