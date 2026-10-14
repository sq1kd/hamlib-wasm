/// <reference path="../../browser/globals.d.ts" />

/**
 * Test harness entry point.
 *
 * Exposes the built package on the page so Playwright specs can drive it
 * directly with `page.evaluate`, using the same artifacts the example uses.
 * `nativeModule()` additionally loads the published native module, so the
 * transport primitives behind the facade can be exercised on their own.
 *
 * Both package entries are published: `hamlib-wasm/hamlib` (createHamlib) and
 * the easy `hamlib-wasm` (createEasy and capabilitiesOf), so a spec can drive
 * either surface against the same emulator.
 */
import { capabilitiesOf, createEasy } from 'hamlib-wasm';
import * as hamlibWasm from 'hamlib-wasm/hamlib';
import type { SerialPortLike, SerialTransport } from 'hamlib-wasm/hamlib';
import createNativeModule from 'hamlib-wasm/native';
import type { MainModule } from 'hamlib-wasm/native';

let nativeModule: Promise<MainModule> | null = null;

/**
 * A transport a spec can inject, over a port the spec hands it.
 *
 * It is the smallest possible implementation of the contract - the point being
 * that the facade drives a rig through *any* object of this shape, not only
 * through Web Serial.  `calls` records what the facade asked it for, so a spec
 * can assert the facade used the injected transport rather than the browser's.
 * The port is a parameter rather than the page's fake Web Serial device
 * because this page publishes the package, not the fixture.
 */
function fakeTransport(port: SerialPortLike): SerialTransport & { calls: string[] } {
  const calls: string[] = [];

  return {
    name: 'test',
    calls,
    isSupported: () => true,
    requestPort: async () => {
      calls.push('requestPort');
      return port;
    },
  };
}

window.__hamlibHarness = {
  createHamlib: hamlibWasm.createHamlib,
  createEasy,
  capabilitiesOf,
  fakeTransport,
  isHamlibError: (value: unknown): boolean => value instanceof hamlibWasm.HamlibError,
  nativeModule: (): Promise<MainModule> => {
    nativeModule ??= createNativeModule();
    return nativeModule;
  },
};
