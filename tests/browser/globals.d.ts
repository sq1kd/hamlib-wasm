/**
 * Test-seam declarations for the pages the browser specs drive.
 *
 * `tests/harness/src/main.ts` publishes the package on `window`; the React
 * example publishes nothing and is driven through its DOM instead.
 */
import type { Hamlib, RigOperationCapabilities, HamlibOptions } from 'hamlib-wasm';
import type {
  RawHamlib,
  RawHamlibOptions,
  RigModel,
  SerialPortLike,
  SerialTransport,
} from 'hamlib-wasm/raw';
/* Not a package export: the harness loads the built module directly. */
import type { MainModule } from '../../packages/hamlib-wasm/dist/native/hamlib-wasm.mjs';
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
  createRawHamlib(options?: RawHamlibOptions): Promise<RawHamlib>;
  createHamlib(options?: HamlibOptions): Promise<Hamlib>;
  capabilitiesOf(model: RigModel): RigOperationCapabilities;
  /** A transport over `port`, recording every call the facade makes on it. */
  fakeTransport(port: SerialPortLike): SerialTransport & { calls: string[] };
  isHamlibError(value: unknown): boolean;
  /** Loads the built Emscripten module (a separate wasm instance). */
  nativeModule(): Promise<NativeModule>;
  /** The generated name vocabularies, as the package exports them. */
  vocabularies: Readonly<Record<string, readonly string[]>>;
}

export interface TestHelpers {
  describeError(value: unknown): HamlibErrorView;
  capture<T>(action: () => T | Promise<T>): Promise<Captured<T>>;
}

declare global {
  interface Window {
    __hamlibHarness: HamlibHarness;
    __testHelpers: TestHelpers;
    __hookHarness: HookHarness;
    /** A hook call a spec started and settles later, on the virtual clock. */
    __pendingHookCall: Promise<string> | undefined;
  }
}
