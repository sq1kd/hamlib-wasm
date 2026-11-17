// SPDX-License-Identifier: MIT

/**
 * The one error type this package throws, and the codes it reports.
 *
 * Kept in its own module because several layers produce these values: both
 * API layers (`src/index.ts`, `src/raw.ts`) for everything they can reject
 * before Wasm, and the transports (`src/web-serial.ts`, `src/node.ts`) for
 * what the device layer underneath them raises.
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

/**
 * Stable error codes reported by {@link HamlibError}.
 *
 * | Code | Meaning |
 * | --- | --- |
 * | `TRANSPORT_UNAVAILABLE` | No transport can run here: a browser without Web Serial, or Node without `serialport` installed |
 * | `PORT_PERMISSION_DENIED` | The user dismissed the port chooser or blocked the port |
 * | `TRANSPORT_FAILURE` | The serial port itself failed outside a CAT exchange, e.g. it refused the line settings when opened |
 * | `HAMLIB_ERROR` | Hamlib reported an error; `hamlibCode`/`hamlibMessage` say which.  An `open` that gets no answer from the rig - usually a baud rate that does not match the radio's menu - fails this way, and so does a call after the device was unplugged (`-6`, I/O error) |
 * | `RIG_UNRESPONSIVE` | `detectBaudRate` tried every rate the model declares and the rig answered at none |
 * | `INVALID_ARGUMENT` | An argument was rejected before anything was sent to the rig |
 * | `UNSUPPORTED_OPERATION` | The model cannot perform the operation; nothing was sent |
 * | `RIG_CLOSED` | The rig has been closed |
 * | `RIG_TIMEOUT` | A call did not settle within `callTimeoutMs`; the instance is unusable from then on |
 * | `RIG_HUNG` | An earlier call timed out and never returned; dispose the instance and create a new one |
 * | `DISPOSED` | The Hamlib instance has been disposed |
 */
export type HamlibErrorCode =
  | 'TRANSPORT_UNAVAILABLE'
  | 'PORT_PERMISSION_DENIED'
  | 'TRANSPORT_FAILURE'
  | 'HAMLIB_ERROR'
  | 'RIG_UNRESPONSIVE'
  | 'INVALID_ARGUMENT'
  | 'UNSUPPORTED_OPERATION'
  | 'RIG_CLOSED'
  | 'RIG_TIMEOUT'
  | 'RIG_HUNG'
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
 * ```ts
 * try {
 *   await rig.setFrequency(14_074_000);
 * } catch (error) {
 *   if (error instanceof HamlibError && error.code === 'UNSUPPORTED_OPERATION') {
 *     // this model cannot set the frequency
 *   }
 * }
 * ```
 *
 * Transport context is preserved: a transport failure keeps the error the
 * device layer raised as `cause`, and Hamlib failures carry
 * `hamlibCode`/`hamlibMessage`.
 */
export class HamlibError extends Error {
  /** What went wrong, as a stable code to branch on; see {@link HamlibErrorCode}. */
  readonly code: HamlibErrorCode;
  /** The operation that failed, e.g. `"open"` or `"getFrequency"`. */
  readonly operation: string;
  /** Hamlib's negative error code, when `code` is `"HAMLIB_ERROR"`. */
  readonly hamlibCode?: number;
  /** Hamlib's text for `hamlibCode`, e.g. `"communication timed out"`. */
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

/**
 * Wrap a thrown value as a `HamlibError`.  The native layer only ever throws
 * one, so anything else came from underneath it and is a transport failure.
 */
export function asHamlibError(error: unknown, operation: string): HamlibError {
  if (error instanceof HamlibError) {
    return error;
  }

  return new HamlibError(
    error instanceof Error ? error.message : String(error),
    { code: 'TRANSPORT_FAILURE', operation, cause: error },
  );
}

/** A call on an instance that has been disposed. */
export function disposedError(operation: string): HamlibError {
  return new HamlibError('Hamlib instance has been disposed', { code: 'DISPOSED', operation });
}

/** A call on a rig that has been closed. */
export function closedError(operation: string): HamlibError {
  return new HamlibError('rig is closed', { code: 'RIG_CLOSED', operation });
}

/** A call on an instance whose earlier call never settled. */
export function hungError(operation: string): HamlibError {
  return new HamlibError(
    'the Hamlib instance is hung after an operation that never settled; '
    + 'dispose it and create a new one',
    { code: 'RIG_HUNG', operation },
  );
}
