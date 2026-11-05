/**
 * The surface the hook harness page publishes on `window`.
 *
 * Kept apart from `hooks.tsx` so a spec can import the shape without pulling a
 * JSX file into its own TypeScript project.
 */

/** What the mounted hooks published, as plain data. */
export interface HookSnapshot {
  /** The provider finished loading, so its catalogue is known. */
  readonly ready: boolean;
  /** A rig is owned: `useRig().rig !== undefined`. */
  readonly connected: boolean;
  readonly connecting: boolean;
  readonly error: {
    readonly code: string | null;
    readonly operation: string | null;
    readonly message: string;
  } | null;
  /** `useRigState` holds a snapshot from the rig. */
  readonly hasState: boolean;
  readonly frequency: number | null;
  /**
   * How many snapshots `useRigState` published.
   *
   * A rising count proves polling is alive; a frozen one proves it stopped.
   */
  readonly snapshots: number;
}

/** The hook's own API, which the probe republishes on every render. */
export interface HookControls {
  /**
   * Open a rig by catalogue name.  Resolves and rejects exactly like the
   * hook's `connect`, including resolving without publishing when the attempt
   * was superseded.
   */
  connect(modelName: string, baudRate?: number): Promise<void>;
  disconnect(): Promise<void>;
  clearError(): void;
  snapshot(): HookSnapshot;
}

/** The whole control surface the specs drive. */
export interface HookHarness extends HookControls {
  /**
   * The last snapshot the probe rendered, still readable after it unmounted.
   */
  lastPublished(): HookSnapshot;
  /**
   * Render or remove just the probe, leaving the provider - and therefore the
   * loaded module - mounted.  This is the hook's own effect cleanup, which runs
   * before anything the provider disposes on a full unmount.
   */
  setProbeVisible(visible: boolean): void;
  /** Unmount the React root, cancelling everything an unmount cancels. */
  unmount(): void;
  /** Mount a fresh provider and probe, so a cancelled attempt can be retried. */
  mount(): void;
}

declare global {
  interface Window {
    __hookHarness: HookHarness;
  }
}
