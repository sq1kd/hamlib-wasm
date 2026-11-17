/**
 * Auto-detect, the way a reader needs it: fast the second time, and visibly
 * moving the first.
 *
 * `detectBaudRate()` tries a model's rates highest first, and every rate the
 * radio is not set to costs a full, failing open - a few seconds on some
 * backends.  So the rate that worked last time for this model is tried
 * before any other, and the search goes one rate per call, which lets the
 * panel say which rate it is on.  The rates come from the library's
 * `baudRateCandidates()`, worked out by the caller: at build time for the
 * landing page, which must not load the library to offer them.
 */
import type { Hamlib, SerialPortLike } from 'hamlib-wasm';

import { rateKey, recall, remember } from './storage';

function rememberedRate(modelId: number): number | undefined {
  const value = Number(recall(rateKey(modelId)));

  return Number.isInteger(value) && value > 0 ? value : undefined;
}

export function rememberRate(modelId: number, rate: number): void {
  remember(rateKey(modelId), String(rate));
}

/**
 * Find the rate the radio answers at among `rates`: last time's rate first,
 * then the rest, reporting each before it is tried.  Rejects like
 * `detectBaudRate()` - with `RIG_UNRESPONSIVE` - when none answers.
 */
export async function detectRate(
  hamlib: Pick<Hamlib, 'detectBaudRate'>,
  modelId: number,
  rates: readonly number[],
  port: SerialPortLike,
  onTry: (rate: number) => void,
): Promise<number> {
  const remembered = rememberedRate(modelId);
  const order = [...new Set([...(remembered === undefined ? [] : [remembered]), ...rates])];
  let failure: unknown;

  for (const rate of order) {
    onTry(rate);

    try {
      const found = await hamlib.detectBaudRate({ modelId, port, rates: [rate] });

      rememberRate(modelId, found);
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
