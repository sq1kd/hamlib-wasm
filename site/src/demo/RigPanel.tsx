/**
 * The graphical rig: a front panel driven entirely by props.
 *
 * It knows nothing about Hamlib, the backend, or which entry point is in use -
 * that is what makes the easy/native comparison meaningful.
 */
import { useRef, useState } from 'react';
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactElement,
} from 'react';

import type { EasyCapabilities, LevelName, RigState } from 'hamlib-wasm';

/**
 * Common Hamlib mode names.
 *
 * A hard-coded list, deliberately: the catalogue exposes which operations a
 * model implements, but not the `rmode_t` set its backend declares, so a
 * per-model list is not something the library can answer yet.
 */
const MODES: readonly string[] = ['LSB', 'USB', 'CW', 'CW-R', 'AM', 'FM', 'RTTY', 'DATA-USB'];

/** Tuning increments, in Hz. */
const STEPS: readonly number[] = [1, 10, 100, 1000, 10_000, 100_000];

/** Degrees of knob travel that make one step. */
const DEGREES_PER_STEP = 12;

/** Which of Hamlib's own passband helpers to apply. */
export type PassbandKind = 'narrow' | 'normal' | 'wide';

export interface RigPanelProps {
  readonly state: RigState | undefined;
  readonly capabilities: EasyCapabilities;
  readonly connected: boolean;
  readonly busy: boolean;
  readonly onSetFrequency: (hz: number) => void;
  readonly onSetMode: (mode: string) => void;
  readonly onSetPassband: (kind: PassbandKind) => void;
  readonly onSetPtt: (on: boolean) => void;
}

function group(hz: number): string {
  return hz.toLocaleString('en-US');
}

/** A level's unit, as Hamlib reports it. */
function formatLevel(name: LevelName, value: number): string {
  switch (name) {
    case 'STRENGTH':
      return `${value.toFixed(0)} dB`;
    case 'SWR':
      return value.toFixed(1);
    case 'RFPOWER':
    case 'RFPOWER_METER':
      return `${value.toFixed(1)} W`;
    default:
      return value.toFixed(1);
  }
}

/** The tuning knob: drag right to step up, left to step down. */
function TuningKnob(
  { enabled, onTune }: { readonly enabled: boolean; readonly onTune: (steps: number) => void },
): ReactElement {
  const angleRef = useRef(0);
  const dragRef = useRef<{ readonly x: number; readonly start: number } | null>(null);
  const [angle, setAngle] = useState(0);

  const set = (value: number): void => {
    angleRef.current = value;
    setAngle(value);
  };

  const down = (event: ReactPointerEvent<SVGSVGElement>): void => {
    if (!enabled) {
      return;
    }

    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { x: event.clientX, start: angleRef.current };
  };

  const move = (event: ReactPointerEvent<SVGSVGElement>): void => {
    const drag = dragRef.current;

    if (drag === null) {
      return;
    }

    set(drag.start + (event.clientX - drag.x) * 0.8);
  };

  const up = (): void => {
    const drag = dragRef.current;

    dragRef.current = null;

    if (drag === null) {
      return;
    }

    const steps = Math.round((angleRef.current - drag.start) / DEGREES_PER_STEP);

    set(0);

    if (steps !== 0) {
      onTune(steps);
    }
  };

  const keyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (!enabled) {
      return;
    }

    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      onTune(-1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      onTune(1);
    }
  };

  return (
    <div
      className="knob-wrap"
      role="slider"
      tabIndex={enabled ? 0 : -1}
      aria-label="Tuning"
      aria-valuemin={-50}
      aria-valuemax={50}
      aria-valuenow={angle}
      aria-disabled={!enabled}
      onKeyDown={keyDown}
      style={{ cursor: enabled ? 'grab' : 'not-allowed' }}
    >
      <svg
        className="knob"
        data-testid="tuning-knob"
        viewBox="-50 -50 100 100"
        aria-hidden="true"
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
      >
        <circle className="knob-body" r="46" />
        <circle className="knob-rim" r="46" />
        <circle className="knob-cap" r="30" />
        <g transform={`rotate(${String(angle)})`}>
          <rect className="knob-mark" x="-2" y="-44" width="4" height="16" rx="2" />
        </g>
      </svg>
    </div>
  );
}

export function RigPanel(props: RigPanelProps): ReactElement {
  const { state, capabilities, connected, busy } = props;
  const [step, setStep] = useState(1000);
  const [entry, setEntry] = useState('');

  const frequency = state?.frequency;
  const canSetFrequency = connected && !busy && capabilities.setFrequency;
  const canSetMode = connected && !busy && capabilities.setMode;
  /* A relative step needs a frequency to step from; an absolute entry does
   * not, so the two are gated apart. */
  const canTune = canSetFrequency && frequency !== undefined;
  /* PTT is a command, not a toggle of the snapshot: both buttons stay live
   * whatever the last read said, and whatever is pending. */
  const canSetPtt = connected && capabilities.setPtt;

  const tune = (steps: number): void => {
    if (frequency === undefined) {
      return;
    }

    props.onSetFrequency(Math.max(0, frequency + steps * step));
  };

  const submitEntry = (): void => {
    const value = Number(entry.replace(/[^0-9]/g, ''));

    if (Number.isFinite(value) && value > 0) {
      props.onSetFrequency(value);
    }

    setEntry('');
  };

  return (
    <section className="rig" aria-label="Rig">
      <div className="rig-display">
        <div className="rig-frequency">
          <output data-testid="frequency-display">
            {frequency === undefined ? '---.---.---' : group(frequency)}
          </output>
          <span className="rig-unit">Hz</span>
        </div>
        <dl className="rig-readouts">
          <div>
            <dt>Mode</dt>
            <dd data-testid="mode-display">{state?.mode ?? '—'}</dd>
          </div>
          <div>
            <dt>Passband</dt>
            <dd data-testid="passband-display">
              {state?.passband === undefined ? '—' : `${group(state.passband)} Hz`}
            </dd>
          </div>
          <div>
            <dt>PTT</dt>
            <dd data-testid="ptt-state" data-state={state?.ptt ?? 'unknown'}>
              {state?.ptt ?? '—'}
            </dd>
          </div>
          {capabilities.levels.map((name) => {
            const value = state?.levels?.[name];

            return (
              <div key={name}>
                <dt>{name}</dt>
                <dd data-testid={`level-${name}`}>
                  {value === undefined ? '—' : formatLevel(name, value)}
                </dd>
              </div>
            );
          })}
        </dl>
      </div>

      <div className="rig-controls">
        <div className="rig-knob">
          <TuningKnob enabled={canTune} onTune={tune} />
          <div className="rig-step">
            <button
              data-testid="tune-down"
              type="button"
              disabled={!canTune}
              onClick={() => { tune(-1); }}
            >
              −
            </button>
            <select
              aria-label="Tuning step"
              value={String(step)}
              disabled={!canTune}
              onChange={(event) => { setStep(Number(event.target.value)); }}
            >
              {STEPS.map((value) => (
                <option key={value} value={String(value)}>
                  {`${group(value)} Hz`}
                </option>
              ))}
            </select>
            <button
              data-testid="tune-up"
              type="button"
              disabled={!canTune}
              onClick={() => { tune(1); }}
            >
              +
            </button>
          </div>
        </div>

        <div className="rig-entry">
          <label>
            Frequency (Hz)
            <input
              data-testid="frequency-input"
              type="number"
              inputMode="numeric"
              placeholder={frequency === undefined ? 'unchanged' : String(frequency)}
              value={entry}
              disabled={!canSetFrequency}
              onChange={(event) => { setEntry(event.target.value); }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  submitEntry();
                }
              }}
            />
          </label>
          <button
            data-testid="frequency-set"
            type="button"
            disabled={!canSetFrequency || entry === ''}
            onClick={submitEntry}
          >
            Set
          </button>
        </div>

        <fieldset className="rig-modes" aria-label="Mode">
          {MODES.map((mode) => (
            <button
              key={mode}
              data-testid={`mode-${mode}`}
              type="button"
              aria-pressed={state?.mode === mode}
              disabled={!canSetMode}
              onClick={() => { props.onSetMode(mode); }}
            >
              {mode}
            </button>
          ))}
        </fieldset>

        <div className="rig-passband">
          <span className="rig-label">Passband</span>
          {(['narrow', 'normal', 'wide'] as const).map((kind) => (
            <button
              key={kind}
              data-testid={`passband-${kind}`}
              type="button"
              disabled={!canSetMode || state?.mode === undefined}
              onClick={() => { props.onSetPassband(kind); }}
            >
              {kind}
            </button>
          ))}
        </div>

        <div className="rig-ptt">
          <span className="rig-label">Push to talk</span>
          <button
            data-testid="ptt-on"
            type="button"
            disabled={!canSetPtt}
            onClick={() => { props.onSetPtt(true); }}
          >
            TX on
          </button>
          <button
            data-testid="ptt-off"
            type="button"
            disabled={!canSetPtt}
            onClick={() => { props.onSetPtt(false); }}
          >
            TX off
          </button>
        </div>
      </div>
    </section>
  );
}
