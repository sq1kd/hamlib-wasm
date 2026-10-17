// SPDX-License-Identifier: MIT

import process from 'node:process';

/** Print a scoped error and exit. */
export function fail(scope: string, message: string): never {
  process.stderr.write(`[${scope}] error: ${message}\n`);
  process.exit(1);
}

/** Throw an assertion error; the caller's main handler prints it. */
export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

/** Report an uncaught error for a scoped entry point and exit. */
export function reportError(scope: string, error: unknown): never {
  process.stderr.write(`[${scope}] error: ${String(error)}\n`);
  process.exit(1);
}
