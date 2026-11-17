// SPDX-License-Identifier: MIT

/**
 * What an instance remembers about its recent past, for a bug report.
 *
 * Three bounded buffers - Hamlib's debug lines (only once `debug` is set), the
 * bytes each port sent and received, and the errors calls failed with - and a
 * report that bundles them with the versions, the runtime and the open rigs.
 * Nothing leaves the page unless the caller sends it somewhere.
 */

import { HamlibError } from './errors.js';
import { bytesToHex } from './hex.js';
import { describeRuntime } from './runtime.js';
import { DEBUG_LEVEL_VALUES, DEBUG_LEVELS } from './native/generated/names.js';
import type { DebugLevel, DebugLevelValue } from './native/generated/names.js';

/** Hamlib's `rig_debug_level_e`, quietest first: one of `DEBUG_LEVELS`. */
export type { DebugLevel } from './native/generated/names.js';

/** Options for Hamlib's debug output; see {@link RawHamlibOptions.debug}. */
export interface DebugOptions {
  /**
   * How much Hamlib logs.  Default `'verbose'`: each command's intent and
   * result.  `'trace'` adds every function entry and exit; `'cache'` adds the
   * cache bookkeeping too.
   */
  level?: DebugLevel;
  /** Called with every line as it is logged.  Default: none - the lines are only kept for {@link RawHamlib.diagnostics}. */
  onLog?: (entry: LogEntry) => void;
}

/** One Hamlib debug line. */
export interface LogEntry {
  /** `Date.now()` when it was logged. */
  time: number;
  level: DebugLevel;
  message: string;
}

/** One chunk the transport wrote or read. */
export interface TraceEntry {
  time: number;
  direction: 'tx' | 'rx';
  /** The logical port path (`serial/<n>`) the rig was opened on. */
  path: string;
  /** The bytes, as lower-case hex. */
  hex: string;
}

/** One failed call. */
export interface ErrorEntry {
  time: number;
  operation: string;
  code: string;
  message: string;
}

/** An open rig, as the report lists it. */
export interface DiagnosticsRig {
  path: string;
  modelId: number;
  manufacturer: string;
  model: string;
  backendVersion: string;
  baudRate: number;
  connected: boolean;
  /** USB ids the port reported, lower-case hex, when it reported any. */
  usb?: { vendorId: string; productId: string };
}

/**
 * Everything a bug report about a rig needs, as plain JSON.
 *
 * ```ts
 * const report = JSON.stringify(hamlib.diagnostics(), null, 2);
 * ```
 */
export interface Diagnostics {
  /** ISO time the report was taken. */
  generatedAt: string;
  hamlibVersion: string;
  transport: string;
  /** `navigator.userAgent` in a browser; `node <version>` (and Electron's) elsewhere. */
  runtime: string;
  /** The level Hamlib logs at: `'err'` unless `debug` asked for another. */
  debugLevel: DebugLevel;
  /** `true` once a call overran `callTimeoutMs`; the instance is then unusable. */
  hung: boolean;
  rigs: DiagnosticsRig[];
  /** Logical port paths still registered: one per open rig, plus any whose release failed. */
  ports: string[];
  errors: ErrorEntry[];
  /** The most recent port traffic, oldest first. */
  trace: TraceEntry[];
  /** The most recent Hamlib log lines, oldest first; errors only without `debug`. */
  log: LogEntry[];
}

/** Entries each buffer keeps. */
const LOG_LIMIT = 500;
const TRACE_LIMIT = 200;
const ERROR_LIMIT = 20;

/** The `rig_debug_level_e` value of a level name. */
export function debugLevelValue(level: DebugLevel, operation: string): DebugLevelValue {
  if (!Object.hasOwn(DEBUG_LEVEL_VALUES, level)) {
    throw new HamlibError(
      `debug.level must be one of ${DEBUG_LEVELS.join(', ')}, got ${String(level)}`,
      { code: 'INVALID_ARGUMENT', operation },
    );
  }

  return DEBUG_LEVEL_VALUES[level];
}

/** The level name of a `rig_debug_level_e` value. */
function debugLevelName(value: number): DebugLevel | undefined {
  return DEBUG_LEVELS.find((level) => DEBUG_LEVEL_VALUES[level] === value);
}

function push<T>(buffer: T[], entry: T, limit: number): void {
  buffer.push(entry);

  if (buffer.length > limit) {
    buffer.splice(0, buffer.length - limit);
  }
}

/** The three buffers of one instance. */
export class DiagnosticsRecorder {
  readonly #log: LogEntry[] = [];
  readonly #trace: TraceEntry[] = [];
  readonly #errors: ErrorEntry[] = [];
  readonly #onLog: ((entry: LogEntry) => void) | undefined;

  readonly debugLevel: DebugLevel;

  constructor(level: DebugLevel, onLog: ((entry: LogEntry) => void) | undefined) {
    this.debugLevel = level;
    this.#onLog = onLog;
  }

  log(level: number, message: string): void {
    const entry: LogEntry = {
      time: Date.now(),
      level: debugLevelName(level) ?? 'verbose',
      message: message.replace(/\s+$/, ''),
    };

    push(this.#log, entry, LOG_LIMIT);
    this.#onLog?.(entry);
  }

  trace(direction: 'tx' | 'rx', path: string, bytes: Uint8Array): void {
    push(this.#trace, { time: Date.now(), direction, path, hex: bytesToHex(bytes) }, TRACE_LIMIT);
  }

  error(operation: string, error: unknown): void {
    push(this.#errors, {
      time: Date.now(),
      operation,
      code: error instanceof HamlibError ? error.code : 'UNKNOWN',
      message: error instanceof Error ? error.message : String(error),
    }, ERROR_LIMIT);
  }

  report(fields: {
    hamlibVersion: string;
    transport: string;
    hung: boolean;
    rigs: DiagnosticsRig[];
    ports: string[];
  }): Diagnostics {
    return {
      generatedAt: new Date().toISOString(),
      hamlibVersion: fields.hamlibVersion,
      transport: fields.transport,
      runtime: describeRuntime(),
      debugLevel: this.debugLevel,
      hung: fields.hung,
      rigs: fields.rigs,
      ports: fields.ports,
      errors: [...this.#errors],
      trace: [...this.#trace],
      log: [...this.#log],
    };
  }
}
