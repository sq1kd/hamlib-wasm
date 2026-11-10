/**
 * Update a build-time `RadioPanel` in place, without React.
 *
 * The landing page renders `RadioPanel` to HTML once; this repaints the
 * parts a reading changes, with the same helpers React's render uses
 * (`format.ts`), so the static panel and the demo's live one stay alike.
 */
import type { PanelView } from './RadioPanel';
import { cellState, keyed, meterCells, modeList, passbandLabel, segments } from './format';

/** What the connected radio lets the panel set; nothing, before it connects. */
export interface Writable {
  readonly frequency: boolean;
  readonly mode: boolean;
  readonly ptt: boolean;
}

export const NOTHING: Writable = { frequency: false, mode: false, ptt: false };

function find<T extends Element>(root: Element, selector: string): T {
  const element = root.querySelector<T>(selector);

  if (element === null) {
    throw new Error(`radio panel: missing ${selector}`);
  }

  return element;
}

export function paint(root: HTMLElement, view: PanelView, writable: Writable = NOTHING): void {
  const { state } = view;
  const digits = segments(state?.frequency);
  const ptt = state?.ptt ?? 'unknown';
  const lit = meterCells(state?.levels?.STRENGTH);

  root.dataset.state = view.phase;
  root.toggleAttribute('data-sample', view.sample);

  find(root, '[data-radio-name]').textContent = view.name;
  find(root, '[data-radio-meta]').textContent = view.meta;

  const pill = find<HTMLElement>(root, '[data-testid="connection-state"]');

  pill.textContent = view.pill;
  pill.dataset.state = view.phase;

  find(root, '[data-radio-ghost]').textContent = digits.ghost;
  find(root, '[data-testid="frequency-display"]').textContent = digits.lit;
  find(root, '[data-testid="mode-display"]').textContent = state?.mode ?? '—';
  find(root, '[data-testid="passband-display"]').textContent = passbandLabel(state?.passband);

  const tx = find<HTMLElement>(root, '[data-testid="ptt-state"]');

  tx.dataset.state = ptt;
  tx.hidden = !keyed(ptt);

  const modes = find(root, '[data-radio-modes]');
  const list = modeList(state?.mode);

  if (modes.children.length !== list.length) {
    modes.replaceChildren(...list.map((mode) => {
      const chip = document.createElement('button');

      chip.type = 'button';
      chip.disabled = true;
      chip.dataset.testid = `mode-${mode}`;
      chip.textContent = mode;

      return chip;
    }));
  }

  for (const chip of modes.querySelectorAll('button')) {
    chip.setAttribute('aria-pressed', String(chip.textContent === state?.mode));
    chip.disabled = !writable.mode;
  }

  paintControls(root, view, writable);

  find(root, '[data-radio-meter]').querySelectorAll<HTMLElement>('i').forEach((cell, index) => {
    cell.dataset.on = cellState(index, lit);
  });
}

/** The write controls, when the panel has them: what is pressed, and what can be pressed. */
function paintControls(root: HTMLElement, view: PanelView, writable: Writable): void {
  const controls = root.querySelector<HTMLElement>('[data-radio-controls]');

  if (controls === null) {
    return;
  }

  const frequency = view.state?.frequency;
  const control = <T extends HTMLElement>(testId: string): T | null => controls.querySelector<T>(`[data-testid="${testId}"]`);

  const ptt = control<HTMLButtonElement>('ptt-button');

  if (ptt !== null) {
    ptt.setAttribute('aria-pressed', String(keyed(view.state?.ptt)));
    ptt.disabled = !writable.ptt;
  }

  const tunable = writable.frequency && frequency !== undefined;

  for (const testId of ['tune-down', 'tune-up']) {
    const button = control<HTMLButtonElement>(testId);

    if (button !== null) button.disabled = !tunable;
  }

  const step = controls.querySelector<HTMLSelectElement>('select');

  if (step !== null) step.disabled = !tunable;

  const input = control<HTMLInputElement>('frequency-input');
  const set = control<HTMLButtonElement>('frequency-set');

  if (input !== null) {
    input.disabled = !writable.frequency;
    input.placeholder = frequency === undefined ? 'Frequency, Hz' : String(frequency);
  }

  if (set !== null) set.disabled = !writable.frequency || input?.value === '';

  for (const button of controls.querySelectorAll<HTMLButtonElement>('[data-testid^="passband-"]')) {
    button.disabled = !writable.mode || view.state?.mode === undefined;
  }
}
