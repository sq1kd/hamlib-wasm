/** What the panel's header and display show in each phase, for both panels. */
import type { Rig, RigState } from 'hamlib-wasm';

import type { PanelView } from './RadioPanel';

/** No radio: made-up readings, and the panel says so. */
export function sampleView(state: RigState | undefined): PanelView {
  return { phase: 'disconnected', sample: true, name: 'No radio connected', meta: 'sample readings', pill: 'Sample', state };
}

/** A connect in flight; the pill says which step it is on. */
export function connectingView(step = 'Connecting'): PanelView {
  return { phase: 'connecting', sample: false, name: 'Connecting', meta: '', pill: step, state: undefined };
}

export function connectedView(rig: Pick<Rig, 'model' | 'baudRate'>, state: RigState | undefined): PanelView {
  return {
    phase: 'connected',
    sample: false,
    name: `${rig.model.manufacturer} ${rig.model.model}`,
    meta: `${String(rig.baudRate)} baud`,
    pill: 'Connected',
    state,
  };
}
