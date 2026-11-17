/**
 * `useRigState` against a stubbed rig: the poll it starts must follow the
 * rig's connection, since `useRig` keeps a lost rig published.
 */
import { act } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it } from 'vitest';

import { useRigState } from 'hamlib-wasm/react';
import type { Rig, RigState } from 'hamlib-wasm';

import { newRig, stub } from './fake-hamlib';
import type { StubRig } from './fake-hamlib';

const STATE: RigState = { frequency: 7_074_000, mode: 'USB', passband: 2400, ptt: 'off' };

interface Mounted {
  state(): RigState | undefined;
  render(pollMs: number): Promise<void>;
}

async function mount(rig: StubRig, pollMs: number): Promise<Mounted> {
  let published: RigState | undefined;

  function Probe({ pollMs: interval }: { pollMs: number }): ReactElement {
    published = useRigState(rig as unknown as Rig, { pollMs: interval });
    return <p>state</p>;
  }

  const container = document.createElement('div');

  document.body.append(container);

  const root = createRoot(container);
  const render = async (interval: number): Promise<void> => {
    await act(async () => {
      root.render(<Probe pollMs={interval} />);
    });
  };

  await render(pollMs);

  return { state: () => published, render };
}

describe('useRigState polling', () => {
  beforeEach(() => {
    stub.reset();
    document.body.replaceChildren();
  });

  it('polls a connected rig', async () => {
    const rig = newRig();

    await mount(rig, 1000);

    expect(rig.watches.map((options) => options.intervalMs)).toEqual([1000]);
  });

  it('does not poll a lost rig when its effect runs again, and still follows its state', async () => {
    const rig = newRig();
    const mounted = await mount(rig, 1000);

    rig.lose();
    await mounted.render(500);

    expect(rig.watches).toHaveLength(1);

    act(() => {
      rig.emitState(STATE);
    });

    expect(mounted.state()).toEqual(STATE);
  });

  it('mounts on a rig that is already lost', async () => {
    const rig = newRig();

    rig.lose();
    await mount(rig, 1000);

    expect(rig.watches).toEqual([]);
  });
});
