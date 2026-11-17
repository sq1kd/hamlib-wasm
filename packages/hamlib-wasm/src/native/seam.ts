// SPDX-License-Identifier: MIT

/**
 * The compound-operation seam between `src/raw.ts` (which owns the module's
 * single call queue) and `src/index.ts` (which composes the default operations on
 * it).
 *
 * Deliberately package-internal: this module is not an exported subpath of
 * `hamlib-wasm`, so neither the seam nor the scope it hands out is part of the
 * published API.  The native runtime stays the only owner of serialization.
 */
import type { GeneratedPublicOperations } from './generated/operations.js';

/**
 * The generated operations a compound body may drive.
 *
 * Inside a compound operation these execute directly: the owning rig already
 * holds the queue slot, so re-enqueueing would append behind it and deadlock.
 */
export type CompoundOperations = GeneratedPublicOperations;

/** The seam a rig `src/raw.ts` opened carries and the default surface consumes. */
export interface CompoundHost {
  /**
   * Run `body` as one unit on the module's call queue.
   *
   * The body runs inside a single queue slot, so no other call - a raw method,
   * a call on another rig, a later `Rig` call - can run between its steps.  The
   * operations handed to the body are released when it settles, so they cannot
   * escape the callback or drive concurrent native work.
   */
  runCompound<T>(
    operation: string,
    body: (operations: CompoundOperations) => Promise<T>,
  ): Promise<T>;
  /** Whether the rig can run `operation`, counting what its open `conf` added. */
  can(operation: string): boolean;
  /**
   * Record a failure a compound absorbed - a best-effort read the caller does
   * not see rejected - so `diagnostics()` still lists it.
   */
  record(operation: string, error: unknown): void;
}

const hosts = new WeakMap<object, CompoundHost>();

/** Attach the seam to a rig `src/raw.ts` opened. */
export function bindCompoundHost(rig: object, host: CompoundHost): void {
  hosts.set(rig, host);
}

/** The seam of a rig `src/raw.ts` opened; any other object is a bug in the caller. */
export function compoundHostOf(rig: object): CompoundHost {
  const host = hosts.get(rig);

  if (!host) {
    throw new TypeError('not a rig opened by this hamlib-wasm instance');
  }

  return host;
}
