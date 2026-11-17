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

/**
 * What a model can do, as booleans a UI can test.
 *
 * The catalogue's {@link RigModel.capabilities} set is the source; this is the
 * one interpretation of it both layers make.
 */
export interface RigOperationCapabilities {
  /** The rig can report its frequency ({@link Rig.refresh} includes `frequency`). */
  getFrequency: boolean;
  /** {@link Rig.setFrequency} is available. */
  setFrequency: boolean;
  /** The rig can report its mode and passband. */
  getMode: boolean;
  /** {@link Rig.setMode} and {@link Rig.setPassband} are available. */
  setMode: boolean;
  /** The rig can report push-to-talk ({@link Rig.refresh} includes `ptt`). */
  getPtt: boolean;
  /** {@link Rig.setPtt} is available. */
  setPtt: boolean;
  /** {@link Rig.sendMorse} is available: the backend has a keyer command. */
  sendMorse: boolean;
  /** {@link Rig.stopMorse} can also stop the rig mid-message, not only drop the unsent rest. */
  stopMorse: boolean;
}

/** Project a capability test - a model's set, or a rig's own view - onto the booleans. */
export function operationCapabilities(can: (operation: string) => boolean): RigOperationCapabilities {
  return {
    getFrequency: can('getFrequency'),
    setFrequency: can('setFrequency'),
    getMode: can('getMode'),
    setMode: can('setMode'),
    getPtt: can('getPtt'),
    setPtt: can('setPtt'),
    sendMorse: can('sendMorse'),
    stopMorse: can('stopMorse'),
  };
}

/** What a rig model can do over a serial transport; see {@link RigOperationCapabilities}. */
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

/** Serial parity a backend declares: one of `SERIAL_PARITIES`, named from Hamlib's `serial_parity_e`. */
export type { SerialParity } from './native/generated/names.js';
import type { SerialParity } from './native/generated/names.js';

/** Serial flow control a backend declares: one of `SERIAL_HANDSHAKES`, named from Hamlib's `serial_handshake_e`. */
export type { SerialHandshake } from './native/generated/names.js';
import type { SerialHandshake } from './native/generated/names.js';

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
   * first - the order Hamlib's own default already prefers; see
   * {@link baudRateCandidates}.
   */
  rates?: readonly number[];
  /**
   * Hamlib configuration tokens for each probe, as for `open()`.  A token the
   * link depends on - an Icom `civaddr` the rig was changed to - has to be
   * here too, or no rate will answer.
   */
  conf?: RigConf;
}
