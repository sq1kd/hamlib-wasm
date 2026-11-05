/**
 * The live demo: one Hamlib module, one rig, one front panel.
 *
 * This module is only ever reached through a dynamic `import()` from the
 * "Load live demo" button, so the Emscripten glue and the Wasm it pulls in are
 * not fetched by the documentation page itself.
 */
import { StrictMode, useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';

import { HamlibError } from 'hamlib-wasm';
import type { HamlibOptions, RigModel, SerialPortLike } from 'hamlib-wasm';
import { HamlibProvider, useHamlibContext, useModels } from 'hamlib-wasm/react';

import { useBackend } from './backend';
import type { Api, Log, LogEntry } from './backend';
import { RigPanel } from './RigPanel';
import './demo.css';

/* A module constant: the provider reads its options once. */
const OPTIONS: HamlibOptions = { levels: ['STRENGTH', 'SWR'] };

const LOG_LIMIT = 40;

const APIS: readonly { readonly api: Api; readonly code: string; readonly note: string }[] = [
  {
    api: 'rig',
    code: 'rig.setMode(mode)',
    note: 'one snapshot, passband filled in, polled by watch()',
  },
  {
    api: 'raw',
    code: 'rig.raw.setMode(mode, width)',
    note: 'the RawRig: one call per Hamlib operation, polled by hand',
  },
];

interface Logged extends LogEntry {
  readonly id: number;
}

/** The TS-480 when present: the model the test suite's emulator speaks. */
function defaultModel(models: readonly RigModel[]): RigModel | undefined {
  return models.find((model) => model.model === 'TS-480')
    ?? models.find((model) => model.support === 'verified')
    ?? models[0];
}

/** Group the catalogue by manufacturer, preserving its order. */
function byManufacturer(models: readonly RigModel[]): [string, RigModel[]][] {
  const groups = new Map<string, RigModel[]>();

  for (const model of models) {
    groups.set(model.manufacturer, [...(groups.get(model.manufacturer) ?? []), model]);
  }

  return [...groups.entries()];
}

function App(): ReactElement {
  const { hamlib, loading, error: loadError } = useHamlibContext();
  const models = useModels();

  const [api, setApi] = useState<Api>('rig');
  const [entries, setEntries] = useState<readonly Logged[]>([]);
  const [modelId, setModelId] = useState<number | undefined>(undefined);
  const [baudRate, setBaudRate] = useState('');
  const [detect, setDetect] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [detectError, setDetectError] = useState<HamlibError | undefined>(undefined);

  const log = useCallback<Log>((entry) => {
    setEntries((current) => [{ ...entry, id: Math.random() }, ...current].slice(0, LOG_LIMIT));
  }, []);

  const backend = useBackend(api, log);

  useEffect(() => {
    if (modelId === undefined && models.length > 0) {
      setModelId(defaultModel(models)?.id);
    }
  }, [modelId, models]);

  const selected = useMemo(() => models.find((model) => model.id === modelId), [models, modelId]);
  const connected = backend.rig !== undefined;
  const busy = backend.connecting || detecting;
  const serial = typeof navigator !== 'undefined' && 'serial' in navigator;
  const error = loadError ?? detectError ?? backend.error;

  const connect = (): void => {
    if (modelId === undefined || hamlib === undefined) {
      return;
    }

    const open = async (): Promise<void> => {
      if (!detect) {
        await backend.connect(modelId, baudRate === '' ? undefined : Number(baudRate));
        return;
      }

      /* One gesture covers both steps: the granted port is searched, then opened. */
      let port: SerialPortLike;
      let found: number;

      try {
        log({ api, call: 'requestPort()' });
        port = await hamlib.requestPort();
        log({ api, call: `detectBaudRate({ modelId: ${String(modelId)} })` });
        setDetecting(true);
        found = await hamlib.detectBaudRate({ modelId, port });
      } catch (cause) {
        setDetectError(cause instanceof HamlibError
          ? cause
          : new HamlibError(String(cause), { code: 'TRANSPORT_FAILURE', operation: 'detectBaudRate' }));
        return;
      } finally {
        setDetecting(false);
      }

      setBaudRate(String(found));
      await backend.connect(modelId, found, port);
    };

    setDetectError(undefined);
    /* A failed open is reported by the backend itself. */
    void open().catch(() => undefined);
  };

  return (
    <div className="hamlib-demo not-content">
      <section className="panel" aria-label="Connection">
        <p className="status">
          <span data-testid="hamlib-version">{hamlib?.version ?? 'Hamlib: loading…'}</span>
          {' · '}
          <span data-testid="web-serial-status" data-state={serial ? 'available' : 'unavailable'}>
            {serial
              ? 'Web Serial available'
              : 'Web Serial unavailable: use a desktop Chromium-based browser or Firefox 151+'}
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
            {byManufacturer(models).map(([manufacturer, group]) => (
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
              : `tries ${String(selected.serialRateMin)}–${String(selected.serialRateMax)} baud`}
          </small>
        </label>

        <fieldset className="backend">
          <legend>Drive the panel through</legend>
          {APIS.map((option) => (
            <label key={option.api}>
              <input
                data-testid={`backend-${option.api}`}
                type="radio"
                name="backend"
                checked={api === option.api}
                disabled={busy || connected}
                onChange={() => { setApi(option.api); }}
              />
              <span>
                <code>{option.code}</code>
                <small>{option.note}</small>
              </span>
            </label>
          ))}
        </fieldset>

        <p className="actions">
          <button
            data-testid="connect-button"
            type="button"
            disabled={!serial || loading || connected || busy}
            onClick={connect}
          >
            Grant port &amp; connect
          </button>
          <button
            data-testid="disconnect-button"
            type="button"
            disabled={!connected}
            onClick={() => { void backend.disconnect().catch(() => undefined); }}
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

        {error !== undefined && <p className="error" data-testid="error-message">{error.message}</p>}
      </section>

      <RigPanel
        state={backend.state}
        capabilities={backend.capabilities}
        connected={connected}
        busy={busy}
        onSetFrequency={backend.setFrequency}
        onSetMode={backend.setMode}
        onSetPassband={backend.setPassband}
        onSetPtt={backend.setPtt}
      />

      <section className="log" aria-label="Library calls">
        <header>
          <h2>Library calls</h2>
          <button type="button" onClick={() => { setEntries([]); }}>Clear</button>
        </header>
        <ol data-testid="call-log">
          {entries.map((entry) => (
            <li key={entry.id} data-api={entry.api}>
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

export default function Demo(): ReactElement {
  return (
    <StrictMode>
      <HamlibProvider options={OPTIONS}>
        <App />
      </HamlibProvider>
    </StrictMode>
  );
}
