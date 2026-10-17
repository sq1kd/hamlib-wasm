// SPDX-License-Identifier: MIT

/**
 * The one error type this package throws, and the codes it reports.
 *
 * Kept in its own module because two layers produce these values: the facade
 * (`src/hamlib.ts`) for everything it can reject before Wasm, and the
 * transports (`src/web-serial.ts`, `src/node.ts`) for what the device layer
 * underneath them raises.
 */

/** Human readable text for Hamlib's `enum rig_errcode_e`. */
export const HAMLIB_ERROR_MESSAGES: Readonly<Record<number, string>> = {
  0: 'no error',
  1: 'invalid parameter',
  2: 'invalid configuration',
  3: 'memory shortage',
  4: 'function not implemented',
  5: 'communication timed out',
  6: 'I/O error',
  7: 'internal Hamlib error',
  8: 'protocol error',
  9: 'command rejected by the rig',
  10: 'command performed, but argument truncated',
  11: 'function not available',
  12: 'VFO not targetable',
  13: 'error talking on the bus',
  14: 'collision on the bus',
  15: 'invalid pointer parameter',
  16: 'invalid VFO',
  17: 'argument out of domain',
  18: 'function deprecated',
  19: 'security error',
  20: 'rig not powered on',
  21: 'limit exceeded',
  22: 'access denied',
};

/** Stable error codes reported by {@link HamlibError}. */
export type HamlibErrorCode =
  /** No transport can run here (e.g. no Web Serial, or a missing serialport). */
  | 'TRANSPORT_UNAVAILABLE'
  /** The user dismissed the port chooser or blocked the port. */
  | 'PORT_PERMISSION_DENIED'
  /** The transport raised an error of its own. */
  | 'TRANSPORT_FAILURE'
  /** Hamlib returned a negative error code. */
  | 'HAMLIB_ERROR'
  /**
   * No baud rate answered, so there was nothing to open.
   *
   * Reported by {@link Hamlib.detectBaudRate}: every candidate rate in the
   * model's declared range was tried and the rig replied at none of them.
   */
  | 'RIG_UNRESPONSIVE'
  /** A bound was violated before reaching Wasm. */
  | 'INVALID_ARGUMENT'
  /** The selected model cannot perform the requested operation. */
  | 'UNSUPPORTED_OPERATION'
  /** The rig has been closed. */
  | 'RIG_CLOSED'
  /** The Hamlib instance has been disposed. */
  | 'DISPOSED';

export interface HamlibErrorOptions {
  /** Stable machine readable code. */
  code: HamlibErrorCode;
  /** Stable operation name, e.g. `"open"` or `"getFrequency"`. */
  operation: string;
  /** Underlying transport error, when there is one. */
  cause?: unknown;
  /** Negative Hamlib error code, when `code` is `"HAMLIB_ERROR"`. */
  hamlibCode?: number;
  /** Text of the Hamlib error code. */
  hamlibMessage?: string;
}

/**
 * Every failure reported by this package is a `HamlibError`.
 *
 * Transport context is preserved: a transport failure keeps the error the
 * device layer raised as `cause`, and Hamlib failures carry
 * `hamlibCode`/`hamlibMessage`.
 */
export class HamlibError extends Error {
  readonly code: HamlibErrorCode;
  readonly operation: string;
  readonly hamlibCode?: number;
  readonly hamlibMessage?: string;

  constructor(message: string, options: HamlibErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'HamlibError';
    this.code = options.code;
    this.operation = options.operation;
    this.hamlibCode = options.hamlibCode;
    this.hamlibMessage = options.hamlibMessage;
  }
}

/**
 * Map an error a browser raised to a `HamlibError`.
 *
 * The mapping is Web Serial's: a chooser the user dismissed or a port the user
 * blocked arrives as a `NotFoundError`, and anything else - settings the
 * device refused, a disconnected port - is a transport failure.  A transport
 * that raises errors of its own shape (`src/node.ts`) classifies them itself.
 */
export function transportError(cause: unknown, operation: string): HamlibError {
  if (cause instanceof Error && cause.name === 'NotFoundError') {
    return new HamlibError('no serial port was selected', {
      code: 'PORT_PERMISSION_DENIED',
      operation,
      cause,
    });
  }

  const detail = cause instanceof Error ? cause.message : String(cause);

  return new HamlibError(`${operation} failed: ${detail}`, {
    code: 'TRANSPORT_FAILURE',
    operation,
    cause,
  });
}
