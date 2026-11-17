/**
 * Auto-detect, the way a reader needs it: fast the second time, and visibly
 * moving the first.
 *
 * `detectBaudRate()` tries a model's rates highest first, and every rate the
 * radio is not set to costs a full, failing open - a few seconds on some
 * backends.  So the rate that worked last time for this model is tried
 * before any other, and the search goes one rate per call, which lets the
 * panel say which rate it is on.
 */
import type { Hamlib, SerialPortLike } from 'hamlib-wasm';

import type { PanelModel } from './models';
import { rateKey, recall, remember } from './storage';

/* hamlib-wasm's own ladder, from its private `baudRateCandidates()`.  Once the
 * library exports that function, `baudRates` below becomes a re-export of it. */
const LADDER: readonly number[] = [300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

/**
 * The rates `detectBaudRate()` tries for a model, in its order: the declared
 * maximum, then the ladder within the declared range, highest first.  A range
 * a backend leaves unset keeps the whole ladder.
 */
export function baudRates(model: Pick<PanelModel, 'serialRateMin' | 'serialRateMax'>): number[] {
  const { serialRateMin: min, serialRateMax: max } = model;
  const usable = min > 0 && max >= min;

  return [...new Set([max, ...LADDER.filter((rate) => !usable || (rate >= min && rate <= max))])]
    .filter((rate) => Number.isInteger(rate) && rate > 0)
    .sort((left, right) => right - left);
}

function rememberedRate(modelId: number): number | undefined {
  const value = Number(recall(rateKey(modelId)));

  return Number.isInteger(value) && value > 0 ? value : undefined;
}

export function rememberRate(modelId: number, rate: number): void {
  remember(rateKey(modelId), String(rate));
}

/**
 * Find the rate the radio answers at: last time's rate first, then the rest,
 * reporting each before it is tried.  Rejects like `detectBaudRate()` - with
 * `RIG_UNRESPONSIVE` - when none answers.
 */
export async function detectRate(
  hamlib: Pick<Hamlib, 'detectBaudRate'>,
  model: PanelModel,
  port: SerialPortLike,
  onTry: (rate: number) => void,
): Promise<number> {
  const remembered = rememberedRate(model.id);
  const order = [...new Set([...(remembered === undefined ? [] : [remembered]), ...baudRates(model)])];
  let failure: unknown;

  for (const rate of order) {
    onTry(rate);

    try {
      const found = await hamlib.detectBaudRate({ modelId: model.id, port, rates: [rate] });

      rememberRate(model.id, found);
      return found;
    } catch (cause) {
      /* Silence moves on; anything else - a port the OS took away - ends it. */
      if ((cause as { code?: string } | undefined)?.code !== 'RIG_UNRESPONSIVE') {
        throw cause;
      }

      failure = cause;
    }
  }

  throw failure;
}
