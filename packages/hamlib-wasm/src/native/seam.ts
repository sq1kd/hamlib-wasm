/**
 * The compound-operation seam between `src/hamlib.ts` (which owns the module's
 * single call queue) and `src/index.ts` (which composes the easy operations on
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

/** The seam `RigHandle` implements and the easy surface consumes. */
export interface CompoundHost {
  /**
   * Run `body` as one unit on the module's call queue.
   *
   * The body runs inside a single queue slot, so no other call - a raw method,
   * a call on another rig, a later easy call - can run between its steps.  The
   * operations handed to the body are released when it settles, so they cannot
   * escape the callback or drive concurrent native work.
   */
  runCompound<T>(
    operation: string,
    body: (operations: CompoundOperations) => Promise<T>,
  ): Promise<T>;
}
