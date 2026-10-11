/**
 * Test-seam declarations for the pages the browser specs drive.
 *
 * `tests/harness/src/main.ts` publishes the package on `window`; the example
 * publishes nothing and is driven through its DOM instead.
 */
import type { EasyCapabilities, EasyHamlib } from 'hamlib-web';
import type { Hamlib, HamlibOptions, RigModel } from 'hamlib-web/native';
import type { MainModule } from 'hamlib-web/wasm';
import type { HookHarness } from '../harness/src/hook-harness-types';

export type NativeModule = MainModule;

export interface HamlibErrorView {
  name: string | null;
  message: string;
  code: string | null;
  operation: string | null;
  hamlibCode: number | null;
  hamlibMessage: string | null;
  /** `name: message` of the wrapped cause, when there is one. */
  cause: string | null;
  isHamlibError: boolean;
}

export type Captured<T> =
  | { ok: true; value: T }
  | { ok: false; error: HamlibErrorView };

export interface HamlibHarness {
  createHamlib(options?: HamlibOptions): Promise<Hamlib>;
  createEasy(options?: HamlibOptions): Promise<EasyHamlib>;
  capabilitiesOf(model: RigModel): EasyCapabilities;
  isHamlibError(value: unknown): boolean;
  /** Loads the published Emscripten module (a separate wasm instance). */
  nativeModule(): Promise<NativeModule>;
}

export interface TestHelpers {
  describeError(value: unknown): HamlibErrorView;
  capture<T>(action: () => T | Promise<T>): Promise<Captured<T>>;
  sleep(ms: number): Promise<void>;
}

declare global {
  interface Window {
    __hamlibHarness: HamlibHarness;
    __testHelpers: TestHelpers;
    __hookHarness: HookHarness;
  }
}

export {};
