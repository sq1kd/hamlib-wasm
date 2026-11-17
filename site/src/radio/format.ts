/**
 * What the radio panel shows and lets you press, as pure functions.
 *
 * One panel is drawn by React on the demo page and painted by a small script
 * on the landing page (`paint.ts`); both read their text and cell counts
 * from here, so the two never disagree about a reading or a control.
 */

import type { PassbandSelector, PttState, RigCapabilities, RigMode, RigState } from 'hamlib-wasm';

import type { PanelModel } from './models';

/** Before a radio is connected: nothing can be set. */
export const NO_CAPABILITIES: RigCapabilities = {
  getFrequency: false,
  setFrequency: false,
  getMode: false,
  setMode: false,
  getPtt: false,
  setPtt: false,
  sendMorse: false,
  stopMorse: false,
  levels: [],
};

/** Whether a PTT reading means the radio is keyed; `'unknown'` is before the first read. */
export function keyed(ptt: PttState | 'unknown' | undefined): boolean {
  return ptt !== undefined && ptt !== 'off' && ptt !== 'unknown';
}

/** Tuning increments, in Hz. */
export const STEPS: readonly number[] = [10, 100, 1000, 10_000, 100_000];

/** Which write controls are usable: what the rig can set, and what the last reading makes meaningful. */
export interface ControlStates {
  /** The frequency entry. */
  readonly entry: boolean;
  /** The entry's Set button: an entry, and something typed in it. */
  readonly set: boolean;
  /** The step buttons and step picker: they move the frequency last read. */
  readonly tune: boolean;
  readonly mode: boolean;
  /** Hamlib's passband helpers take the current mode. */
  readonly passband: boolean;
  readonly ptt: boolean;
}

/** Not gated on a write in flight: Hamlib's calls queue, so a control pressed meanwhile runs next. */
export function controlStates(capabilities: RigCapabilities, state: RigState | undefined, entry = ''): ControlStates {
  return {
    entry: capabilities.setFrequency,
    set: capabilities.setFrequency && entry !== '',
    tune: capabilities.setFrequency && state?.frequency !== undefined,
    mode: capabilities.setMode,
    passband: capabilities.setMode && state?.mode !== undefined,
    ptt: capabilities.setPtt,
  };
}

/** `steps` steps of `step` Hz up (or down, when negative) from `hz`, never below 0. */
export function tuned(hz: number, steps: number, step: number): number {
  return Math.max(0, hz + steps * step);
}

/** What the frequency entry asks for, in Hz, ignoring separators; `undefined` when it names none. */
export function parseFrequency(entry: string): number | undefined {
  const hz = Number(entry.replace(/[^0-9]/g, ''));

  return Number.isFinite(hz) && hz > 0 ? hz : undefined;
}

export function entryPlaceholder(hz: number | undefined): string {
  return hz === undefined ? 'Frequency, Hz' : String(hz);
}

/** Why the picked model cannot be connected, as the panel says it; `undefined` when it can. */
export function limitationText(model: PanelModel | undefined): string | undefined {
  return model?.limitation === undefined ? undefined : `${model.manufacturer} ${model.model}: ${model.limitation}`;
}

/**
 * The modes the panel lists; the current mode is added when it is not one of them.
 * Each must be the name Hamlib reports (the first `mode_str[]` entry for the
 * mode), not an alias such as `CW-R`, or its chip never lights.
 */
export const MODES: readonly RigMode[] = ['LSB', 'USB', 'CW', 'CWR', 'AM', 'FM', 'RTTY', 'PKTUSB'];

/** Hamlib's passband helpers, in the order the panel offers them. */
export const PASSBANDS: readonly PassbandSelector[] = ['narrow', 'normal', 'wide'];

/** S-meter cells: S0..S9 fill the first 13, +60 dB the rest. */
export const METER_CELLS = 24;
const S9_CELLS = 13;

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

export function modeList(current: RigMode | undefined): readonly RigMode[] {
  return current === undefined || MODES.includes(current) ? MODES : [...MODES, current];
}
