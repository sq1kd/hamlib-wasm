/** Shared steps for the example-driven scenarios. */
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

export interface SelectedModel {
  id: string;
  label: string;
  serialRateMax: number;
}

/**
 * Connect to the preselected TS-480 model.
 *
 * The example preselects the TS-480, so this reads the model metadata the page
 * derived from the catalogue and then performs the user gesture.
 */
export async function connectTs480(page: Page): Promise<SelectedModel> {
  const modelSelect = page.getByTestId('model-select');

  await expect(modelSelect).toBeEnabled();

  const selected = await modelSelect.evaluate((element) => {
    /* getByTestId() types the node as HTMLElement; the example markup uses a
     * <select> for the model picker. */
    const select = element as HTMLSelectElement;
    const option = select.selectedOptions[0];

    if (!option) {
      throw new Error('no model is selected');
    }

    return {
      id: option.value,
      label: option.textContent ?? '',
      serialRateMax: Number(option.dataset['serialRateMax']),
    };
  });

  await page.getByTestId('connect-button').click();
  await expect(page.getByTestId('disconnect-button')).toBeEnabled();
  await expect(page.getByTestId('connection-state')).toContainText('connected');

  return selected;
}
