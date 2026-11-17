/** The model picker's entries, and which one a panel starts on. */
import type { RigModel } from 'hamlib-wasm';

import { EMULATED_MODEL } from './emulate';
import { MODEL_KEY, recall } from './storage';

/** What the panel needs of a model: its picker entry, why it cannot work, and its rates. */
export type PanelModel = Pick<RigModel, 'id' | 'manufacturer' | 'model' | 'limitation' | 'serialRateMin' | 'serialRateMax'>;

/**
 * The emulator's model while emulating, else the reader's last pick, else the
 * model the test suite's emulator speaks: the one every change proves.
 */
export function defaultModel<T extends Pick<PanelModel, 'id' | 'model'>>(models: readonly T[], emulated = false): T | undefined {
  const stored = Number(recall(MODEL_KEY) ?? Number.NaN);
  const named = models.find((model) => model.model === EMULATED_MODEL);

  return (emulated ? named : undefined)
    ?? models.find((model) => model.id === stored)
    ?? named
    ?? models[0];
}
