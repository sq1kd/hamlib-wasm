// SPDX-License-Identifier: MIT

import process from 'node:process';

/** Throw an assertion error; `runMain` prints it. */
export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The entry point of every build script.  Library code only throws, so its
 * `finally` blocks (temporary directories) run before the process reports the
 * error and exits non-zero.
 */
export async function runMain(scope: string, main: () => void | Promise<void>): Promise<void> {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`[${scope}] error: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  }
}
