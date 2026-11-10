/**
 * The live demo: one Hamlib module, one rig, one front panel.
 *
 * This module is only ever reached through a dynamic `import()` from the
 * demo page's island, so the Emscripten glue and the Wasm it pulls in are not
 * fetched by any other documentation page.
 *
 * The same panel as the landing page, with its controls: sample readings
 * until a radio is connected, then the radio's own.  The call log, and the
 * choice of API that only shows in it, stay behind a toggle.
 */
import { StrictMode, useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';

import { HamlibError } from 'hamlib-wasm';
import type { HamlibOptions, RigModel, RigState, SerialPortLike } from 'hamlib-wasm';
import { HamlibProvider, useHamlibContext, useModels } from 'hamlib-wasm/react';

import { DemoLoading } from '../components/DemoLoading';
import { detectRate, ratesFor, rememberRate } from '../radio/detect';
import { RadioPanel } from '../radio/RadioPanel';
import type { PanelModel, PanelView } from '../radio/RadioPanel';
import { simulate } from '../radio/simulate';
import { useBackend } from './backend';
import type { Api, Log, LogEntry } from './backend';
import '../radio/radio.css';
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

function toPanel(model: RigModel): PanelModel {
  return {
    id: model.id,
    manufacturer: model.manufacturer,
    model: model.model,
    ...(model.limitation === undefined ? {} : { limitation: model.limitation }),
    rateMin: model.serialRateMin,
    rateMax: model.serialRateMax,
  };
}

function asHamlibError(cause: unknown, operation: string): HamlibError {
  return cause instanceof HamlibError
    ? cause
    : new HamlibError(cause instanceof Error ? cause.message : String(cause), { code: 'TRANSPORT_FAILURE', operation });
}

function App(): ReactElement {
  const { hamlib, loading, error: loadError } = useHamlibContext();
  const models = useModels();
  const panelModels = useMemo(() => models.map(toPanel), [models]);

  const [api, setApi] = useState<Api>('rig');
  const [showCalls, setShowCalls] = useState(() => recall(CALLS_KEY) === 'true');
  const [entries, setEntries] = useState<readonly Logged[]>([]);
  const [modelId, setModelId] = useState<number | undefined>(undefined);
  const [baud, setBaud] = useState('auto');
  const [trying, setTrying] = useState<number | undefined>(undefined);
  const [detecting, setDetecting] = useState(false);
  const [detectError, setDetectError] = useState<HamlibError | undefined>(undefined);
  const [sample, setSample] = useState<RigState | undefined>(undefined);

  const log = useCallback<Log>((entry) => {
    setEntries((current) => [{ ...entry, id: Math.random() }, ...current].slice(0, LOG_LIMIT));
  }, []);

  const backend = useBackend(api, log);
  const { rig } = backend;

  useEffect(() => {
    if (modelId === undefined && models.length > 0) {
      setModelId(defaultModel(models)?.id);
    }
  }, [modelId, models]);

  const selected = useMemo(() => panelModels.find((model) => model.id === modelId), [panelModels, modelId]);
  const rates = useMemo(() => (selected === undefined ? [] : ratesFor(selected.rateMin, selected.rateMax)), [selected]);
  const connected = rig !== undefined;
  const busy = backend.connecting || detecting;
  const serial = typeof navigator !== 'undefined' && 'serial' in navigator;
  const error = loadError ?? detectError ?? backend.error;

  /* With no radio, the panel plays sample readings - and stops the moment one connects. */
  useEffect(() => {
    if (connected || busy) {
      return undefined;
    }

    return simulate(setSample);
  }, [connected, busy]);

  /* The rate that worked is the first one Auto-detect tries next time. */
  useEffect(() => {
    if (rig !== undefined) {
      rememberRate(rig.model.id, rig.baudRate);
    }
  }, [rig]);

  if (loading && loadError === undefined) {
    return <DemoLoading />;
  }

  const connect = (): void => {
    if (selected === undefined || hamlib === undefined) {
      return;
    }

    const open = async (): Promise<void> => {
      if (baud !== 'auto') {
        await backend.connect(selected.id, Number(baud));
        return;
      }

      /* One gesture covers both steps: the granted port is searched, then opened. */
      let port: SerialPortLike;
      let found: number;

      try {
        log({ api, call: 'requestPort()' });
        port = await hamlib.requestPort();
        setDetecting(true);
        found = await detectRate(hamlib, selected, port, (rate) => {
          setTrying(rate);
          log({ api, call: `detectBaudRate({ modelId: ${String(selected.id)}, rates: [${String(rate)}] })` });
        });
      } catch (cause) {
        setDetectError(asHamlibError(cause, 'detectBaudRate'));
        return;
      } finally {
        setDetecting(false);
        setTrying(undefined);
      }

      setBaud(String(found));
      await backend.connect(selected.id, found, port);
    };

    setDetectError(undefined);
    /* A failed open is reported by the backend itself. */
    void open().catch(() => undefined);
  };

  let view: PanelView;

  if (rig !== undefined) {
    view = {
      phase: 'connected',
      sample: false,
      name: `${rig.model.manufacturer} ${rig.model.model}`,
      meta: `${String(rig.baudRate)} baud`,
      pill: 'Connected',
      state: backend.state,
    };
  } else if (busy) {
    view = {
      phase: 'connecting',
      sample: false,
      name: 'Connecting',
      meta: '',
      pill: trying === undefined ? 'Connecting' : `Trying ${String(trying)}`,
      state: undefined,
    };
  } else {
    view = { phase: 'disconnected', sample: true, name: 'No radio connected', meta: 'sample readings', pill: 'Sample', state: sample };
  }

  const note = (
    <>
      <span data-testid="hamlib-version">{hamlib?.version ?? 'Hamlib unavailable'}</span>
      {' · '}
      <span data-testid="web-serial-status" data-state={serial ? 'available' : 'unavailable'}>
        {serial
          ? 'Web Serial available'
          : 'Web Serial unavailable: use desktop Chrome, Edge or Firefox 151+'}
      </span>
    </>
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
        <RadioPanel
          view={view}
          models={panelModels}
          modelId={modelId}
          baud={baud}
          rates={rates}
          serial={serial}
          locked={hamlib === undefined || busy}
          note={note}
          {...(error === undefined ? {} : { error: error.message })}
          {...(connected
            ? {
              controls: {
                capabilities: backend.capabilities,
                busy,
                onSetFrequency: backend.setFrequency,
                onSetMode: backend.setMode,
                onSetPassband: backend.setPassband,
                onSetPtt: backend.setPtt,
              },
            }
            : {})}
          onModel={(id) => {
            setModelId(id);
            setBaud('auto');
            remember(MODEL_KEY, String(id));
          }}
          onBaud={setBaud}
          onConnect={connect}
          onDisconnect={() => { void backend.disconnect().catch(() => undefined); }}
        />

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
