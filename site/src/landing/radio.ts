/**
 * The landing page's radio: the demo's panel, read-only, with no React.
 *
 * The panel is `RadioPanel` rendered to HTML at build time; this script
 * brings it to life.  With no radio it plays sample readings.  Connect has
 * to ask for the port inside the click's user activation, which a megabyte
 * download would outlive, so it asks first and loads Hamlib alongside;
 * pointing at or focusing the button starts the download early, unless the
 * reader asked to save data.
 *
 * Read-only by design: it polls frequency, mode, PTT and the S-meter and has
 * no control that writes to the radio.  The demo page has the full panel.
 */
import type { Hamlib, HamlibError, Rig, RigField, RigState } from 'hamlib-wasm';

import { detectRate, rememberRate } from '../radio/detect';
import { POLL_MS } from '../radio/format';
import { paint } from '../radio/paint';
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

export function mountRadio(root: HTMLElement): void {
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
    const telemetry: RigField[] = [];

    if (capabilities.getFrequency) telemetry.push('frequency');
    if (capabilities.getMode) telemetry.push('mode');
    if (capabilities.getPtt) telemetry.push('ptt');

    const view = (state: RigState | undefined): PanelView => ({
      phase: 'connected',
      sample: false,
      name: `${rig?.model.manufacturer ?? ''} ${rig?.model.model ?? ''}`.trim(),
      meta: `${String(rig?.baudRate ?? '')} baud · read-only`,
      pill: 'Connected',
      state,
    });

    stops.push(rig.on('state', (state) => { paint(root, view(state)); }));
    paint(root, view(await rig.refresh()));

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

  if (stored !== null && [...model.options].some((option) => option.value === stored)) {
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
  addEventListener('pagehide', () => { void close(); });

  pickModel();
  showSample();
}
