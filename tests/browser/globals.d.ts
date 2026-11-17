/**
 * Test-seam declarations for the pages the browser specs drive.
 *
 * `tests/harness/src/main.ts` publishes the package on `window`; the site's
 * demo page publishes nothing and is driven through its DOM instead.  What the
 * injected fixtures publish is declared in fixtures/fixtures-globals.d.ts.
 */
import type { Hamlib, HamlibOptions } from 'hamlib-wasm';
import type {
  RawHamlib,
  RawHamlibOptions,
  SerialPortLike,
  SerialTransport,
} from 'hamlib-wasm/raw';
/* Not a package export: the harness loads the built module directly. */
import type { MainModule } from '../../packages/hamlib-wasm/dist/native/hamlib-wasm.mjs';
import type { HookHarness } from '../harness/src/hook-harness-types';

export type NativeModule = MainModule;

export interface HamlibHarness {
  createRawHamlib(options?: RawHamlibOptions): Promise<RawHamlib>;
  createHamlib(options?: HamlibOptions): Promise<Hamlib>;
  /** A transport over `port`, recording every call the facade makes on it. */
  fakeTransport(port: SerialPortLike): SerialTransport & { calls: string[] };
  isHamlibError(value: unknown): boolean;
  /** Loads the built Emscripten module (a separate wasm instance). */
  nativeModule(): Promise<NativeModule>;
  /** The generated name vocabularies, as the package exports them. */
  vocabularies: Readonly<Record<string, readonly string[]>>;
  /** The passband widths the package exports, which Hamlib's docs name. */
  passbands: { readonly RIG_PASSBAND_NORMAL: number; readonly RIG_PASSBAND_NOCHANGE: number };
}

declare global {
  interface Window {
    __hamlibHarness: HamlibHarness;
    __hookHarness: HookHarness;
    /** A hook call a spec started and settles later, on the virtual clock. */
    __pendingHookCall: Promise<string> | undefined;
  }
}
