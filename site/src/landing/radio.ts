/**
 * The landing page's radio: the demo's panel, with no React.
 *
 * The panel is `RadioPanel` rendered to HTML at build time; this script
 * brings it to life.  With no radio it plays sample readings.  Connect has
 * to ask for the port inside the click's user activation, which a megabyte
 * download would outlive, so it asks Web Serial itself and loads Hamlib
 * alongside; pointing at or focusing the button starts the download early,
 * unless the connection is constrained.
 *
 * Connected, it reads and writes the rig the way the demo page does
 * (`../radio/polling.ts`).  The demo page adds the log of every library call.
 */
import type { Hamlib, Rig } from 'hamlib-wasm';

import { WEB_SERIAL_BROWSERS } from '../facts';
import { constrainedConnection } from '../network';
import { baudRates, detectRate, rememberRate } from '../radio/detect';
import { failureMessage } from '../radio/errors';
import { MODES, PASSBANDS } from '../radio/format';
import { defaultModel } from '../radio/models';
import type { PanelModel } from '../radio/models';
import { paint } from '../radio/paint';
import { PANEL_OPTIONS, watchPanel, writeAndRead } from '../radio/polling';
import { bindPtt } from '../radio/ptt';
import { simulate } from '../radio/simulate';
import { MODEL_KEY, remember } from '../radio/storage';
import { connectedView, connectingView, sampleView } from '../radio/views';

export interface MountOptions {
  /** The Web Serial double is installed: pick the model it speaks. */
  readonly emulated?: boolean;
}

/** A picker entry, read back from the attributes `RadioPanel` renders. */
function toModel(option: HTMLOptionElement): PanelModel {
  return {
    id: Number(option.value),
    manufacturer: option.parentElement instanceof HTMLOptGroupElement ? option.parentElement.label : '',
    model: option.dataset.model ?? '',
    limitation: option.dataset.limitation,
    serialRateMin: Number(option.dataset.min),
    serialRateMax: Number(option.dataset.max),
  };
}

export function mountRadio(root: HTMLElement, options: MountOptions = {}): void {
  const $ = <T extends Element>(selector: string): T => {
    const element = root.querySelector<T>(selector);

    if (element === null) {
      throw new Error(`radio: missing ${selector}`);
    }

    return element;
  };

  const model = $<HTMLSelectElement>('[data-radio-model]');
  const baud = $<HTMLSelectElement>('[data-radio-baud]');
  const connect = $<HTMLButtonElement>('[data-radio-connect]');
  const disconnect = $<HTMLButtonElement>('[data-radio-disconnect]');
  const limitation = $<HTMLElement>('[data-radio-limitation]');
  const error = $<HTMLElement>('[data-radio-error]');
  const note = $<HTMLElement>('[data-radio-note]');
  const auto = $<HTMLOptionElement>('[data-radio-baud] option[value="auto"]');

  const models = [...model.options].map(toModel);
  const serial = 'serial' in navigator;
  let hamlib: Promise<Hamlib> | undefined;
  let rig: Rig | undefined;
  let stopPolling: (() => void) | undefined;
  let stopSample: (() => void) | undefined;

  const selected = (): PanelModel | undefined => models.find((entry) => String(entry.id) === model.value);

  const load = (): Promise<Hamlib> => {
    hamlib ??= import('hamlib-wasm').then((module) => module.createHamlib(PANEL_OPTIONS));
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
    connect.disabled = locked || !serial || selected()?.limitation !== undefined;
  };

  const showSample = (): void => {
    stopSample?.();
    stopSample = simulate((state) => { paint(root, sampleView(state)); });
  };

  const connecting = (step: string): void => { paint(root, connectingView(step)); };

  /* Offer the rates the picked model accepts, and say why a model cannot work. */
  const pickModel = (): void => {
    const picked = selected();

    baud.replaceChildren(auto, ...(picked === undefined ? [] : baudRates(picked)).map((rate) => new Option(String(rate))));
    baud.value = 'auto';

    const reason = picked?.limitation;

    limitation.textContent = picked === undefined || reason === undefined ? '' : `${picked.manufacturer} ${picked.model}: ${reason}`;
    limitation.hidden = reason === undefined;
    lock(false);
  };

  const close = async (): Promise<void> => {
    stopPolling?.();
    stopPolling = undefined;

    const closing = rig;

    rig = undefined;
    await closing?.close().catch(() => undefined);
    lock(false);
    showSample();
  };

  const open = async (): Promise<void> => {
    const target = selected();

    if (target === undefined) {
      return;
    }

    setError(undefined);
    lock(true);
    stopSample?.();
    connecting('Choose a port');

    const loading = load();
    const port = await navigator.serial.requestPort();

    connecting('Loading Hamlib');

    const instance = await loading;
    const baudRate = baud.value === 'auto'
      ? await detectRate(instance, target, port, (rate) => { connecting(`Trying ${String(rate)}`); })
      : Number(baud.value);

    connecting('Connecting');

    const opened = await instance.open({ modelId: target.id, port, baudRate });

    rig = opened;
    rememberRate(target.id, opened.baudRate);

    const show = (): void => { paint(root, connectedView(opened, opened.state), opened.capabilities); };
    const unsubscribe = opened.on('state', show);
    const unwatch = watchPanel(opened);

    stopPolling = () => { unsubscribe(); unwatch(); };
    show();
  };

  const write = (run: (target: Rig) => Promise<unknown>): void => {
    if (rig === undefined) {
      return;
    }

    setError(undefined);
    writeAndRead(rig, run).catch((cause: unknown) => { setError(failureMessage(cause)); });
  };

  const initial = defaultModel(models, options.emulated === true);

  if (initial !== undefined) {
    model.value = String(initial.id);
  }

  model.addEventListener('change', () => {
    remember(MODEL_KEY, model.value);
    pickModel();
  });

  if (!serial) {
    note.textContent = `Connecting needs Web Serial: ${WEB_SERIAL_BROWSERS}.`;
  } else {
    const early = (): void => {
      if (!constrainedConnection()) {
        void load().catch(() => undefined);
      }
    };

    connect.addEventListener('pointerenter', early, { once: true });
    connect.addEventListener('focus', early, { once: true });
  }

  connect.addEventListener('click', () => {
    open().catch(async (cause: unknown) => {
      await close();
      setError(failureMessage(cause));
    });
  });
  disconnect.addEventListener('click', () => { void close(); });

  /* Mode chips are rebuilt when the list changes, so listen on their container. */
  $('[data-radio-modes]').addEventListener('click', (event) => {
    const chip = (event.target as Element).closest<HTMLButtonElement>('[data-mode]');
    const mode = MODES.find((candidate) => candidate === chip?.dataset.mode);

    if (chip !== null && !chip.disabled && mode !== undefined) {
      write((target) => target.setMode(mode));
    }
  });

  const controls = $('[data-radio-controls]');
  const ptt = controls.querySelector<HTMLButtonElement>('[data-radio-ptt]');

  if (ptt !== null) bindPtt(ptt, (on) => { write((target) => target.setPtt(on)); });

  const step = controls.querySelector<HTMLSelectElement>('[data-radio-step]');

  for (const button of controls.querySelectorAll<HTMLButtonElement>('[data-tune]')) {
    const direction = Number(button.dataset.tune);

    button.addEventListener('click', () => {
      const hz = rig?.state?.frequency;

      if (hz !== undefined) {
        write((target) => target.setFrequency(Math.max(0, hz + direction * Number(step?.value ?? 1000))));
      }
    });
  }

  const entry = controls.querySelector<HTMLInputElement>('[data-radio-entry]');
  const set = controls.querySelector<HTMLButtonElement>('[data-radio-set]');
  const submit = (): void => {
    const hz = Number(entry?.value.replace(/[^0-9]/g, '') ?? '');

    if (entry !== null) entry.value = '';
    if (set !== null) set.disabled = true;
    if (Number.isFinite(hz) && hz > 0) write((target) => target.setFrequency(hz));
  };

  entry?.addEventListener('input', () => { if (set !== null) set.disabled = rig?.capabilities.setFrequency !== true || entry.value === ''; });
  entry?.addEventListener('keydown', (event) => { if (event.key === 'Enter') submit(); });
  set?.addEventListener('click', submit);

  for (const button of controls.querySelectorAll<HTMLButtonElement>('[data-passband]')) {
    const kind = PASSBANDS.find((candidate) => candidate === button.dataset.passband);

    if (kind !== undefined) button.addEventListener('click', () => { write((target) => target.setPassband(kind)); });
  }
  addEventListener('pagehide', () => { void close(); });

  pickModel();
  showSample();
}
