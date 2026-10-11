/**
 * The `useEasyRig` connection state machine, against a stubbed package
 * boundary.
 *
 * These are the cases the browser specs cannot order: two attempts whose
 * outcomes arrive in a chosen sequence, and an attempt that settles after the
 * component that started it is gone.  The real hook from the built package runs
 * here; only `createEasy`/`HamlibError` are replaced.
 *
 * A connection is always started *outside* `act`: React's async `act` waits for
 * the work its callback started, and a connection stays pending until the spec
 * settles it.  `flush()` then applies the renders it queued.
 */
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HamlibError, newRig, stub } from './fake-hamlib';
import { flush, renderProbe } from './probe';
import type { ProbeHandle } from './probe';

/* The factory must import the fake rather than close over it: `vi.mock` is
 * hoisted above the imports, so a static reference would not exist yet. */
vi.mock('../../packages/hamlib-web/dist/index.js', async () => import('./fake-hamlib'));

/** Start a connection. It stays pending until the spec settles its attempt. */
function begin(probe: ProbeHandle): Promise<void> {
  return probe.controls.connect().catch(() => undefined);
}

/** Settle an attempt, then let React publish the result. */
async function settle(work: () => void): Promise<void> {
  await act(async () => {
    work();
    await Promise.resolve();
  });
}

describe('useEasyRig connection ownership', () => {
  beforeEach(() => {
    stub.reset();
    document.body.replaceChildren();
  });

  it('publishes the rig the newest attempt opened and closes the older one', async () => {
    const probe = await renderProbe();
    const older = newRig();
    const newer = newRig();

    const first = begin(probe);

    await flush();
    expect(stub.attempts).toHaveLength(1);

    /* The first attempt is at the device by now; the second supersedes it. */
    const second = begin(probe);

    await flush();
    expect(stub.attempts).toHaveLength(2);

    /* The newer attempt settles first, then the older one: the older one must
     * not take the hook back. */
    await settle(() => { stub.attempts[1]?.resolve(newer); });
    expect(probe.published.rig).toBe(newer);
    expect(probe.published.connecting).toBe(false);

    await settle(() => { stub.attempts[0]?.resolve(older); });

    expect(older.closed).toBe(true);
    expect(newer.closed).toBe(false);
    expect(probe.published.rig).toBe(newer);

    await Promise.all([first, second]);
  });

  it('an older attempt cannot clear the current attempt\'s connecting flag', async () => {
    const probe = await renderProbe();

    const first = begin(probe);

    await flush();

    const second = begin(probe);

    await flush();
    expect(stub.attempts).toHaveLength(2);
    expect(probe.published.connecting).toBe(true);

    /* The first attempt settles while the second is still waiting: the flag
     * belongs to the current attempt and must stay set. */
    await settle(() => { stub.attempts[0]?.resolve(); });

    expect(stub.rigs[0]?.closed).toBe(true);
    expect(probe.published.connecting).toBe(true);
    expect(probe.published.rig).toBeUndefined();

    await settle(() => { stub.attempts[1]?.resolve(); });

    expect(probe.published.connecting).toBe(false);
    expect(probe.published.rig).toBe(stub.rigs[1]);

    await Promise.all([first, second]);
  });

  it('an older attempt cannot replace the current attempt\'s error', async () => {
    const probe = await renderProbe();

    const first = begin(probe);

    await flush();

    const second = begin(probe);

    await flush();

    await settle(() => {
      stub.attempts[0]?.reject(new HamlibError('stale attempt', { code: 'HAMLIB_ERROR', operation: 'open' }));
    });

    expect(probe.published.error).toBeUndefined();
    expect(probe.published.connecting).toBe(true);

    await settle(() => {
      stub.attempts[1]?.reject(new HamlibError('current attempt', { code: 'HAMLIB_ERROR', operation: 'open' }));
    });

    expect(probe.published.error?.message).toBe('current attempt');
    expect(probe.published.connecting).toBe(false);

    await Promise.all([first, second]);
  });

  it('disconnect during a pending connect closes what it opened', async () => {
    const probe = await renderProbe();
    const pending = begin(probe);

    await flush();
    expect(stub.attempts).toHaveLength(1);

    const disconnecting = probe.controls.disconnect();

    await flush();
    await settle(() => { stub.attempts[0]?.resolve(); });
    await disconnecting;

    expect(stub.rigs[0]?.closed).toBe(true);
    expect(probe.published.rig).toBeUndefined();
    expect(probe.published.error).toBeUndefined();
    expect(probe.published.connecting).toBe(false);

    await pending;
  });

  it('unmount during a pending connect closes what it opened', async () => {
    const probe = await renderProbe();
    const pending = begin(probe);

    await flush();
    expect(stub.attempts).toHaveLength(1);

    probe.unmount();
    await settle(() => { stub.attempts[0]?.resolve(); });

    expect(stub.rigs[0]?.closed).toBe(true);
    expect(probe.published.rig).toBeUndefined();
    expect(probe.published.error).toBeUndefined();

    await pending;
  });

  it('a StrictMode remount cancels the attempt the discarded pass started', async () => {
    /* The provider is mounted and loaded first, so StrictMode's cleanup and
     * setup both run while a connection attempt can already be in flight -
     * which is what makes a shared liveness flag revive a stale callback. */
    const probe = await renderProbe({ connectOnMount: true, strictAfterLoad: true });

    await flush();

    /* The cleanup invalidated the first pass's connection before it reached
     * the device, so nothing was opened and nothing was published; the module
     * the discarded pass loaded was disposed, and the state it owned did not
     * survive into the surviving pass. */
    expect(stub.attempts).toHaveLength(0);
    expect(stub.rigs).toHaveLength(0);
    expect(stub.disposed).toBe(0);
    expect(probe.published.rig).toBeUndefined();
    expect(probe.published.connecting).toBe(false);
    expect(probe.published.error).toBeUndefined();

    /* The surviving pass is unharmed: it connects normally. */
    const pending = begin(probe);

    await flush();
    expect(stub.attempts).toHaveLength(1);

    await settle(() => { stub.attempts[0]?.resolve(); });

    expect(probe.published.rig).toBe(stub.rigs[0]);
    expect(probe.published.connecting).toBe(false);

    await pending;
  });
});
