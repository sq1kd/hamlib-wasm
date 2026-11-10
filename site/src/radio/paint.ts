/**
 * Update a build-time `RadioPanel` in place, without React.
 *
 * The landing page renders `RadioPanel` to HTML once; this repaints the
 * parts a reading changes, with the same helpers React's render uses
 * (`format.ts`), so the static panel and the demo's live one stay alike.
 */
import type { PanelView } from './RadioPanel';
import { cellState, meterCells, modeList, passbandLabel, segments } from './format';

function find<T extends Element>(root: Element, selector: string): T {
  const element = root.querySelector<T>(selector);

  if (element === null) {
    throw new Error(`radio panel: missing ${selector}`);
  }

  return element;
}

export function paint(root: HTMLElement, view: PanelView): void {
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
  tx.hidden = ptt === 'off' || ptt === 'unknown';

  /* The landing panel never sets a mode: its chips only show which is on. */
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

  for (const chip of modes.children) {
    chip.setAttribute('aria-pressed', String(chip.textContent === state?.mode));
  }

  find(root, '[data-radio-meter]').querySelectorAll<HTMLElement>('i').forEach((cell, index) => {
    cell.dataset.on = cellState(index, lit);
  });
}
