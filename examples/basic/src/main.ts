/**
 * Minimal Vanilla TypeScript example.
 *
 * Startup:            load Hamlib, show its version, fill the model picker
 *                     (already sorted by manufacturer and model), and report
 *                     whether Web Serial exists.
 * Connect (gesture):  requestPort() then open() for the selected model.
 * Connected:          refresh frequency/mode/passband, set them, read and set
 *                     PTT, disconnect.
 *
 * The page never requests a port on its own and never stores a SerialPort.
 */
import { createHamlib, HamlibError } from 'hamlib-web/native';
import type { Hamlib, Rig, RigModel } from 'hamlib-web/native';

import './style.css';

function need<T extends HTMLElement>(testId: string): T {
  const element = document.querySelector<T>(`[data-testid="${testId}"]`);

  if (!element) {
    throw new Error(`the example markup is missing [data-testid="${testId}"]`);
  }

  return element;
}

const dom = {
  version: need<HTMLSpanElement>('hamlib-version'),
  webSerialStatus: need<HTMLParagraphElement>('web-serial-status'),
  modelSelect: need<HTMLSelectElement>('model-select'),
  baudInput: need<HTMLInputElement>('baud-input'),
  detectInput: need<HTMLInputElement>('detect-input'),
  connect: need<HTMLButtonElement>('connect-button'),
  disconnect: need<HTMLButtonElement>('disconnect-button'),
  connectionState: need<HTMLParagraphElement>('connection-state'),
  statusFrequency: need<HTMLOutputElement>('status-frequency'),
  statusMode: need<HTMLOutputElement>('status-mode'),
  statusPassband: need<HTMLOutputElement>('status-passband'),
  refresh: need<HTMLButtonElement>('refresh-button'),
  frequencyInput: need<HTMLInputElement>('frequency-input'),
  frequencySet: need<HTMLButtonElement>('frequency-set'),
  modeInput: need<HTMLInputElement>('mode-input'),
  passbandInput: need<HTMLInputElement>('passband-input'),
  modeSet: need<HTMLButtonElement>('mode-set'),
  pttSection: need<HTMLElement>('ptt-section'),
  pttState: need<HTMLOutputElement>('ptt-state'),
  pttSelect: need<HTMLSelectElement>('ptt-select'),
  pttSet: need<HTMLButtonElement>('ptt-set'),
  errorSection: need<HTMLElement>('error-section'),
  errorMessage: need<HTMLParagraphElement>('error-message'),
  errorDetail: need<HTMLParagraphElement>('error-detail'),
};

let hamlib: Hamlib | null = null;
let rig: Rig | null = null;
let model: RigModel | null = null;
let busy = false;

function webSerialAvailable(): boolean {
  return typeof navigator !== 'undefined' && Boolean(navigator.serial);
}

function selectedModel(): RigModel | null {
  const id = Number(dom.modelSelect.value);

  return hamlib?.models.find((candidate) => candidate.id === id) ?? null;
}

function render(): void {
  const connected = rig !== null;
  const serial = webSerialAvailable();
  const capabilities = model;

  dom.connect.disabled = busy || hamlib === null || !serial || connected;
  dom.disconnect.disabled = busy || !connected;
  dom.modelSelect.disabled = busy || connected;
  dom.baudInput.disabled = busy || connected || dom.detectInput.checked;
  dom.detectInput.disabled = busy || connected;

  dom.refresh.disabled = busy || !connected;

  const canSetFrequency = connected && !busy && capabilities?.canSetFrequency === true;
  const canSetMode = connected && !busy && capabilities?.canSetMode === true;

  dom.frequencyInput.disabled = !canSetFrequency;
  dom.frequencySet.disabled = !canSetFrequency;
  dom.modeInput.disabled = !canSetMode;
  dom.passbandInput.disabled = !canSetMode;
  dom.modeSet.disabled = !canSetMode;

  const canGetPtt = capabilities?.canGetPtt === true;
  const canSetPtt = connected && !busy && capabilities?.canSetPtt === true;

  dom.pttSection.hidden = !canGetPtt && !(capabilities?.canSetPtt ?? false);
  dom.pttSelect.disabled = !canSetPtt;
  dom.pttSet.disabled = !canSetPtt;
  dom.pttState.hidden = !canGetPtt;

  if (!connected) {
    dom.connectionState.textContent = 'disconnected';
    dom.statusFrequency.textContent = '—';
    dom.statusMode.textContent = '—';
    dom.statusPassband.textContent = '—';
    dom.pttState.textContent = '—';
  }
}

function clearError(): void {
  dom.errorSection.hidden = true;
  dom.errorMessage.textContent = '';
  dom.errorDetail.textContent = '';
}

/**
 * Show what failed and how, in terms a user can act on: the operation, the
 * stable code, the Hamlib error text and any transport detail.  No pointers,
 * no bare numeric codes.
 */
function showError(error: unknown): void {
  if (error instanceof HamlibError) {
    const parts = [
      `operation: ${error.operation}`,
      `code: ${error.code}`,
    ];

    if (error.hamlibCode !== undefined) {
      parts.push(`hamlib: ${error.hamlibCode} (${error.hamlibMessage ?? 'unknown'})`);
    }

    if (error.cause instanceof Error) {
      parts.push(`transport: ${error.cause.name}: ${error.cause.message}`);
    }

    dom.errorMessage.textContent = error.message;
    dom.errorDetail.textContent = parts.join(' · ');
  } else {
    dom.errorMessage.textContent = error instanceof Error
      ? error.message
      : String(error);
    dom.errorDetail.textContent = '';
  }

  dom.errorSection.hidden = false;
}

/** Run one interaction, keeping the form in a consistent state. */
async function interact(action: () => Promise<void>): Promise<void> {
  busy = true;
  clearError();
  render();

  try {
    await action();
  } catch (error) {
    showError(error);
  } finally {
    busy = false;
    render();
  }
}

async function refreshStatus(current: Rig): Promise<void> {
  /* Two generated operations: the library no longer composes them into one
   * call, so a UI that wants both reads both. */
  const frequency = await current.getFrequency();
  const mode = await current.getMode();

  dom.statusFrequency.textContent = String(frequency);
  dom.statusMode.textContent = mode.mode;
  dom.statusPassband.textContent = String(mode.passband);

  if (dom.frequencyInput.value === '') {
    dom.frequencyInput.value = String(frequency);
  }

  if (dom.modeInput.value === '') {
    dom.modeInput.value = mode.mode;
  }

  if (dom.passbandInput.value === '') {
    dom.passbandInput.value = String(mode.passband);
  }

  if (current.model.canGetPtt) {
    dom.pttState.textContent = await current.getPtt();
  }
}

async function connect(): Promise<void> {
  const selected = selectedModel();

  if (!hamlib || !selected) {
    return;
  }

  const port = await hamlib.requestPort();

  /* One gesture covers both steps: the port granted here is the port the search
   * uses and the port the rig is then opened on.  A rig behind a real UART
   * answers at the rate its own menu is set to, which no model declares. */
  const baudRate = dom.detectInput.checked
    ? await hamlib.detectBaudRate({ modelId: selected.id, port })
    : dom.baudInput.value === ''
      ? undefined
      : Number(dom.baudInput.value);

  if (dom.detectInput.checked) {
    dom.baudInput.value = String(baudRate);
  }

  const opened = await hamlib.open({
    modelId: selected.id,
    port,
    ...(baudRate === undefined ? {} : { baudRate }),
  });

  rig = opened;
  dom.connectionState.textContent
    = `connected: ${selected.manufacturer} ${selected.model}`;
  dom.statusFrequency.textContent = '—';
  dom.statusMode.textContent = '—';
  dom.statusPassband.textContent = '—';

  await refreshStatus(opened);
}

async function disconnect(): Promise<void> {
  const current = rig;

  rig = null;

  if (current) {
    await current.close();
  }

  dom.connectionState.textContent = 'disconnected';
  dom.pttState.textContent = '—';
  dom.statusFrequency.textContent = '—';
  dom.statusMode.textContent = '—';
  dom.statusPassband.textContent = '—';
}

function fillModels(models: readonly RigModel[]): void {
  dom.modelSelect.replaceChildren();

  for (const candidate of models) {
    const option = document.createElement('option');

    option.value = String(candidate.id);
    option.textContent = `${candidate.manufacturer} ${candidate.model}`;
    option.dataset.manufacturer = candidate.manufacturer;
    option.dataset.model = candidate.model;
    option.dataset.serialRateMin = String(candidate.serialRateMin);
    option.dataset.serialRateMax = String(candidate.serialRateMax);
    dom.modelSelect.append(option);
  }

  const ts480 = models.find(
    (candidate) => candidate.manufacturer === 'Kenwood' && candidate.model === 'TS-480',
  );

  dom.modelSelect.value = String(ts480?.id ?? models[0]?.id ?? '');
  dom.modelSelect.disabled = models.length === 0;
}

async function start(): Promise<void> {
  if (!webSerialAvailable()) {
    dom.webSerialStatus.textContent
      = 'Web Serial is not available in this browser: use a desktop '
      + 'Chromium-family browser over a secure context.';
    dom.webSerialStatus.dataset['state'] = 'unavailable';
  } else {
    dom.webSerialStatus.textContent = 'Web Serial is available.';
    dom.webSerialStatus.dataset['state'] = 'available';
  }

  try {
    hamlib = await createHamlib();
  } catch (error) {
    dom.version.textContent = 'failed to load';
    showError(error);
    return;
  }

  dom.version.textContent = hamlib.version;
  fillModels(hamlib.models);
  model = selectedModel();
  render();
}

dom.modelSelect.addEventListener('change', () => {
  model = selectedModel();
  render();
});

dom.detectInput.addEventListener('change', () => {
  render();
});

dom.connect.addEventListener('click', () => {
  void interact(connect);
});

dom.disconnect.addEventListener('click', () => {
  void interact(disconnect);
});

dom.refresh.addEventListener('click', () => {
  const current = rig;

  if (current) {
    void interact(() => refreshStatus(current));
  }
});

dom.frequencySet.addEventListener('click', () => {
  const current = rig;
  const frequency = Number(dom.frequencyInput.value);

  if (current) {
    void interact(async () => {
      await current.setFrequency(frequency);
      await refreshStatus(current);
    });
  }
});

dom.modeSet.addEventListener('click', () => {
  const current = rig;
  const mode = dom.modeInput.value.trim();

  if (current) {
    void interact(async () => {
      /* An empty box means "the rig's normal passband for this mode", which is
       * its own generated operation. */
      const width = dom.passbandInput.value === ''
        ? await current.passbandNormal(mode)
        : Number(dom.passbandInput.value);

      await current.setMode(mode, width);
      await refreshStatus(current);
    });
  }
});

dom.pttSet.addEventListener('click', () => {
  const current = rig;
  /* `setPtt` takes Hamlib's own state name and the facade reports an unknown
   * one as an error, so the select value is passed through unchanged. */
  const state = dom.pttSelect.value;

  if (current) {
    void interact(async () => {
      await current.setPtt(state);
      dom.pttState.textContent = await current.getPtt();
    });
  }
});

/* Best-effort cleanup when the page goes away.  Web Serial teardown is
 * asynchronous and cannot be awaited during unload, so this only starts it. */
window.addEventListener('pagehide', () => {
  void rig?.close();
  void hamlib?.dispose();
});

void start();
