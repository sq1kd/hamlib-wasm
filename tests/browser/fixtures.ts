/**
 * Shared Playwright helpers.
 *
 * The fixtures live in ./fixtures/*.ts and are compiled to plain scripts in
 * ./fixtures/generated/ by the fixtures' own tsconfig.json, which the
 * Playwright globalSetup (./fixtures/compile.ts) runs before any spec loads.
 * The compiled text is what gets injected, so nothing transpiles it in the page
 * and no bundler helper can leak into it.
 *
 * These helpers give the specs a typed view of the double's control surface,
 * and `test` gives a harness spec its page already set up.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test as base } from '@playwright/test';
import type { Page } from '@playwright/test';

const CLOCK_SOURCE = readFileSync(
  fileURLToPath(new URL('./fixtures/generated/virtual-clock.js', import.meta.url)),
  'utf8',
);

const RIGS_SOURCE = readFileSync(
  fileURLToPath(new URL('./fixtures/generated/rigs.js', import.meta.url)),
  'utf8',
);

const PORT_SOURCE = readFileSync(
  fileURLToPath(new URL('./fixtures/generated/fake-port.js', import.meta.url)),
  'utf8',
);

const WEB_SERIAL_SOURCE = readFileSync(
  fileURLToPath(new URL('./fixtures/generated/fake-serial.js', import.meta.url)),
  'utf8',
);

/* The rig registry has to be installed before the port factory reads it, and
 * the factory before the Web Serial surface builds its port; all three are
 * injected as text so nothing transpiles them. */
const FAKE_SERIAL_SOURCE = `${RIGS_SOURCE}\n${PORT_SOURCE}\n${WEB_SERIAL_SOURCE}`;

const TEST_HELPERS_SOURCE = readFileSync(
  fileURLToPath(new URL('./fixtures/generated/helpers.js', import.meta.url)),
  'utf8',
);

/** A serializable copy of what the fake port recorded. */
export type FakeSerialSnapshot = Pick<
  FakePortControl,
  | 'rigName'
  | 'openedOptions'
  | 'openCount'
  | 'closeCount'
  | 'isOpen'
  | 'closedWithLockedStreams'
  | 'openPending'
  | 'setSignalsCalls'
  | 'outputSignals'
  | 'commands'
  | 'state'
>;

/**
 * Put the page on virtual time before any page script runs.
 *
 * Every timer and clock the page reads is then virtual: time moves only to the
 * deadline of the timer that fires next, so what a scenario observes never
 * depends on how fast the machine runs it.  `auto` fires the next timer
 * whenever the page has drained; `manual` only when a spec asks
 * ({@link advanceClock}, or `window.__virtualClock` in the page).
 */
async function installVirtualClock(
  page: Page,
  mode: VirtualClockMode = 'auto',
): Promise<void> {
  await page.addInitScript({
    content: `${CLOCK_SOURCE}\nwindow.__virtualClock.mode = ${JSON.stringify(mode)};`,
  });
}

/** Let `milliseconds` of virtual time pass in the page, firing what is due. */
export async function advanceClock(page: Page, milliseconds: number): Promise<void> {
  await page.evaluate((ms: number) => window.__virtualClock.advance(ms), milliseconds);
}

/** A state of one `data-testid` element, as {@link runClockUntilElement} awaits it. */
export interface ElementCondition {
  testId: string;
  /** The exact text content. */
  text?: string;
  /** A substring of the text content. */
  contains?: string;
  /** The `data-state` attribute. */
  state?: string;
}

/**
 * Fire the page's timers in deadline order until an element reaches a state.
 *
 * For a page whose actions start work the spec holds no promise for - a click
 * on a panel button - this is how a manual clock is run "until the screen
 * shows the outcome": the condition is checked every time the page drains, so
 * time moves exactly as far as the outcome needs and no further.
 */
export async function runClockUntilElement(page: Page, condition: ElementCondition): Promise<void> {
  await page.evaluate((wanted: ElementCondition) => window.__virtualClock.until(() => {
    const element = document.querySelector(`[data-testid="${wanted.testId}"]`);

    if (element === null) { return false; }

    const text = element.textContent ?? '';

    return (wanted.text === undefined || text === wanted.text)
      && (wanted.contains === undefined || text.includes(wanted.contains))
      && (wanted.state === undefined || element.getAttribute('data-state') === wanted.state);
  }), condition);
}

/** Fire the page's timers in deadline order until the emulator's port is closed. */
export async function runClockUntilPortClosed(page: Page): Promise<void> {
  await page.evaluate(() => window.__virtualClock.until(() => !window.__fakeSerial.isOpen));
}

/** Hold the panel's PTT button down with the mouse: the radio keys on the press. */
export async function pressPtt(page: Page): Promise<void> {
  await page.getByTestId('ptt-button').hover();
  await page.mouse.down();
}

/** Let go of a held PTT button: the radio unkeys on the release. */
export async function releasePtt(page: Page): Promise<void> {
  await page.mouse.up();
}

/** Timers and intervals still scheduled in the page. */
export async function pendingTimers(page: Page): Promise<number> {
  return page.evaluate(() => window.__virtualClock.pendingTimers());
}

/**
 * Put the page on the virtual clock and behind the fake Web Serial before any
 * of its scripts runs: what every page a spec drives through the emulator needs.
 */
export async function installSerialDoubles(page: Page, clockMode: VirtualClockMode): Promise<void> {
  await installVirtualClock(page, clockMode);
  await page.addInitScript({ content: FAKE_SERIAL_SOURCE });
}

/** Delete every `serial` accessor: the page's own, and the fake's on `navigator`. */
function deleteWebSerial(): void {
  delete (navigator as { serial?: unknown }).serial;
  delete (Navigator.prototype as { serial?: unknown }).serial;
}

/**
 * Take Web Serial away the way a browser without it lacks it: no `serial`
 * member at all, not one that reads `undefined`.  It applies to the document
 * already loaded and to every later one, so a spec may call it before
 * `page.goto()` or after.  Firefox builds that predate Web Serial already lack
 * the member; deleting it again is harmless.
 */
export async function removeWebSerial(page: Page): Promise<void> {
  await page.addInitScript(deleteWebSerial);
  await page.evaluate(deleteWebSerial);
}

/** Select the emulated radio the fixture should answer as. */
export async function useRig(page: Page, name: FakeRigName): Promise<void> {
  await page.evaluate((rigName: FakeRigName) => {
    if (!window.__fakeSerial) {
      throw new Error('the fake Web Serial fixture is not installed');
    }

    window.__fakeSerial.useRig(rigName);
  }, name);
}

/** Make the emulator stop answering, so Hamlib runs into its timeout. */
export async function setEmulatorSilent(page: Page, silent: boolean): Promise<void> {
  await page.evaluate((value: boolean) => {
    if (!window.__fakeSerial) {
      throw new Error('the fake Web Serial fixture is not installed');
    }

    window.__fakeSerial.state.silent = value;
  }, silent);
}

/** Make the next `SerialPort.open()` reject with the given DOMException name. */
export async function failNextPortOpen(page: Page, name: string): Promise<void> {
  await page.evaluate((domName: string) => {
    if (!window.__fakeSerial) {
      throw new Error('the fake Web Serial fixture is not installed');
    }

    window.__fakeSerial.failNextOpen = domName;
  }, name);
}

/** Park the next `SerialPort.open()` until {@link releasePortOpen} runs. */
export async function holdNextPortOpen(page: Page): Promise<void> {
  await page.evaluate(() => {
    if (!window.__fakeSerial) {
      throw new Error('the fake Web Serial fixture is not installed');
    }

    window.__fakeSerial.holdNextOpen = true;
  });
}

/**
 * Run the page's virtual clock until a held `open()` has actually parked.
 *
 * Whatever Hamlib sleeps through on its way to the port fires in deadline
 * order, and nothing past the moment the open parks.
 */
export async function waitForPortOpenPending(page: Page): Promise<void> {
  await page.evaluate(() => window.__virtualClock.until(() => window.__fakeSerial.openPending));
}

/** Release a parked `open()`, completing it. */
export async function releasePortOpen(page: Page): Promise<void> {
  await page.evaluate(() => {
    if (!window.__fakeSerial) {
      throw new Error('the fake Web Serial fixture is not installed');
    }

    window.__fakeSerial.releaseOpen();
  });
}

/**
 * Delay every emulator reply, so a read stays in flight for the window.
 *
 * The delay is a page timer: on the virtual clock it is an exact span of
 * virtual time, ordered with every other timer.
 */
export async function setReplyDelay(page: Page, milliseconds: number): Promise<void> {
  await page.evaluate((delay: number) => {
    if (!window.__fakeSerial) {
      throw new Error('the fake Web Serial fixture is not installed');
    }

    window.__fakeSerial.replyDelayMs = delay;
  }, milliseconds);
}

/** Deliver every reply in `bytes`-sized pieces, `gapMs` of virtual time apart. */
export async function setReplyFragments(page: Page, bytes: number, gapMs: number): Promise<void> {
  await page.evaluate(([size, gap]: readonly [number, number]) => {
    if (!window.__fakeSerial) {
      throw new Error('the fake Web Serial fixture is not installed');
    }

    window.__fakeSerial.fragmentBytes = size;
    window.__fakeSerial.fragmentGapMs = gap;
  }, [bytes, gapMs] as const);
}

/** Mirror every host write back before the rig's answer, as a CI-V bus does. */
export async function setEcho(page: Page, echo: boolean): Promise<void> {
  await page.evaluate((value: boolean) => {
    if (!window.__fakeSerial) {
      throw new Error('the fake Web Serial fixture is not installed');
    }

    window.__fakeSerial.echo = value;
  }, echo);
}

/**
 * Make the emulator refuse every host write while still answering reads.
 *
 * A command-rejection that leaves telemetry working, so a write failure can be
 * observed without a poll failure racing it for the same error slot.
 */
export async function setWritesFailing(page: Page, failing: boolean): Promise<void> {
  await page.evaluate((value: boolean) => {
    if (!window.__fakeSerial) {
      throw new Error('the fake Web Serial fixture is not installed');
    }

    window.__fakeSerial.failWrites = value;
  }, failing);
}

/** Read a serializable snapshot of the fake transport state. */
export async function readFakeSerial(page: Page): Promise<FakeSerialSnapshot> {
  return page.evaluate(() => {
    const control = window.__fakeSerial;

    if (!control) {
      throw new Error('the fake Web Serial fixture is not installed');
    }

    return {
      rigName: control.rigName,
      openedOptions: control.openedOptions,
      openCount: control.openCount,
      closeCount: control.closeCount,
      isOpen: control.isOpen,
      closedWithLockedStreams: control.closedWithLockedStreams,
      openPending: control.openPending,
      setSignalsCalls: control.setSignalsCalls,
      outputSignals: control.outputSignals,
      commands: [...control.commands],
      state: {
        frequency: control.state.frequency,
        modeDigit: control.state.modeDigit,
        filterValue: control.state.filterValue,
        transmitting: control.state.transmitting,
        silent: control.state.silent,
      },
    };
  });
}

/**
 * The TS-480 line settings the model advertises upstream
 * (`rigs/kenwood/ts480.c`): 8 data bits, 1 stop bit, no parity, no handshake.
 * The baud rate is asserted against the model metadata the page reports.
 */
export const TS480_LINE_SETTINGS = {
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  flowControl: 'none',
} as const;

/**
 * The value of an in-page action that succeeded, or a failure naming the error
 * the page reported.
 */
export function expectOk<T>(captured: Captured<T>): T {
  if (!captured.ok) {
    throw new Error(`expected success but the page reported ${JSON.stringify(captured.error)}`);
  }

  return captured.value;
}

/** The error an in-page action failed with, or a failure naming its value. */
export function expectFailure<T>(captured: Captured<T>): HamlibErrorView {
  if (captured.ok) {
    throw new Error(`expected a failure but the page succeeded: ${JSON.stringify(captured.value)}`);
  }

  return captured.error;
}

export interface HarnessOptions {
  /** How the page's virtual clock moves; `auto` unless a spec says otherwise. */
  clockMode: VirtualClockMode;
  /** The harness page to open, relative to `baseURL`. */
  harnessPath: string;
}

/**
 * Playwright's `test`, with `harnessPage`: the harness page on the virtual
 * clock, with the fake Web Serial and the in-page helpers installed before
 * any of its scripts ran.
 */
export const test = base.extend<HarnessOptions & { harnessPage: Page }>({
  clockMode: ['auto', { option: true }],
  harnessPath: ['/', { option: true }],
  harnessPage: async ({ page, clockMode, harnessPath }, use) => {
    await installSerialDoubles(page, clockMode);
    await page.addInitScript({ content: TEST_HELPERS_SOURCE });
    await page.goto(harnessPath);
    await use(page);
  },
});

export { expect } from '@playwright/test';
