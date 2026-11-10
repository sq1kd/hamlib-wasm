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
import type { SerialPortLike } from 'hamlib-wasm';

/** The standard UART rates, highest first: the order Hamlib's own search uses. */
const LADDER: readonly number[] = [115200, 57600, 38400, 19200, 9600, 4800, 2400, 1200];

const KEY = 'hamlib-demo:baud:';

interface Detector {
  detectBaudRate(options: { modelId: number; port: SerialPortLike; rates?: readonly number[] }): Promise<number>;
}

/** The rates a model accepts, from the ladder and its declared range. */
export function ratesFor(min: number, max: number): number[] {
  const usable = min > 0 && max >= min;

  return [...new Set([...(usable ? [max] : []), ...LADDER])]
    .filter((rate) => !usable || (rate >= min && rate <= max))
    .sort((left, right) => right - left);
}

export function rememberedRate(modelId: number): number | undefined {
  try {
    const value = Number(localStorage.getItem(`${KEY}${String(modelId)}`));

    return Number.isInteger(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

export function rememberRate(modelId: number, rate: number): void {
  try {
    localStorage.setItem(`${KEY}${String(modelId)}`, String(rate));
  } catch {
    /* Storage disabled: the next search starts from the top again. */
  }
}

/**
 * Find the rate the radio answers at: last time's rate first, then the rest,
 * reporting each before it is tried.  Rejects like `detectBaudRate()` - with
 * `RIG_UNRESPONSIVE` - when none answers.
 */
export async function detectRate(
  hamlib: Detector,
  model: { readonly id: number; readonly rateMin: number; readonly rateMax: number },
  port: SerialPortLike,
  onTry: (rate: number) => void,
): Promise<number> {
  const remembered = rememberedRate(model.id);
  const order = [...new Set([...(remembered === undefined ? [] : [remembered]), ...ratesFor(model.rateMin, model.rateMax)])];
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
