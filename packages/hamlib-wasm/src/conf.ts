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

/**
 * Hamlib configuration tokens to apply before the rig opens, by name.
 *
 * ```ts
 * await hamlib.open({ modelId, port, conf: { civaddr: '0x94', ptt_type: 'RTS' } });
 * ```
 */
export type RigConf = Readonly<Record<string, string | number | boolean>>;

/** Tokens the facade sets itself, with what to use instead. */
const OWNED: Readonly<Record<string, string>> = {
  rig_pathname: 'the port is the one passed to open()',
  serial_speed: 'pass baudRate instead',
  async: 'this build has no asynchronous data path',
  poll_interval: 'this build has no polling thread; use watch()',
  cache_timeout: 'the facade keeps Hamlib\'s default so a read after a write stays coherent',
  auto_power_on: 'switch the rig on with setPowerstat()',
  auto_power_off: 'switch the rig off with setPowerstat()',
};

/** Tokens that need a device or a thread this build cannot reach. */
const UNREACHABLE: Readonly<Record<string, string>> = {
  ptt_pathname: 'PTT on a second port is not supported; use ptt_type RTS or DTR on the rig\'s port',
  dcd_pathname: 'DCD on a second port is not supported; use dcd_type CTS, DSR or CD on the rig\'s port',
  ptt_share: 'PTT on a second port is not supported',
  ptt_bitnum: 'parallel, CM108 and GPIO lines are not reachable from here',
  tuner_control_pathname: 'a tuner control device is not reachable from here',
  flushx: 'named-pipe ports are not reachable from here',
  multicast_data_addr: 'this build has no network transport',
  multicast_data_port: 'this build has no network transport',
  multicast_cmd_addr: 'this build has no network transport',
  multicast_cmd_port: 'this build has no network transport',
  client: 'this build has no network transport',
};

/** The `ptt_type`/`dcd_type` values whose line is the rig's own serial port. */
const PTT_TYPES: ReadonlySet<string> = new Set(['RIG', 'RIGMICDATA', 'DTR', 'RTS', 'None']);
const DCD_TYPES: ReadonlySet<string> = new Set(['RIG', 'DSR', 'CTS', 'CD', 'None']);

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
    const value = String(raw);

    if (!/^[a-z][a-z0-9_]*$/.test(name)) {
      refuse(`conf token "${name}" is not a Hamlib token name`, operation);
    }

    if (/[\r\n]/.test(value)) {
      refuse(`conf token "${name}" has a value with a line break`, operation);
    }

    const owned = OWNED[name];

    if (owned !== undefined) {
      refuse(`conf token "${name}" is set by hamlib-wasm itself: ${owned}`, operation);
    }

    const unreachable = UNREACHABLE[name];

    if (unreachable !== undefined) {
      refuse(`conf token "${name}" is not supported: ${unreachable}`, operation);
    }

    if (name === 'ptt_type' && !PTT_TYPES.has(value)) {
      refuse(
        `ptt_type "${value}" is not supported; use one of ${[...PTT_TYPES].join(', ')}`,
        operation,
      );
    }

    if (name === 'dcd_type' && !DCD_TYPES.has(value)) {
      refuse(
        `dcd_type "${value}" is not supported; use one of ${[...DCD_TYPES].join(', ')}`,
        operation,
      );
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
