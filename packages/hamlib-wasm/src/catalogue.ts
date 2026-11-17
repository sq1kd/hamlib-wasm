// SPDX-License-Identifier: MIT

/**
 * The rig model catalogue and the mode vocabulary, shared by both API layers.
 *
 * Declared here rather than in either entry point, so the API reference
 * documents them once, under the default entry, and `hamlib-wasm/raw`
 * re-exports them.
 */

import type { BrowserSupport, VERIFIED_MODELS } from './browser-support.js';
import type { RigConf } from './conf.js';
import type { SerialPortLike } from './transport.js';

/** What a rig model can do over a serial transport. */
export interface RigModelCapabilities {
  canGetFrequency: boolean;
  canSetFrequency: boolean;
  canGetMode: boolean;
  canSetMode: boolean;
  canGetPtt: boolean;
  canSetPtt: boolean;
}

/** A rig model reachable over a serial transport, sorted by manufacturer then model. */
export interface RigModel extends RigModelCapabilities {
  /** Hamlib model id, the `modelId` to open the rig with. */
  id: number;
  manufacturer: string;
  model: string;
  /** Upstream backend version string. */
  backendVersion: string;
  /** Hamlib driver status bit field (`RIG_STATUS_*`). */
  status: number;
  /** Lowest baud rate the backend advertises. */
  serialRateMin: number;
  /** Highest baud rate the backend advertises. */
  serialRateMax: number;
  /** Serial data bits the backend declares. */
  serialDataBits: number;
  /** Serial stop bits the backend declares. */
  serialStopBits: number;
  /** Serial parity the backend declares. */
  serialParity: SerialParity;
  /** Serial flow control the backend declares. */
  serialHandshake: SerialHandshake;
  /**
   * `"verified"` when a browser test in this package drives the model through
   * the Web Serial double; `"candidate"` when only Hamlib's
   * `RIG_PORT_SERIAL` classification backs it.
   *
   * It reports emulator coverage only, not hardware runs - see
   * {@link VERIFIED_MODELS}.
   */
  support: BrowserSupport;
  /**
   * Names of the generated operations this model implements, from its
   * `rig_caps` function pointers.  A name that is absent means the matching
   * generated method on `RawRig` is refused with `UNSUPPORTED_OPERATION`
   * before reaching Wasm.
   *
   * A set, not an array: it is built once per model from the native capability
   * list and every gate tests membership.
   */
  readonly capabilities: ReadonlySet<string>;
  /**
   * Why the browser build cannot drive the model, when it cannot.
   *
   * Set when the backend declares line settings Web Serial cannot express - an
   * open then fails with `-RIG_ECONF` before the port is touched - or when a
   * recorded reason applies, which may instead fail during the open.  Either
   * way it fails predictably rather than half working.
   */
  limitation?: string;
}

/**
 * A Hamlib mode name, e.g. `"USB"`, `"CW"`, `"FM"`: one of `RIG_MODES`,
 * generated from the pinned release's own table, so the set follows upstream
 * on every bump.  Which modes a given rig accepts is still the rig's call.
 */
export type { RigMode } from './native/generated/names.js';
import type { RigMode } from './native/generated/names.js';

/** Serial parity a backend declares. */
export type SerialParity = 'none' | 'odd' | 'even' | 'mark' | 'space';

/** Serial flow control a backend declares. */
export type SerialHandshake = 'none' | 'xon-xoff' | 'hardware';

/** Mode and passband as reported by the rig. */
export interface RigModeState {
  mode: RigMode;
  /** Passband width in Hz. */
  passband: number;
}

/** Options for `detectBaudRate()`, on either API layer. */
export interface DetectBaudRateOptions {
  /** Model id taken from {@link RigModel.id}. */
  modelId: number;
  /** A port from `requestPort()`. */
  port: SerialPortLike;
  /**
   * Rates to try, in the order to try them.
   *
   * Defaults to the standard UART rates inside the model's declared range
   * ({@link RigModel.serialRateMin}..{@link RigModel.serialRateMax}), highest
   * first - the order Hamlib's own default already prefers.
   */
  rates?: readonly number[];
  /**
   * Hamlib configuration tokens for each probe, as for `open()`.  A token the
   * link depends on - an Icom `civaddr` the rig was changed to - has to be
   * here too, or no rate will answer.
   */
  conf?: RigConf;
}
