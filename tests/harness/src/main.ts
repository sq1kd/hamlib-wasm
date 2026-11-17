/// <reference path="../../browser/globals.d.ts" />

/**
 * Test harness entry point.
 *
 * Exposes the built package on the page so Playwright specs can drive it
 * directly with `page.evaluate`, using the same artifacts an application gets.
 *
 * Both browser entries are published: `hamlib-wasm/raw` (createRawHamlib) and
 * the default `hamlib-wasm` (createHamlib and capabilitiesOf), so a spec can drive
 * either surface against the same emulator.
 *
 * `nativeModule()` additionally loads the built Emscripten module, so the
 * transport primitives behind the facade can be exercised on their own.  The
 * package does not export that module - raw access would bypass the queue every
 * public call goes through - so the harness reaches into the build output.
 */
import { capabilitiesOf, createHamlib } from 'hamlib-wasm';
import * as hamlibWasm from 'hamlib-wasm/raw';
import type { SerialPortLike, SerialTransport } from 'hamlib-wasm/raw';
import createNativeModule from '../../../packages/hamlib-wasm/dist/native/hamlib-wasm.mjs';
import type { MainModule } from '../../../packages/hamlib-wasm/dist/native/hamlib-wasm.mjs';

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
  createRawHamlib: hamlibWasm.createRawHamlib,
  createHamlib,
  capabilitiesOf,
  fakeTransport,
  isHamlibError: (value: unknown): boolean => value instanceof hamlibWasm.HamlibError,
  vocabularies: {
    RIG_MODES: hamlibWasm.RIG_MODES,
    VFOS: hamlibWasm.VFOS,
    LEVELS: hamlibWasm.LEVELS,
    FUNCS: hamlibWasm.FUNCS,
    PARMS: hamlibWasm.PARMS,
    VFO_OPS: hamlibWasm.VFO_OPS,
    SCAN_OPS: hamlibWasm.SCAN_OPS,
    RPTR_SHIFTS: hamlibWasm.RPTR_SHIFTS,
  },
  nativeModule: (): Promise<MainModule> => {
    nativeModule ??= createNativeModule();
    return nativeModule;
  },
};
