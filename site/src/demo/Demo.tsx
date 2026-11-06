/**
 * The live demo: one Hamlib module, one rig, one front panel.
 *
 * This module is only ever reached through a dynamic `import()` from the
 * demo page's island, so the Emscripten glue and the Wasm it pulls in are not
 * fetched by any other documentation page.
 *
 * Two steps: pick a model and connect, then drive the radio.  The call log,
 * and the choice of API that only shows in it, stay behind a toggle.
 */
import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';

import { HamlibError } from 'hamlib-wasm';
import type { HamlibOptions, RigModel, SerialPortLike } from 'hamlib-wasm';
import { HamlibProvider, useHamlibContext, useModels } from 'hamlib-wasm/react';

import { DemoLoading } from '../components/DemoLoading';
import { useBackend } from './backend';
import type { Api, Log, LogEntry } from './backend';
import { RigPanel } from './RigPanel';
import './demo.css';

/* A module constant: the provider reads its options once. */
const OPTIONS: HamlibOptions = { levels: ['STRENGTH', 'SWR'] };

const LOG_LIMIT = 40;

/* What a returning reader chose last time: the model and the log toggle. */
const MODEL_KEY = 'hamlib-demo:model';
const CALLS_KEY = 'hamlib-demo:calls';

function recall(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Storage disabled: the demo simply forgets. */
  }
}

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

/** The model picked last time, else the TS-480: the one the test suite's emulator speaks. */
function defaultModel(models: readonly RigModel[]): RigModel | undefined {
  const stored = Number(recall(MODEL_KEY) ?? Number.NaN);

  return models.find((model) => model.id === stored)
    ?? models.find((model) => model.model === 'TS-480')
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
  const [showCalls, setShowCalls] = useState(() => recall(CALLS_KEY) === 'true');
  const [entries, setEntries] = useState<readonly Logged[]>([]);
  const [modelId, setModelId] = useState<number | undefined>(undefined);
  const [baudRate, setBaudRate] = useState('');
  const [detect, setDetect] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [detectError, setDetectError] = useState<HamlibError | undefined>(undefined);
  const radioRef = useRef<HTMLHeadingElement>(null);

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

  /* The connect button goes away with the setup step; keep focus in the demo. */
  useEffect(() => {
    if (connected) {
      radioRef.current?.focus();
    }
  }, [connected]);

  if (loading && loadError === undefined) {
    return <DemoLoading />;
  }

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

  const errorMessage = error !== undefined && (
    <p className="error" data-testid="error-message" role="alert">{error.message}</p>
  );

  const setup = (
    <section className="panel setup" aria-label="Connect a radio">
      <p className="status">
        <span data-testid="hamlib-version">{hamlib?.version ?? 'Hamlib unavailable'}</span>
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
          disabled={hamlib === undefined || busy}
          onChange={(event) => {
            setModelId(Number(event.target.value));
            remember(MODEL_KEY, event.target.value);
          }}
        >
          {models.length === 0 && <option value="">no models</option>}
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

      <details className="advanced">
        <summary>Advanced</summary>

        <label className="field">
          Baud rate (optional)
          <input
            data-testid="baud-input"
            type="number"
            inputMode="numeric"
            placeholder={selected === undefined ? 'model default' : String(selected.serialRateMax)}
            value={baudRate}
            disabled={busy || detect}
            onChange={(event) => { setBaudRate(event.target.value); }}
          />
        </label>

        <label className="field checkbox">
          <input
            data-testid="detect-input"
            type="checkbox"
            checked={detect}
            disabled={busy}
            onChange={(event) => { setDetect(event.target.checked); }}
          />
          Detect the baud rate
          <small>
            {selected === undefined
              ? 'tries the rates the model declares'
              : `tries ${String(selected.serialRateMin)}–${String(selected.serialRateMax)} baud`}
          </small>
        </label>
      </details>

      {selected?.limitation !== undefined && (
        <p className="limitation" data-testid="model-limitation">
          {selected.manufacturer} {selected.model}: {selected.limitation}
        </p>
      )}

      <p className="actions">
        <button
          className="primary"
          data-testid="connect-button"
          type="button"
          disabled={!serial || hamlib === undefined || busy}
          onClick={connect}
        >
          {busy ? (detecting ? 'Detecting baud rate…' : 'Connecting…') : 'Grant port & connect'}
        </button>
        <span data-testid="connection-state" data-state="disconnected">disconnected</span>
      </p>

      {errorMessage}
    </section>
  );

  const radio = (
    <div className="radio">
      <header className="radio-bar">
        <h2 ref={radioRef} tabIndex={-1} data-testid="connection-state" data-state="connected">
          {selected === undefined ? 'connected' : `connected: ${selected.manufacturer} ${selected.model}`}
          {baudRate !== '' && <small> · {baudRate} baud</small>}
        </h2>
        <button
          data-testid="disconnect-button"
          type="button"
          onClick={() => { void backend.disconnect().catch(() => undefined); }}
        >
          Disconnect
        </button>
      </header>

      {errorMessage}

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
    </div>
  );

  return (
    <div className="hamlib-demo not-content">
      <p className="toolbar">
        <label>
          <input
            data-testid="show-calls"
            type="checkbox"
            checked={showCalls}
            onChange={(event) => {
              setShowCalls(event.target.checked);
              remember(CALLS_KEY, String(event.target.checked));
            }}
          />
          Show library calls
        </label>
      </p>

      <div className="workspace" data-calls={showCalls ? 'shown' : 'hidden'}>
        {connected ? radio : setup}

        {showCalls && (
          <section className="log" aria-label="Library calls">
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
        )}
      </div>
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
