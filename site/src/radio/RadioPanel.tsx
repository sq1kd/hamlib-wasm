/**
 * The radio panel: one front panel for the landing page and the demo page.
 *
 * Driven entirely by props.  The demo renders it with React and passes the
 * controls; the landing page renders it once, at build time, to plain HTML,
 * and `paint.ts` updates that HTML in place - so the two pages show the same
 * panel, and the landing page ships no React.  The data attributes `paint.ts`
 * looks for are part of this markup's contract.
 */
import { useEffect, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';

import type { RigCapabilities, RigMode, RigState } from 'hamlib-wasm';

import { cellState, keyed, METER_CELLS, meterCells, modeList, passbandLabel, segments, STEPS } from './format';
import { bindPtt } from './ptt';

export type Phase = 'disconnected' | 'connecting' | 'connected';

/** Which of Hamlib's own passband helpers to apply. */
export type PassbandKind = 'narrow' | 'normal' | 'wide';

export interface PanelModel {
  readonly id: number;
  readonly manufacturer: string;
  readonly model: string;
  readonly limitation?: string;
  readonly rateMin: number;
  readonly rateMax: number;
}

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
  readonly busy: boolean;
  readonly onSetFrequency: (hz: number) => void;
  readonly onSetMode: (mode: RigMode) => void;
  readonly onSetPassband: (kind: PassbandKind) => void;
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

const PASSBANDS: readonly PassbandKind[] = ['narrow', 'normal', 'wide'];

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
  const { capabilities, busy } = controls;
  const [step, setStep] = useState(1000);
  const [entry, setEntry] = useState('');

  const frequency = state?.frequency;
  const canSetFrequency = !busy && capabilities.setFrequency;
  const canTune = canSetFrequency && frequency !== undefined;
  const canSetMode = !busy && capabilities.setMode;
  const ptt = useRef<HTMLButtonElement>(null);
  const onSetPtt = useRef(controls.onSetPtt);

  /* Bound once: re-binding on a new callback would release a held key. */
  useEffect(() => { onSetPtt.current = controls.onSetPtt; });
  useEffect(() => (ptt.current === null ? undefined : bindPtt(ptt.current, (on) => { onSetPtt.current(on); })), []);

  const tune = (steps: number): void => {
    if (frequency !== undefined) {
      controls.onSetFrequency(Math.max(0, frequency + steps * step));
    }
  };

  const submit = (): void => {
    const value = Number(entry.replace(/[^0-9]/g, ''));

    if (Number.isFinite(value) && value > 0) {
      controls.onSetFrequency(value);
    }

    setEntry('');
  };

  return (
    <div className="radio-controls" data-radio-controls>
      <span className="radio-label">Tune</span>
      <div className="radio-row">
        <div className="radio-group radio-joined">
          <button data-testid="tune-down" type="button" aria-label="Tune down" disabled={!canTune} onClick={() => { tune(-1); }}>−</button>
          <select aria-label="Tuning step" value={String(step)} disabled={!canTune} onChange={(event) => { setStep(Number(event.target.value)); }}>
            {STEPS.map((value) => <option key={value} value={String(value)}>{`${group(value)} Hz`}</option>)}
          </select>
          <button data-testid="tune-up" type="button" aria-label="Tune up" disabled={!canTune} onClick={() => { tune(1); }}>+</button>
        </div>
        <div className="radio-group radio-joined radio-entry">
          <input
            data-testid="frequency-input"
            aria-label="Frequency in Hz"
            type="number"
            inputMode="numeric"
            placeholder={frequency === undefined ? 'Frequency, Hz' : String(frequency)}
            value={entry}
            disabled={!canSetFrequency}
            onChange={(event) => { setEntry(event.target.value); }}
            onKeyDown={(event) => { if (event.key === 'Enter') { submit(); } }}
          />
          <button data-testid="frequency-set" type="button" disabled={!canSetFrequency || entry === ''} onClick={submit}>Set</button>
        </div>
      </div>

      <span className="radio-label" id="radio-passband-label">Passband</span>
      <div className="radio-row">
        <fieldset className="radio-group radio-joined" aria-labelledby="radio-passband-label">
          {PASSBANDS.map((kind) => (
            <button
              key={kind}
              data-testid={`passband-${kind}`}
              type="button"
              disabled={!canSetMode || state?.mode === undefined}
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
          type="button"
          aria-pressed={keyed(state?.ptt)}
          disabled={busy || !capabilities.setPtt}
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
  const canSetMode = controls !== undefined && !controls.busy && controls.capabilities.setMode;
  const selected = props.models.find((model) => model.id === props.modelId);

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
          <span className="radio-pill" data-testid="connection-state" data-state={view.phase} aria-live="polite">{view.pill}</span>
          {(props.prerender === true || view.phase === 'connected') && (
            <button className="radio-disconnect" data-testid="disconnect-button" type="button" onClick={props.onDisconnect}>
              Disconnect
            </button>
          )}
        </span>
      </header>

      <div className="radio-lcd">
        <div className="radio-freq">
          <span className="radio-seg">
            <span className="radio-ghost" data-radio-ghost aria-hidden="true">{digits.ghost}</span>
            <span className="radio-lit" data-testid="frequency-display">{digits.lit}</span>
          </span>
          <span className="radio-unit">MHz</span>
          <span className="radio-readout">
            <span className="radio-tx" data-testid="ptt-state" data-state={ptt} hidden={!transmitting}>TX</span>
            <span data-testid="mode-display">{state?.mode ?? '—'}</span>
            <span data-testid="passband-display">{passbandLabel(state?.passband)}</span>
          </span>
        </div>
        <fieldset className="radio-modes" aria-label="Mode" data-radio-modes>
          {modeList(state?.mode).map((mode) => (
            <button
              key={mode}
              data-testid={`mode-${mode}`}
              type="button"
              aria-pressed={state?.mode === mode}
              disabled={!canSetMode}
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
                    data-min={model.rateMin}
                    data-max={model.rateMax}
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
          <select data-testid="baud-select" value={props.baud} disabled={props.locked} onChange={(event) => { props.onBaud?.(event.target.value); }}>
            <option value="auto">Auto-detect</option>
            {props.rates.map((rate) => <option key={rate} value={String(rate)}>{rate}</option>)}
          </select>
        </label>
        <button
          className="radio-primary"
          data-testid="connect-button"
          type="button"
          disabled={!props.serial || props.locked || selected?.limitation !== undefined}
          onClick={props.onConnect}
        >
          Connect your radio
        </button>
      </div>

      {(props.prerender === true || selected?.limitation !== undefined) && (
        <p className="radio-limitation" data-testid="model-limitation" hidden={selected?.limitation === undefined}>
          {selected?.limitation === undefined ? '' : `${selected.manufacturer} ${selected.model}: ${selected.limitation}`}
        </p>
      )}
      <p className="radio-note">
        <span data-radio-note>{props.note}</span>
        {props.link !== undefined && <a href={props.link.href}>{props.link.text}</a>}
      </p>
      {(props.prerender === true || props.error !== undefined) && (
        <p className="radio-error" data-testid="error-message" role="alert" hidden={props.error === undefined}>{props.error}</p>
      )}
    </section>
  );
}
