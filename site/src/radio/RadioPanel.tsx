/**
 * The radio panel: one front panel for the landing page and the demo page.
 *
 * Driven entirely by props.  The demo renders it with React and passes the
 * controls; the landing page renders it once, at build time, to plain HTML,
 * and `paint.ts` updates that HTML in place - so the two pages show the same
 * panel, and the landing page ships no React.  The `data-radio-*` attributes
 * (and `data-mode`, `data-tune`, `data-passband`) are the contract the
 * landing page's scripts find their elements by; test ids are for tests only.
 */
import { useEffect, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';

import type { PassbandSelector, RigCapabilities, RigMode, RigState } from 'hamlib-wasm';

import {
  cellState,
  controlStates,
  entryPlaceholder,
  keyed,
  limitationText,
  METER_CELLS,
  meterCells,
  modeList,
  NO_CAPABILITIES,
  parseFrequency,
  PASSBANDS,
  passbandLabel,
  segments,
  STEPS,
  tuned,
} from './format';
import type { PanelModel } from './models';
import { bindPtt } from './ptt';

export type Phase = 'disconnected' | 'connecting' | 'connected';

/** What the header and display show. */
export interface PanelView {
  readonly phase: Phase;
  /** The readings are made up: no radio is connected. */
  readonly sample: boolean;
  readonly name: string;
  readonly meta: string;
  readonly pill: string;
  readonly state: RigState | undefined;
}

/** The write controls, shown once a radio is connected. */
export interface PanelControls {
  readonly capabilities: RigCapabilities;
  readonly onSetFrequency: (hz: number) => void;
  readonly onSetMode: (mode: RigMode) => void;
  readonly onSetPassband: (kind: PassbandSelector) => void;
  /** Held: `true` on press, `false` on release. */
  readonly onSetPtt: (on: boolean) => void;
}

export interface RadioPanelProps {
  readonly view: PanelView;
  readonly models: readonly PanelModel[];
  readonly modelId: number | undefined;
  readonly baud: string;
  readonly rates: readonly number[];
  /** The browser has Web Serial; without it Connect stays disabled. */
  readonly serial: boolean;
  /** Setup is locked: loading, or a connect in flight. */
  readonly locked: boolean;
  readonly controls?: PanelControls;
  readonly note: ReactNode;
  /** A link beside the note; plain data, so a build-time render can pass it. */
  readonly link?: { readonly href: string; readonly text: string };
  readonly error?: string;
  readonly onModel?: (id: number) => void;
  readonly onBaud?: (baud: string) => void;
  readonly onConnect?: () => void;
  readonly onDisconnect?: () => void;
  /**
   * Render every optional element, hidden: for the landing page's static HTML,
   * which `paint.ts` then shows and hides.  React renders them only when due.
   */
  readonly prerender?: boolean;
}

const CELLS: readonly number[] = Array.from({ length: METER_CELLS }, (_, cell) => cell);

function group(hz: number): string {
  return hz.toLocaleString('en-US');
}

function byManufacturer(models: readonly PanelModel[]): [string, PanelModel[]][] {
  const groups = new Map<string, PanelModel[]>();

  for (const model of models) {
    groups.set(model.manufacturer, [...(groups.get(model.manufacturer) ?? []), model]);
  }

  return [...groups.entries()];
}

interface ControlsProps {
  readonly controls: PanelControls;
  readonly state: RigState | undefined;
}

function Controls({ controls, state }: ControlsProps): ReactElement {
  const [step, setStep] = useState(1000);
  const [entry, setEntry] = useState('');

  const frequency = state?.frequency;
  const can = controlStates(controls.capabilities, state, entry);
  const ptt = useRef<HTMLButtonElement>(null);
  const onSetPtt = useRef(controls.onSetPtt);

  /* Bound once: re-binding on a new callback would release a held key. */
  useEffect(() => { onSetPtt.current = controls.onSetPtt; });
  useEffect(() => (ptt.current === null ? undefined : bindPtt(ptt.current, (on) => { onSetPtt.current(on); })), []);

  const tune = (steps: number): void => {
    if (frequency !== undefined) {
      controls.onSetFrequency(tuned(frequency, steps, step));
    }
  };

  const submit = (): void => {
    const hz = parseFrequency(entry);

    if (hz !== undefined) {
      controls.onSetFrequency(hz);
    }

    setEntry('');
  };

  return (
    <div className="radio-controls" data-radio-controls>
      <span className="radio-label">Tune</span>
      <div className="radio-row">
        <div className="radio-group radio-joined">
          <button data-testid="tune-down" data-tune="-1" type="button" aria-label="Tune down" disabled={!can.tune} onClick={() => { tune(-1); }}>−</button>
          <select data-radio-step aria-label="Tuning step" value={String(step)} disabled={!can.tune} onChange={(event) => { setStep(Number(event.target.value)); }}>
            {STEPS.map((value) => <option key={value} value={String(value)}>{`${group(value)} Hz`}</option>)}
          </select>
          <button data-testid="tune-up" data-tune="1" type="button" aria-label="Tune up" disabled={!can.tune} onClick={() => { tune(1); }}>+</button>
        </div>
        <div className="radio-group radio-joined radio-entry">
          <input
            data-testid="frequency-input"
            data-radio-entry
            aria-label="Frequency in Hz"
            type="number"
            inputMode="numeric"
            placeholder={entryPlaceholder(frequency)}
            value={entry}
            disabled={!can.entry}
            onChange={(event) => { setEntry(event.target.value); }}
            onKeyDown={(event) => { if (event.key === 'Enter') { submit(); } }}
          />
          <button data-testid="frequency-set" data-radio-set type="button" disabled={!can.set} onClick={submit}>Set</button>
        </div>
      </div>

      <span className="radio-label" id="radio-passband-label">Passband</span>
      <div className="radio-row">
        <fieldset className="radio-group radio-joined" aria-labelledby="radio-passband-label">
          {PASSBANDS.map((kind) => (
            <button
              key={kind}
              data-testid={`passband-${kind}`}
              data-passband={kind}
              type="button"
              disabled={!can.passband}
              onClick={() => { controls.onSetPassband(kind); }}
            >
              {kind}
            </button>
          ))}
        </fieldset>
        <button
          ref={ptt}
          className="radio-ptt"
          data-testid="ptt-button"
          data-radio-ptt
          type="button"
          aria-pressed={keyed(state?.ptt)}
          disabled={!can.ptt}
        >
          PTT
        </button>
      </div>
    </div>
  );
}

export function RadioPanel(props: RadioPanelProps): ReactElement {
  const { view, controls } = props;
  const { state } = view;
  const digits = segments(state?.frequency);
  const lit = meterCells(state?.levels?.STRENGTH);
  const ptt = state?.ptt ?? 'unknown';
  const transmitting = keyed(ptt);
  const can = controlStates(controls?.capabilities ?? NO_CAPABILITIES, state);
  const selected = props.models.find((model) => model.id === props.modelId);
  const limitation = limitationText(selected);

  return (
    <section
      className="radio not-content"
      data-radio
      data-state={view.phase}
      data-sample={view.sample ? '' : undefined}
      aria-label="Radio"
    >
      <header className="radio-head">
        <span className="radio-name" data-radio-name>{view.name}</span>
        <span className="radio-meta" data-radio-meta>{view.meta}</span>
        <span className="radio-status">
          <span className="radio-pill" data-testid="connection-state" data-radio-pill data-state={view.phase} aria-live="polite">{view.pill}</span>
          {(props.prerender === true || view.phase === 'connected') && (
            <button className="radio-disconnect" data-testid="disconnect-button" data-radio-disconnect type="button" onClick={props.onDisconnect}>
              Disconnect
            </button>
          )}
        </span>
      </header>

      <div className="radio-lcd">
        <div className="radio-freq">
          <span className="radio-seg">
            <span className="radio-ghost" data-radio-ghost aria-hidden="true">{digits.ghost}</span>
            <span className="radio-lit" data-testid="frequency-display" data-radio-frequency>{digits.lit}</span>
          </span>
          <span className="radio-unit">MHz</span>
          <span className="radio-readout">
            <span className="radio-tx" data-testid="ptt-state" data-radio-tx data-state={ptt} hidden={!transmitting}>TX</span>
            <span className="radio-mode" data-testid="mode-display" data-radio-mode>{state?.mode ?? '—'}</span>
            <span data-testid="passband-display" data-radio-passband>{passbandLabel(state?.passband)}</span>
          </span>
        </div>
        <fieldset className="radio-modes" aria-label="Mode" data-radio-modes>
          {modeList(state?.mode).map((mode) => (
            <button
              key={mode}
              data-testid={`mode-${mode}`}
              data-mode={mode}
              type="button"
              aria-pressed={state?.mode === mode}
              disabled={!can.mode}
              onClick={() => { controls?.onSetMode(mode); }}
            >
              {mode}
            </button>
          ))}
        </fieldset>
        <div className="radio-meter" data-radio-meter aria-hidden="true">
          {CELLS.map((cell) => <i key={cell} data-on={cellState(cell, lit)} />)}
        </div>
        <div className="radio-scale" aria-hidden="true">
          <span>S1</span><span>3</span><span>5</span><span>7</span><span>9</span><span>+20</span><span>+40</span><span>+60</span>
        </div>
      </div>

      {controls !== undefined && (props.prerender === true || view.phase === 'connected') && (
        <Controls controls={controls} state={state} />
      )}

      <div className="radio-setup">
        <label className="radio-field radio-model">
          <span>Model</span>
          <select
            data-testid="model-select"
            data-radio-model
            value={props.modelId === undefined ? '' : String(props.modelId)}
            disabled={props.locked}
            onChange={(event) => { props.onModel?.(Number(event.target.value)); }}
          >
            {props.models.length === 0 && <option value="">Loading models…</option>}
            {byManufacturer(props.models).map(([manufacturer, models]) => (
              <optgroup key={manufacturer} label={manufacturer}>
                {models.map((model) => (
                  <option
                    key={model.id}
                    value={String(model.id)}
                    data-model={model.model}
                    data-rates={model.rates?.join(' ')}
                    data-limitation={model.limitation}
                  >
                    {`${manufacturer} ${model.model}`}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        <label className="radio-field radio-baud">
          <span>Baud</span>
          <select data-testid="baud-select" data-radio-baud value={props.baud} disabled={props.locked} onChange={(event) => { props.onBaud?.(event.target.value); }}>
            <option value="auto">Auto-detect</option>
            {props.rates.map((rate) => <option key={rate} value={String(rate)}>{rate}</option>)}
          </select>
        </label>
        <button
          className="hw-primary"
          data-testid="connect-button"
          data-radio-connect
          type="button"
          disabled={!props.serial || props.locked || limitation !== undefined}
          onClick={props.onConnect}
        >
          Connect your radio
        </button>
      </div>

      {(props.prerender === true || limitation !== undefined) && (
        <p className="radio-limitation" data-testid="model-limitation" data-radio-limitation hidden={limitation === undefined}>
          {limitation ?? ''}
        </p>
      )}
      <p className="radio-note">
        <span data-radio-note>{props.note}</span>
        {props.link !== undefined && <a href={props.link.href}>{props.link.text}</a>}
      </p>
      {(props.prerender === true || props.error !== undefined) && (
        <p className="radio-error" data-testid="error-message" data-radio-error role="alert" hidden={props.error === undefined}>{props.error}</p>
      )}
    </section>
  );
}
