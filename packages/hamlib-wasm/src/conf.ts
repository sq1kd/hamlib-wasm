// SPDX-License-Identifier: MIT

/**
 * Hamlib configuration tokens a caller may set when opening a rig.
 *
 * Every token goes through Hamlib's own `rig_token_lookup()` +
 * `rig_set_conf()`, so the names and values are Hamlib's: the frontend tokens
 * in upstream `src/conf.c` (`write_delay`, `timeout`, `ptt_type`, ...) and the
 * backend's own (`civaddr` on Icom, ...), as `RawRig.tokenForeach()` lists
 * them.  This module refuses, before the port is touched, the tokens the
 * facade sets itself and the ones that would need something this build does
 * not have: a second port, a parallel or GPIO line, a network socket.
 */

import { HamlibError } from './errors.js';
import { type LINE_DATA_BITS, type LINE_HANDSHAKES, type LINE_PARITIES, type LINE_STOP_BITS, OWNED_CONF, UNREACHABLE_CONF } from './native/generated/names.js';
import type { OwnedConfToken, UnreachableConfToken } from './native/generated/names.js';

/** The `ptt_type`/`dcd_type` values whose line is the rig's own serial port. */
const PTT_TYPES = ['RIG', 'RIGMICDATA', 'DTR', 'RTS', 'None'] as const;
const DCD_TYPES = ['RIG', 'DSR', 'CTS', 'CD', 'None'] as const;

/**
 * Hamlib's frontend tokens (upstream `src/conf.c`) that work here, typed with
 * the values Hamlib accepts.  Times are milliseconds, offsets hertz.
 */
export interface FrontendConf {
  /** Delay between two bytes written. */
  readonly write_delay?: number;
  /** Delay after each command written. */
  readonly post_write_delay?: number;
  /** Delay after a PTT change. */
  readonly post_ptt_delay?: number;
  /** How long a reply may take. */
  readonly timeout?: number;
  /** Attempts per command. */
  readonly retry?: number;
  /** Extra read attempts after a timeout. */
  readonly timeout_retry?: number;
  /** Push-to-talk through CAT, or on the rig port's RTS/DTR line. */
  readonly ptt_type?: (typeof PTT_TYPES)[number];
  /** Squelch status through CAT, or from the rig port's DSR/CTS/CD line. */
  readonly dcd_type?: (typeof DCD_TYPES)[number];
  /** RTS while the port is open: some interfaces are powered from it. */
  readonly rts_state?: 'Unset' | 'ON' | 'OFF';
  /** DTR while the port is open. */
  readonly dtr_state?: 'Unset' | 'ON' | 'OFF';
  /** Override the backend's flow control (XON/XOFF is not supported). */
  readonly serial_handshake?: Capitalize<(typeof LINE_HANDSHAKES)[number]>;
  readonly data_bits?: (typeof LINE_DATA_BITS)[number];
  readonly stop_bits?: (typeof LINE_STOP_BITS)[number];
  readonly serial_parity?: Capitalize<(typeof LINE_PARITIES)[number]>;
  /** VFO compensation, in parts per million. */
  readonly vfo_comp?: number;
  /** Local oscillator frequency of a transverter, in hertz. */
  readonly lo_freq?: number;
  readonly offset_vfoa?: number;
  readonly offset_vfob?: number;
  readonly twiddle_timeout?: number;
  readonly twiddle_rit?: boolean;
  readonly disable_yaesu_bandselect?: boolean;
  readonly auto_disable_screensaver?: boolean;
  readonly freq_skip?: boolean;
  readonly range_list_number?: number;
  readonly range_list_name?: string;
  readonly device_id?: string;
}

/** Tokens hamlib-wasm sets itself or cannot honour; see {@link encodeConf}. */
type RefusedToken = OwnedConfToken | UnreachableConfToken;

/**
 * Hamlib configuration tokens to apply before the rig opens, by name.
 *
 * The frontend tokens are typed ({@link FrontendConf}); the ones hamlib-wasm
 * refuses are `never`, so passing one is a compile error.  A backend's own
 * tokens (`civaddr` on Icom, ...) differ per model - `RawRig.tokenForeach()`
 * lists them - so any other name is accepted as a string, number or boolean,
 * and Hamlib refuses an unknown one when the rig opens.
 *
 * ```ts
 * await hamlib.open({ modelId, port, conf: { civaddr: '0x94', ptt_type: 'RTS' } });
 * ```
 */
export type RigConf = FrontendConf
  & { readonly [token in RefusedToken]?: never }
  & { readonly [backendToken: string]: string | number | boolean | undefined };

/** Whether `value` is one of `values`. */
function isOneOf(values: readonly string[], value: string): boolean {
  return values.includes(value);
}

function refuse(message: string, operation: string): never {
  throw new HamlibError(message, { code: 'INVALID_ARGUMENT', operation });
}

/**
 * Validate `conf` and encode it as the `name=value` lines the facade applies.
 * An empty or absent `conf` encodes to the empty string.
 */
export function encodeConf(conf: RigConf | undefined, operation: string): string {
  if (conf === undefined) {
    return '';
  }

  if (typeof conf !== 'object' || conf === null) {
    refuse('conf must be an object of Hamlib token names to values', operation);
  }

  const lines: string[] = [];

  for (const [name, raw] of Object.entries(conf)) {
    if (raw === undefined) {
      continue;
    }

    /* Hamlib reads its on/off tokens as integers. */
    const value = typeof raw === 'boolean' ? (raw ? '1' : '0') : String(raw);

    if (!/^[a-z][a-z0-9_]*$/.test(name)) {
      refuse(`conf token "${name}" is not a Hamlib token name`, operation);
    }

    if (/[\r\n]/.test(value)) {
      refuse(`conf token "${name}" has a value with a line break`, operation);
    }

    if (Object.hasOwn(OWNED_CONF, name)) {
      refuse(`conf token "${name}" is set by hamlib-wasm itself: ${OWNED_CONF[name as OwnedConfToken]}`, operation);
    }

    if (Object.hasOwn(UNREACHABLE_CONF, name)) {
      refuse(`conf token "${name}" is not supported: ${UNREACHABLE_CONF[name as UnreachableConfToken]}`, operation);
    }

    if (name === 'ptt_type' && !isOneOf(PTT_TYPES, value)) {
      refuse(`ptt_type "${value}" is not supported; use one of ${PTT_TYPES.join(', ')}`, operation);
    }

    if (name === 'dcd_type' && !isOneOf(DCD_TYPES, value)) {
      refuse(`dcd_type "${value}" is not supported; use one of ${DCD_TYPES.join(', ')}`, operation);
    }

    lines.push(`${name}=${value}`);
  }

  return lines.join('\n');
}

/**
 * Whether `conf` moves push-to-talk onto the port's RTS or DTR line, which
 * makes PTT available to a model whose backend declares none of its own.
 */
export function confKeysPttLine(conf: RigConf | undefined): boolean {
  const type = conf?.ptt_type;

  return type === 'RTS' || type === 'DTR';
}
