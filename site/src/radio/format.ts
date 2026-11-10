/**
 * What the radio panel shows, as pure functions.
 *
 * One panel is drawn by React on the demo page and painted by a small script
 * on the landing page (`paint.ts`); both read their text and cell counts
 * from here, so the two never disagree about what a reading looks like.
 */

/** The modes the panel lists; the current mode is added when it is not one of them. */
export const MODES: readonly string[] = ['LSB', 'USB', 'CW', 'CW-R', 'AM', 'FM', 'RTTY', 'DATA-USB'];

/** S-meter cells: S0..S9 fill the first 13, +60 dB the rest. */
export const METER_CELLS = 24;
const S9_CELLS = 13;

/** How often the panel re-reads the radio, in milliseconds. */
export const POLL_MS = {
  /** Frequency, mode and PTT. */
  telemetry: 1000,
  /** The S-meter, on its own, faster timer. */
  meter: 250,
} as const;

export interface Segments {
  /** The lit digits, e.g. `14.074.000`. */
  readonly lit: string;
  /** The unlit segments behind them, as wide as the lit text or wider. */
  readonly ghost: string;
}

/** `14074000` → `14.074.000` over `88.888.888`; unknown → dashes. */
export function segments(hz: number | undefined): Segments {
  if (hz === undefined) {
    return { lit: '--.---.---', ghost: '88.888.888' };
  }

  const khz = Math.floor(hz / 1000);
  const lit = `${String(Math.floor(khz / 1000))}.${String(khz % 1000).padStart(3, '0')}.${String(hz % 1000).padStart(3, '0')}`;
  const ghost = lit.replace(/\d/g, '8');

  return { lit, ghost: ghost.length < 10 ? `8${ghost}` : ghost };
}

/** Hamlib's STRENGTH is dB over S9 (6 dB an S-unit); this is how many cells it lights. */
export function meterCells(db: number | undefined): number {
  if (db === undefined) {
    return 0;
  }

  const lit = db <= 0 ? ((db + 54) / 54) * S9_CELLS : S9_CELLS + (db / 60) * (METER_CELLS - S9_CELLS);

  return Math.max(0, Math.min(METER_CELLS, Math.round(lit)));
}

/** A lit cell below S9 is `on`, above it `over`. */
export function cellState(index: number, lit: number): '' | 'on' | 'over' {
  if (index >= lit) {
    return '';
  }

  return index >= S9_CELLS ? 'over' : 'on';
}

export function passbandLabel(hz: number | undefined): string {
  if (hz === undefined || hz <= 0) {
    return '—';
  }

  return hz >= 1000 ? `${(hz / 1000).toFixed(1)} kHz` : `${String(hz)} Hz`;
}

export function modeList(current: string | undefined): readonly string[] {
  return current === undefined || MODES.includes(current) ? MODES : [...MODES, current];
}
