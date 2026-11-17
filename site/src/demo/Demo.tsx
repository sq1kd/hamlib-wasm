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

import { baudRateCandidates } from 'hamlib-wasm';
import type { HamlibOptions, RigState, SerialPortLike } from 'hamlib-wasm';
import { HamlibProvider, useHamlibContext, useModels } from 'hamlib-wasm/react';

import { DemoLoading } from '../components/DemoLoading';
import { WEB_SERIAL_BROWSERS } from '../facts';
import { detectRate, rememberRate } from '../radio/detect';
import { emulate } from '../radio/emulate';
import { failureMessage } from '../radio/errors';
import { defaultModel } from '../radio/models';
import { PANEL_OPTIONS, POLL_MS } from '../radio/polling';
import { RadioPanel } from '../radio/RadioPanel';
import { simulate } from '../radio/simulate';
import { MODEL_KEY, remember } from '../radio/storage';
import { connectedView, connectingView, sampleView } from '../radio/views';
import { useBackend } from './backend';
import type { Api, Log, LogEntry } from './backend';
import '../radio/radio.css';
import './demo.css';

/* A module constant, as the provider reads its options once.  Hamlib's own
 * lines go only into `diagnostics()`, for the copy button. */
const OPTIONS: HamlibOptions = { ...PANEL_OPTIONS, debug: { level: 'verbose' } };

const LOG_LIMIT = 40;

/* Development only: `?emulate` answers Web Serial with the test suite's TS-480. */
const EMULATED = await emulate();

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
      `useRigState(rig, { pollMs: ${String(POLL_MS.telemetry)} })`,
      `useRigState(rig, { pollMs: ${String(POLL_MS.meter)}, fields: ['levels'] })`,
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

function App(): ReactElement {
  const { hamlib, loading, error: loadError } = useHamlibContext();
  const models = useModels();

  const [api, setApi] = useState<Api>('rig');
  const [entries, setEntries] = useState<readonly Logged[]>([]);
  const [modelId, setModelId] = useState<number | undefined>(undefined);
  const [baud, setBaud] = useState('auto');
  const [trying, setTrying] = useState<number | undefined>(undefined);
  const [detecting, setDetecting] = useState(false);
  const [detectError, setDetectError] = useState<string | undefined>(undefined);
  const [sample, setSample] = useState<RigState | undefined>(undefined);
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');

  const copyDiagnostics = useCallback(() => {
    if (hamlib === undefined) { return; }

    const report = `\`\`\`json\n${JSON.stringify(hamlib.diagnostics(), null, 2)}\n\`\`\``;

    navigator.clipboard.writeText(report).then(
      () => { setCopied('copied'); },
      () => { setCopied('failed'); },
    );
  }, [hamlib]);

  useEffect(() => {
    if (copied === 'idle') { return undefined; }

    const timer = setTimeout(() => { setCopied('idle'); }, 2000);

    return () => { clearTimeout(timer); };
  }, [copied]);

  const log = useCallback<Log>((entry) => {
    setEntries((current) => [{ ...entry, id: Math.random() }, ...current].slice(0, LOG_LIMIT));
  }, []);

  const backend = useBackend(api, log);
  const { rig } = backend;

  useEffect(() => {
    if (modelId === undefined && models.length > 0) {
      setModelId(defaultModel(models, EMULATED)?.id);
    }
  }, [modelId, models]);

  const selected = useMemo(() => models.find((model) => model.id === modelId), [models, modelId]);
  const rates = useMemo(() => (selected === undefined ? [] : baudRateCandidates(selected)), [selected]);
  const connected = rig !== undefined;
  const busy = backend.connecting || detecting;
  const serial = typeof navigator !== 'undefined' && 'serial' in navigator;
  const error = loadError === undefined ? detectError ?? backend.error : failureMessage(loadError);

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
        found = await detectRate(hamlib, selected.id, rates, port, (rate) => {
          setTrying(rate);
          log({ api, call: `detectBaudRate({ modelId: ${String(selected.id)}, rates: [${String(rate)}] })` });
        });
      } catch (cause) {
        setDetectError(failureMessage(cause));
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

  const view = rig !== undefined
    ? connectedView(rig, backend.state)
    : busy
      ? connectingView(trying === undefined ? undefined : `Trying ${String(trying)}`)
      : sampleView(sample);

  const note = (
    <>
      <span data-testid="hamlib-version">{hamlib?.version ?? 'Hamlib unavailable'}</span>
      {', '}
      <span data-testid="web-serial-status" data-state={serial ? 'available' : 'unavailable'}>
        {serial
          ? 'Web Serial available'
          : `Web Serial unavailable: use ${WEB_SERIAL_BROWSERS}`}
      </span>
    </>
  );

  return (
    <div className="hamlib-demo not-content">
      <div className="workspace">
        <RadioPanel
          view={view}
          models={models}
          modelId={modelId}
          baud={baud}
          rates={rates}
          serial={serial}
          locked={hamlib === undefined || busy}
          note={note}
          {...(error === undefined ? {} : { error })}
          {...(connected
            ? {
              controls: {
                capabilities: backend.capabilities,
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
              <button
                type="button"
                data-testid="copy-diagnostics"
                title="Copy a diagnostics report for a GitHub rig report"
                onClick={copyDiagnostics}
                disabled={hamlib === undefined}
              >
                {copied === 'copied' ? 'Copied' : copied === 'failed' ? 'Copy failed' : 'Copy diagnostics'}
              </button>
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
