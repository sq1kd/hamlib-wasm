/**
 * The live demo: one Hamlib module, one rig, one front panel.
 *
 * This module is only ever reached through a dynamic `import()` from the
 * demo page's island, so the Emscripten glue and the Wasm it pulls in are not
 * fetched by any other documentation page.
 *
 * The same panel as the landing page, with its controls: sample readings
 * until a radio is connected, then the radio's own.  The console of library
 * calls, with its choice of API, sits beside the radio at a fixed height.
 */
import { StrictMode, useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';

import { HamlibError } from 'hamlib-wasm';
import type { HamlibOptions, RigModel, RigState, SerialPortLike } from 'hamlib-wasm';
import { HamlibProvider, useHamlibContext, useModels } from 'hamlib-wasm/react';

import { DemoLoading } from '../components/DemoLoading';
import { detectRate, ratesFor, rememberRate } from '../radio/detect';
import { EMULATED_MODEL, emulate } from '../radio/emulate';
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

/* Development only: `?emulate` answers Web Serial with the test suite's TS-480. */
const EMULATED = await emulate();

/* What a returning reader chose last time: the model. */
const MODEL_KEY = 'hamlib-demo:model';

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

interface ApiOption {
  readonly api: Api;
  readonly label: string;
  readonly code: string;
  readonly note: string;
  /** The calls Connect will make, shown until it does. */
  readonly preview: readonly string[];
}

const APIS: readonly [ApiOption, ApiOption] = [
  {
    api: 'rig',
    label: 'Rig',
    code: 'rig.setMode(mode)',
    note: 'one snapshot, passband filled in, polled for you',
    preview: [
      'open({ modelId, baudRate })',
      "useRigState(rig, { pollMs: 1000 })",
      "useRigState(rig, { pollMs: 250, fields: ['levels'] })",
      "setMode('USB')",
      'setPtt(true)',
    ],
  },
  {
    api: 'raw',
    label: 'Raw',
    code: 'rig.raw.setMode(mode, width)',
    note: 'the RawRig: one call per Hamlib operation, polled by hand',
    preview: [
      'open({ modelId, baudRate })',
      'getFrequency()',
      'getMode()',
      'getPtt()',
      "setMode('USB', width)",
    ],
  },
];

interface Logged extends LogEntry {
  readonly id: number;
}

/** The model picked last time, else the TS-480: the one the test suite's emulator speaks. */
function defaultModel(models: readonly RigModel[]): RigModel | undefined {
  const stored = Number(recall(MODEL_KEY) ?? Number.NaN);

  return (EMULATED ? models.find((model) => model.model === EMULATED_MODEL) : undefined)
    ?? models.find((model) => model.id === stored)
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

  const chosen = APIS.find((option) => option.api === api) ?? APIS[0];

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
      <div className="workspace">
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

        <aside className="console-rail" aria-label="Library calls">
          <section className="console">
            <header>
              <span className="console-title">Library calls</span>
              <div className="console-api" role="radiogroup" aria-label="Drive the panel through">
                {APIS.map((option) => (
                  <label key={option.api} title={option.note}>
                    <input
                      data-testid={`backend-${option.api}`}
                      type="radio"
                      name="backend"
                      checked={api === option.api}
                      disabled={busy || connected}
                      onChange={() => { setApi(option.api); }}
                    />
                    <span>{option.label}</span>
                  </label>
                ))}
              </div>
              <button type="button" onClick={() => { setEntries([]); }} disabled={entries.length === 0}>Clear</button>
            </header>
            {entries.length === 0
              ? (
                <div className="console-empty" data-testid="call-log">
                  <p><code>{chosen.code}</code> {chosen.note}.</p>
                  <ol aria-label="Calls Connect will make">
                    {chosen.preview.map((call) => (
                      <li key={call} data-api={api}>
                        <span className="console-prompt" aria-hidden="true">›</span>
                        <span>{call}</span>
                      </li>
                    ))}
                  </ol>
                  <p>Connect a radio and every call lands here as it is made.</p>
                </div>
              )
              : (
                <ol className="console-log" data-testid="call-log">
                  {entries.map((entry) => (
                    <li key={entry.id} data-api={entry.api}>
                      <span className="console-prompt" aria-hidden="true">›</span>
                      <span>{entry.call}</span>
                    </li>
                  ))}
                </ol>
              )}
          </section>
        </aside>
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
