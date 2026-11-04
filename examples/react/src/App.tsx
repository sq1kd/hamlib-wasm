/**
 * The landing page application.
 *
 * One panel, two backends: the radio on screen is driven either through the
 * easy entry (`hamlib-wasm`, via `hamlib-wasm/react`) or through the 1:1 entry
 * (`hamlib-wasm/hamlib`), and the call log underneath shows exactly which
 * library calls each one makes for the same interaction.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';

import { HamlibError } from 'hamlib-wasm';
import type { RigModel } from 'hamlib-wasm';
import { useHamlibContext, useModels } from 'hamlib-wasm/react';

import { useEasyBackend, useNativeBackend } from './backend';
import type { Backend, BackendKind, LogEntry, Log } from './backend';
import { RigPanel } from './RigPanel';

interface Logged extends LogEntry {
  readonly at: number;
}

const LOG_LIMIT = 40;

function webSerialAvailable(): boolean {
  return typeof navigator !== 'undefined' && 'serial' in navigator;
}

/** Pick the model the demo starts on: the TS-480 when it is present. */
function defaultModel(models: readonly RigModel[]): RigModel | undefined {
  return models.find((model) => model.model === 'TS-480')
    ?? models.find((model) => model.support === 'verified')
    ?? models[0];
}

function BackendPicker(
  { kind, disabled, onChange }: {
    readonly kind: BackendKind;
    readonly disabled: boolean;
    readonly onChange: (kind: BackendKind) => void;
  },
): ReactElement {
  return (
    <fieldset className="backend">
      <legend>Backend</legend>
      {(['easy', 'native'] as const).map((option) => (
        <label key={option}>
          <input
            data-testid={`backend-${option}`}
            type="radio"
            name="backend"
            value={option}
            checked={kind === option}
            disabled={disabled}
            onChange={() => { onChange(option); }}
          />
          <span>
            <code>{option === 'easy' ? `import { createEasy } from 'hamlib-wasm'` : `import { createHamlib } from 'hamlib-wasm/hamlib'`}</code>
            <small>
              {option === 'easy'
                ? 'one snapshot, passband filled in, events and watch()'
                : 'one call per Hamlib operation, polled by hand'}
            </small>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

export function App(): ReactElement {
  const { hamlib, loading, error: loadError } = useHamlibContext();
  const models = useModels();

  const [kind, setKind] = useState<BackendKind>('easy');
  const [entries, setEntries] = useState<readonly Logged[]>([]);
  const [modelId, setModelId] = useState<number | undefined>(undefined);
  const [baudRate, setBaudRate] = useState('');
  const [detect, setDetect] = useState(false);
  /* True while the search runs: it owns the port from the grant until the rig
   * is opened on it. */
  const [detecting, setDetecting] = useState(false);
  /* A failure of the search itself: the backends own the errors of the open
   * they perform, and this is the step before it. */
  const [detectError, setDetectError] = useState<HamlibError | undefined>(undefined);

  const log = useCallback<Log>((entry) => {
    setEntries((current) => [{ ...entry, at: Date.now() }, ...current].slice(0, LOG_LIMIT));
  }, []);

  const easy = useEasyBackend(log);
  const native = useNativeBackend(log);
  const backend: Backend = kind === 'easy' ? easy : native;

  useEffect(() => {
    if (modelId === undefined && models.length > 0) {
      setModelId(defaultModel(models)?.id);
    }
  }, [modelId, models]);

  const selected = useMemo(
    () => models.find((model) => model.id === modelId),
    [models, modelId],
  );

  const connected = backend.connected;
  /* A search counts as busy too: it holds the port and takes seconds, so the
   * panel must not offer a second connect while it runs. */
  const busy = backend.connecting || detecting;
  const serial = webSerialAvailable();

  const connect = (): void => {
    if (modelId === undefined) {
      return;
    }

    const parsed = baudRate === '' ? undefined : Number(baudRate);

    const open = async (): Promise<void> => {
      if (!detect) {
        await backend.connect(modelId, parsed);
        return;
      }

      if (hamlib === undefined) {
        throw new HamlibError('Hamlib is still loading', {
          code: 'DISPOSED',
          operation: 'detectBaudRate',
        });
      }

      /* One gesture covers both steps: the port granted here is the port the
       * search uses and the port the rig is then opened on. */
      log({ api: kind, call: 'requestPort()' });
      const port = await hamlib.requestPort();

      log({ api: kind, call: `detectBaudRate({ modelId: ${modelId} })` });
      setDetecting(true);

      let found: number;

      try {
        found = await hamlib.detectBaudRate({ modelId, port });
      } finally {
        setDetecting(false);
      }

      setBaudRate(String(found));
      await backend.connect(modelId, found, port);
    };

    setDetectError(undefined);

    void open().catch((cause: unknown) => {
      setDetectError(cause instanceof HamlibError
        ? cause
        : new HamlibError(cause instanceof Error ? cause.message : String(cause), {
          code: 'TRANSPORT_FAILURE',
          operation: 'detectBaudRate',
        }));
    });
  };

  const disconnect = (): void => {
    void backend.disconnect().catch(() => undefined);
  };

  const changeBackend = (next: BackendKind): void => {
    if (next === kind) {
      return;
    }

    void backend.disconnect().then(() => { setKind(next); }, () => undefined);
  };

  const canConnect = serial && !loading && !connected && !busy;

  return (
    <div className="app">
      <section className="panel" aria-label="Connection">
        <p className="status">
          <span data-testid="hamlib-version">{hamlib?.version ?? 'Hamlib: loading…'}</span>
          {' · '}
          <span data-testid="web-serial-status" data-state={serial ? 'available' : 'unavailable'}>
            {serial ? 'Web Serial available' : 'Web Serial unavailable — use a desktop Chromium-based browser or Firefox 151+'}
          </span>
        </p>

        <label className="field">
          Model
          <select
            data-testid="model-select"
            value={modelId === undefined ? '' : String(modelId)}
            disabled={loading || busy || connected}
            onChange={(event) => { setModelId(Number(event.target.value)); }}
          >
            {models.length === 0 && <option value="">loading…</option>}
            {manufacturers(models).map(([manufacturer, group]) => (
              <optgroup key={manufacturer} label={manufacturer}>
                {group.map((model) => (
                  <option key={model.id} value={String(model.id)}>
                    {model.model}
                    {model.support === 'verified' ? ' ✓' : ''}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>

        <label className="field">
          Baud rate (optional)
          <input
            data-testid="baud-input"
            type="number"
            inputMode="numeric"
            placeholder={selected === undefined ? 'model default' : String(selected.serialRateMax)}
            value={baudRate}
            disabled={loading || busy || connected || detect}
            onChange={(event) => { setBaudRate(event.target.value); }}
          />
        </label>

        <label className="field checkbox">
          <input
            data-testid="detect-input"
            type="checkbox"
            checked={detect}
            disabled={loading || busy || connected}
            onChange={(event) => { setDetect(event.target.checked); }}
          />
          Detect the baud rate
          <small>
            {selected === undefined
              ? 'tries the rates the model declares'
              : `tries ${String(selected.serialRateMin)}–${String(selected.serialRateMax)} baud; a rig behind a real UART answers at the rate its own menu is set to`}
          </small>
        </label>

        <BackendPicker kind={kind} disabled={busy || connected} onChange={changeBackend} />

        <p className="actions">
          <button data-testid="connect-button" type="button" disabled={!canConnect} onClick={connect}>
            Grant port &amp; connect
          </button>
          <button
            data-testid="disconnect-button"
            type="button"
            disabled={!connected}
            onClick={disconnect}
          >
            Disconnect
          </button>
        </p>

        <p data-testid="connection-state" data-state={connected ? 'connected' : 'disconnected'}>
          {connected && selected !== undefined
            ? `connected: ${selected.manufacturer} ${selected.model}`
            : 'disconnected'}
        </p>

        {selected?.limitation !== undefined && (
          <p className="limitation" data-testid="model-limitation">
            {selected.manufacturer} {selected.model}: {selected.limitation}
          </p>
        )}

        {(loadError ?? detectError ?? backend.error) !== undefined && (
          <p className="error" data-testid="error-message">
            {(loadError ?? detectError ?? backend.error)?.message}
          </p>
        )}
      </section>

      <RigPanel
        state={backend.state}
        capabilities={backend.capabilities}
        connected={connected}
        busy={busy}
        onSetFrequency={(hz) => { void backend.setFrequency(hz).catch(() => undefined); }}
        onSetMode={(mode) => { void backend.setMode(mode).catch(() => undefined); }}
        onSetPassband={(passband) => { void backend.setPassband(passband).catch(() => undefined); }}
        onSetPtt={(on) => { void backend.setPtt(on).catch(() => undefined); }}
      />

      <section className="log" aria-label="Library calls">
        <header>
          <h2>Library calls</h2>
          <button type="button" onClick={() => { setEntries([]); }}>Clear</button>
        </header>
        <ol data-testid="call-log">
          {entries.map((entry, index) => (
            <li key={`${String(entry.at)}-${String(index)}`} data-api={entry.api}>
              <code>{entry.api}</code>
              <span>{entry.call}</span>
            </li>
          ))}
          {entries.length === 0 && <li className="empty">no calls yet</li>}
        </ol>
      </section>
    </div>
  );
}

/** Group the catalogue by manufacturer, preserving the catalogue's order. */
function manufacturers(models: readonly RigModel[]): readonly (readonly [string, readonly RigModel[]])[] {
  const groups = new Map<string, RigModel[]>();

  for (const model of models) {
    const group = groups.get(model.manufacturer) ?? [];

    group.push(model);
    groups.set(model.manufacturer, group);
  }

  return [...groups.entries()];
}
