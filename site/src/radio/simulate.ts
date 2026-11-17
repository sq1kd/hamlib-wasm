/**
 * Sample readings for a panel with no radio behind it.
 *
 * The panel says so - its pill reads "Sample" - and the readings are made
 * up, but plausibly: a dial that hops between digital and CW calling
 * frequencies and tunes there the way a VFO does, and an S-meter that
 * breathes with FT8's 15-second slots.  Under reduced motion it holds one
 * reading.  None of the frequencies is one the test emulators report.
 */
import type { RigMode, RigState } from 'hamlib-wasm';

import { POLL_MS } from './format';

interface Stop {
  readonly hz: number;
  readonly mode: RigMode;
  readonly passband: number;
  /** Mean S-meter, dB over S9. */
  readonly db: number;
}

const FIRST: Stop = { hz: 7_074_000, mode: 'USB', passband: 3000, db: -6 };

const STOPS: readonly Stop[] = [
  FIRST,
  { hz: 10_136_000, mode: 'USB', passband: 3000, db: -18 },
  { hz: 14_030_500, mode: 'CW', passband: 500, db: -24 },
  { hz: 18_100_000, mode: 'USB', passband: 3000, db: -12 },
  { hz: 21_074_000, mode: 'USB', passband: 3000, db: 6 },
];

/** The first sample reading, for HTML rendered before any script runs. */
export const SAMPLE_STATE: RigState = {
  frequency: FIRST.hz,
  mode: FIRST.mode,
  passband: FIRST.passband,
  ptt: 'off',
  levels: { STRENGTH: FIRST.db },
};

const DWELL_MS = 9000;
const TUNE_MS = 900;

export function simulate(onState: (state: RigState) => void): () => void {
  let index = 0;
  let from = FIRST.hz;
  let started = Date.now();
  let level = FIRST.db;

  const tick = (): void => {
    const now = Date.now();
    let stop = STOPS[index] ?? FIRST;

    if (now - started > DWELL_MS) {
      from = stop.hz;
      index = (index + 1) % STOPS.length;
      stop = STOPS[index] ?? stop;
      started = now;
    }

    /* Ease the dial onto the new frequency in 10 Hz steps, as a VFO knob would. */
    const t = Math.min(1, (now - started) / TUNE_MS);
    const eased = 1 - (1 - t) ** 3;
    const hz = Math.round((from + (stop.hz - from) * eased) / 10) * 10;

    /* FT8: 12.6 s on air in every 15 s slot; quieter in the gap and while tuning. */
    const slot = (now / 1000) % 15;
    const onAir = stop.mode === 'CW' || (slot > 0.5 && slot < 13.1);
    const target = stop.db - (onAir ? 0 : 14) - (t < 1 ? 10 : 0);

    level += (target - level) * 0.35 + (Math.random() - 0.5) * 7;
    onState({ frequency: hz, mode: stop.mode, passband: stop.passband, ptt: 'off', levels: { STRENGTH: level } });
  };

  tick();

  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    return () => undefined;
  }

  const timer = setInterval(tick, POLL_MS.meter);

  return () => { clearInterval(timer); };
}
