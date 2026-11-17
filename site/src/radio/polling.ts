/**
 * How both panels read and write a connected rig, so the landing page and the
 * demo page behave alike.
 *
 * Frequency, mode and PTT poll once a second; the S-meter, the one level the
 * panel shows, polls on its own faster timer so it moves while the slower
 * reads wait.  A write is followed by a read, so the display answers at once
 * rather than on the next poll.
 */
import type { HamlibOptions, LevelName, Rig, RigCapabilities, RigField } from 'hamlib-wasm';

/** How often the panel re-reads the radio, in milliseconds. */
export const POLL_MS = {
  /** Frequency, mode and PTT. */
  telemetry: 1000,
  /** The S-meter. */
  meter: 250,
} as const;

export const TELEMETRY: readonly RigField[] = ['frequency', 'mode', 'ptt'];

const PANEL_LEVELS: readonly LevelName[] = ['STRENGTH'];

/** The module options a panel needs: the levels it shows, and no others. */
export const PANEL_OPTIONS = { levels: PANEL_LEVELS } as const satisfies HamlibOptions;

/** Whether the rig has an S-meter to poll; `watch()` refuses levels a rig lacks. */
export function metered(capabilities: RigCapabilities): boolean {
  return capabilities.levels.length > 0;
}

/** Poll the panel's readings until the returned function is called. */
export function watchPanel(rig: Rig): () => void {
  const stops = [rig.watch({ intervalMs: POLL_MS.telemetry, fields: [...TELEMETRY] })];

  if (metered(rig.capabilities)) {
    stops.push(rig.watch({ intervalMs: POLL_MS.meter, fields: ['levels'] }));
  }

  return () => { for (const stop of stops) stop(); };
}

/** Run one write, then read the rig back. */
export async function writeAndRead(rig: Rig, write: (rig: Rig) => Promise<unknown>): Promise<void> {
  await write(rig);
  await rig.refresh();
}
