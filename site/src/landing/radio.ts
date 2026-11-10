/**
 * The landing page's radio: the demo's panel, with no React.
 *
 * The panel is `RadioPanel` rendered to HTML at build time; this script
 * brings it to life.  With no radio it plays sample readings.  Connect has
 * to ask for the port inside the click's user activation, which a megabyte
 * download would outlive, so it asks first and loads Hamlib alongside;
 * pointing at or focusing the button starts the download early, unless the
 * reader asked to save data.
 *
 * Connected, it polls frequency, mode, PTT and the S-meter, and sets
 * frequency, mode, passband and PTT.  The demo page adds the log of every
 * library call.
 */
import type { Hamlib, HamlibError, PassbandSelector, Rig, RigField, RigState } from 'hamlib-wasm';

import { detectRate, rememberRate } from '../radio/detect';
import { EMULATED_MODEL } from '../radio/emulate';
import { POLL_MS } from '../radio/format';
import { NOTHING, paint } from '../radio/paint';
import { bindPtt } from '../radio/ptt';
import type { Writable } from '../radio/paint';
import type { PanelView } from '../radio/RadioPanel';
import { simulate } from '../radio/simulate';

/* Shared with the demo page, so both remember the same radio. */
const MODEL_KEY = 'hamlib-demo:model';

const SAMPLE: Omit<PanelView, 'state'> = {
  phase: 'disconnected',
  sample: true,
  name: 'No radio connected',
  meta: 'sample readings',
  pill: 'Sample',
};

interface NetworkInformation {
  readonly saveData?: boolean;
}

function message(cause: unknown): string {
  const error = cause as Partial<HamlibError> | undefined;

  /* The browser's own chooser, dismissed: a DOMException, not a HamlibError. */
  if (error?.name === 'NotFoundError') {
    return 'No port chosen.';
  }

  switch (error?.code) {
    case 'RIG_UNRESPONSIVE':
      return 'The radio did not answer at any baud rate. Check the cable and its CAT settings.';
    case 'HAMLIB_ERROR':
      return 'The radio did not answer. Check the baud rate in its menu, or pick Auto-detect.';
    default:
      return cause instanceof Error ? cause.message : String(cause);
  }
}

export interface MountOptions {
  /** The Web Serial double is installed: pick the model it speaks. */
  readonly emulated?: boolean;
}

export function mountRadio(root: HTMLElement, options: MountOptions = {}): void {
  const $ = <T extends Element>(testId: string): T => {
    const element = root.querySelector<T>(`[data-testid="${testId}"]`);

    if (element === null) {
      throw new Error(`radio: missing ${testId}`);
    }

    return element;
  };

  const model = $<HTMLSelectElement>('model-select');
  const baud = $<HTMLSelectElement>('baud-select');
  const connect = $<HTMLButtonElement>('connect-button');
  const disconnect = $<HTMLButtonElement>('disconnect-button');
  const limitation = $<HTMLElement>('model-limitation');
  const error = $<HTMLElement>('error-message');
  const note = root.querySelector<HTMLElement>('[data-radio-note]');

  const serial = 'serial' in navigator;
  let hamlib: Promise<Hamlib> | undefined;
  let rig: Rig | undefined;
  let current: RigState | undefined;
  let writable: Writable = NOTHING;
  let stops: (() => void)[] = [];
  let stopSample: (() => void) | undefined;

  const load = (): Promise<Hamlib> => {
    hamlib ??= import('hamlib-wasm').then((module) => module.createHamlib({ levels: ['STRENGTH'] }));
    hamlib.catch(() => { hamlib = undefined; });

    return hamlib;
  };

  const setError = (text: string | undefined): void => {
    error.textContent = text ?? '';
    error.hidden = text === undefined;
  };

  const lock = (locked: boolean): void => {
    model.disabled = locked;
    baud.disabled = locked;
    connect.disabled = locked || !serial || model.selectedOptions[0]?.dataset.limitation !== undefined;
  };

  const showSample = (): void => {
    stopSample?.();
    stopSample = simulate((state) => { paint(root, { ...SAMPLE, state }); });
  };

  const connecting = (pill: string): void => {
    paint(root, { phase: 'connecting', sample: false, name: 'Connecting', meta: '', pill, state: undefined });
  };

  /* Offer only the rates the picked model accepts, and say why a model cannot work. */
  const pickModel = (): void => {
    const option = model.selectedOptions[0];
    const min = Number(option?.dataset.min ?? 0);
    const max = Number(option?.dataset.max ?? Infinity);

    for (const rate of baud.options) {
      if (rate.value !== 'auto') {
        rate.hidden = Number(rate.value) < min || Number(rate.value) > max;
      }
    }

    if (baud.selectedOptions[0]?.hidden === true) {
      baud.value = 'auto';
    }

    const reason = option?.dataset.limitation;

    limitation.textContent = reason === undefined ? '' : `${option?.textContent ?? 'This model'}: ${reason}`;
    limitation.hidden = reason === undefined;
    lock(false);
  };

  const close = async (): Promise<void> => {
    for (const stop of stops) stop();
    stops = [];

    const closing = rig;

    rig = undefined;
    current = undefined;
    writable = NOTHING;
    await closing?.close().catch(() => undefined);
    lock(false);
    showSample();
  };

  const open = async (): Promise<void> => {
    const option = model.selectedOptions[0];

    if (option === undefined) {
      return;
    }

    setError(undefined);
    lock(true);
    stopSample?.();
    connecting('Choose a port');

    /* Ask first, inside the click's activation; the download runs meanwhile. */
    const loading = load();
    const port = await navigator.serial.requestPort();

    connecting('Loading Hamlib');

    const instance = await loading;
    const target = {
      id: Number(option.value),
      rateMin: Number(option.dataset.min ?? 0),
      rateMax: Number(option.dataset.max ?? 0),
    };
    const baudRate = baud.value === 'auto'
      ? await detectRate(instance, target, port, (rate) => { connecting(`Trying ${String(rate)}`); })
      : Number(baud.value);

    connecting('Connecting');
    rig = await instance.open({ modelId: target.id, port, baudRate });
    rememberRate(target.id, rig.baudRate);

    const { capabilities } = rig;

    writable = { frequency: capabilities.setFrequency, mode: capabilities.setMode, ptt: capabilities.setPtt };

    const telemetry: RigField[] = [];

    if (capabilities.getFrequency) telemetry.push('frequency');
    if (capabilities.getMode) telemetry.push('mode');
    if (capabilities.getPtt) telemetry.push('ptt');

    const view = (state: RigState | undefined): PanelView => ({
      phase: 'connected',
      sample: false,
      name: `${rig?.model.manufacturer ?? ''} ${rig?.model.model ?? ''}`.trim(),
      meta: `${String(rig?.baudRate ?? '')} baud`,
      pill: 'Connected',
      state,
    });

    const show = (state: RigState): void => {
      current = state;
      paint(root, view(state), writable);
    };

    stops.push(rig.on('state', show));
    show(await rig.refresh());

    /* The S-meter polls on its own, faster timer, so it moves while the slower reads wait. */
    if (telemetry.length > 0) stops.push(rig.watch({ intervalMs: POLL_MS.telemetry, fields: telemetry }));
    if (capabilities.levels.includes('STRENGTH')) stops.push(rig.watch({ intervalMs: POLL_MS.meter, fields: ['levels'] }));
  };

  /* Restore the radio picked last time, here or on the demo page. */
  let stored: string | null = null;

  try {
    stored = localStorage.getItem(MODEL_KEY);
  } catch {
    /* Storage disabled. */
  }

  const emulated = options.emulated === true
    ? [...model.options].find((option) => option.textContent.endsWith(` ${EMULATED_MODEL}`))
    : undefined;

  if (emulated !== undefined) {
    model.value = emulated.value;
  } else if (stored !== null && [...model.options].some((option) => option.value === stored)) {
    model.value = stored;
  }

  model.addEventListener('change', () => {
    try {
      localStorage.setItem(MODEL_KEY, model.value);
    } catch {
      /* Storage disabled: the page simply forgets. */
    }

    pickModel();
  });

  if (!serial) {
    if (note !== null) note.textContent = 'Connecting needs Web Serial: desktop Chrome, Edge or Firefox 151+.';
  } else {
    const early = (): void => {
      if ((navigator as { connection?: NetworkInformation }).connection?.saveData !== true) {
        void load().catch(() => undefined);
      }
    };

    connect.addEventListener('pointerenter', early, { once: true });
    connect.addEventListener('focus', early, { once: true });
  }

  connect.addEventListener('click', () => {
    open().catch(async (cause: unknown) => {
      await close();
      setError(message(cause));
    });
  });
  disconnect.addEventListener('click', () => { void close(); });

  /* Writes: each one, then a read, so the display answers at once rather than on the next poll. */
  const write = (run: (target: Rig) => Promise<unknown>): void => {
    const target = rig;

    if (target === undefined) {
      return;
    }

    setError(undefined);
    run(target).then(() => target.refresh()).catch((cause: unknown) => { setError(message(cause)); });
  };

  /* Mode chips are rebuilt when the list changes, so listen on their container. */
  root.querySelector('[data-radio-modes]')?.addEventListener('click', (event) => {
    const chip = (event.target as Element).closest('button');

    if (chip !== null && !chip.disabled && chip.textContent !== '') {
      write((target) => target.setMode(chip.textContent));
    }
  });

  const ptt = root.querySelector<HTMLButtonElement>('[data-testid="ptt-button"]');

  if (ptt !== null) bindPtt(ptt, (on) => { write((target) => target.setPtt(on)); });

  const step = root.querySelector<HTMLSelectElement>('[data-radio-controls] select');
  const tune = (direction: number): void => {
    const hz = current?.frequency;

    if (hz !== undefined) {
      write((target) => target.setFrequency(Math.max(0, hz + direction * Number(step?.value ?? 1000))));
    }
  };

  root.querySelector('[data-testid="tune-down"]')?.addEventListener('click', () => { tune(-1); });
  root.querySelector('[data-testid="tune-up"]')?.addEventListener('click', () => { tune(1); });

  const entry = root.querySelector<HTMLInputElement>('[data-testid="frequency-input"]');
  const set = root.querySelector<HTMLButtonElement>('[data-testid="frequency-set"]');
  const submit = (): void => {
    const hz = Number(entry?.value.replace(/[^0-9]/g, '') ?? '');

    if (entry !== null) entry.value = '';
    if (set !== null) set.disabled = true;
    if (Number.isFinite(hz) && hz > 0) write((target) => target.setFrequency(hz));
  };

  entry?.addEventListener('input', () => { if (set !== null) set.disabled = !writable.frequency || entry.value === ''; });
  entry?.addEventListener('keydown', (event) => { if (event.key === 'Enter') submit(); });
  set?.addEventListener('click', submit);

  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-testid^="passband-"]')) {
    const kind = button.dataset.testid?.replace('passband-', '') as PassbandSelector;

    button.addEventListener('click', () => { write((target) => target.setPassband(kind)); });
  }
  addEventListener('pagehide', () => { void close(); });

  pickModel();
  showSample();
}
