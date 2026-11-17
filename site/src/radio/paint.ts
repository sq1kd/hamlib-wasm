/**
 * Update a build-time `RadioPanel` in place, without React.
 *
 * The landing page renders `RadioPanel` to HTML once; this repaints the
 * parts a reading changes, with the same helpers React's render uses
 * (`format.ts`), so the static panel and the demo's live one stay alike.
 */
import type { RigCapabilities } from 'hamlib-wasm';

import { cellState, controlStates, entryPlaceholder, keyed, meterCells, modeList, NO_CAPABILITIES, passbandLabel, segments } from './format';
import type { ControlStates } from './format';
import type { PanelView } from './RadioPanel';

function find<T extends Element>(root: Element, selector: string): T {
  const element = root.querySelector<T>(selector);

  if (element === null) {
    throw new Error(`radio panel: missing ${selector}`);
  }

  return element;
}

export function paint(root: HTMLElement, view: PanelView, capabilities: RigCapabilities = NO_CAPABILITIES): void {
  const { state } = view;
  const digits = segments(state?.frequency);
  const ptt = state?.ptt ?? 'unknown';
  const lit = meterCells(state?.levels?.STRENGTH);
  const can = controlStates(capabilities, state, root.querySelector<HTMLInputElement>('[data-radio-entry]')?.value);

  root.dataset.state = view.phase;
  root.toggleAttribute('data-sample', view.sample);

  find(root, '[data-radio-name]').textContent = view.name;
  find(root, '[data-radio-meta]').textContent = view.meta;

  const pill = find<HTMLElement>(root, '[data-radio-pill]');

  pill.textContent = view.pill;
  pill.dataset.state = view.phase;

  find(root, '[data-radio-ghost]').textContent = digits.ghost;
  find(root, '[data-radio-frequency]').textContent = digits.lit;
  find(root, '[data-radio-mode]').textContent = state?.mode ?? '—';
  find(root, '[data-radio-passband]').textContent = passbandLabel(state?.passband);

  const tx = find<HTMLElement>(root, '[data-radio-tx]');

  tx.dataset.state = ptt;
  tx.hidden = !keyed(ptt);

  const modes = find(root, '[data-radio-modes]');
  const list = modeList(state?.mode);

  if (modes.children.length !== list.length) {
    modes.replaceChildren(...list.map((mode) => {
      const chip = document.createElement('button');

      chip.type = 'button';
      chip.disabled = true;
      chip.dataset.mode = mode;
      chip.dataset.testid = `mode-${mode}`;
      chip.textContent = mode;

      return chip;
    }));
  }

  for (const chip of modes.querySelectorAll<HTMLButtonElement>('[data-mode]')) {
    chip.setAttribute('aria-pressed', String(chip.dataset.mode === state?.mode));
    chip.disabled = !can.mode;
  }

  paintControls(root, view, can);

  find(root, '[data-radio-meter]').querySelectorAll<HTMLElement>('i').forEach((cell, index) => {
    cell.dataset.on = cellState(index, lit);
  });
}

/** The write controls, when the panel has them: what is pressed, and what can be pressed. */
function paintControls(root: HTMLElement, view: PanelView, can: ControlStates): void {
  const controls = root.querySelector<HTMLElement>('[data-radio-controls]');

  if (controls === null) {
    return;
  }

  const frequency = view.state?.frequency;
  const ptt = controls.querySelector<HTMLButtonElement>('[data-radio-ptt]');

  if (ptt !== null) {
    ptt.setAttribute('aria-pressed', String(keyed(view.state?.ptt)));
    ptt.disabled = !can.ptt;
  }

  for (const control of controls.querySelectorAll<HTMLButtonElement | HTMLSelectElement>('[data-tune], [data-radio-step]')) {
    control.disabled = !can.tune;
  }

  const input = controls.querySelector<HTMLInputElement>('[data-radio-entry]');
  const set = controls.querySelector<HTMLButtonElement>('[data-radio-set]');

  if (input !== null) {
    input.disabled = !can.entry;
    input.placeholder = entryPlaceholder(frequency);
  }

  if (set !== null) set.disabled = !can.set;

  for (const button of controls.querySelectorAll<HTMLButtonElement>('[data-passband]')) {
    button.disabled = !can.passband;
  }
}
