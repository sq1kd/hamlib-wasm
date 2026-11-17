/**
 * Shared Playwright helpers.
 *
 * The fixtures live in ./fixtures/*.ts and are compiled to plain scripts in
 * ./fixtures/generated/ by the fixtures' own tsconfig.json, which the
 * Playwright globalSetup (./fixtures/compile.ts) runs before any spec loads.
 * The compiled text is what gets injected, so nothing transpiles it in the page
 * and no bundler helper can leak into it.
 *
 * These helpers give the specs a typed view of the double's control surface.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';

const CLOCK_SOURCE = readFileSync(
  fileURLToPath(new URL('./fixtures/generated/virtual-clock.js', import.meta.url)),
  'utf8',
);

const RIGS_SOURCE = readFileSync(
  fileURLToPath(new URL('./fixtures/generated/rigs.js', import.meta.url)),
  'utf8',
);

const TRANSPORT_SOURCE = readFileSync(
  fileURLToPath(new URL('./fixtures/generated/fake-serial.js', import.meta.url)),
  'utf8',
);

/* The rig registry has to be installed before the transport reads it, and both
 * are injected as text so nothing transpiles them. */
const FAKE_SERIAL_SOURCE = `${RIGS_SOURCE}\n${TRANSPORT_SOURCE}`;

const TEST_HELPERS_SOURCE = readFileSync(
  fileURLToPath(new URL('./fixtures/generated/helpers.js', import.meta.url)),
  'utf8',
);

export interface FakeSerialOptions {
  baudRate: number;
  dataBits: number;
  stopBits: number;
  parity: string;
  flowControl: string;
}

export interface FakeRigState {
  frequency: number;
  modeDigit: number;
  filterValue: number;
  transmitting: boolean;
  silent: boolean;
}

/**
 * The control surface the injected fixture publishes on `window`.
 *
 * Declared here because the fixture is injected as page content, and every
 * helper checks at runtime that it is actually present.
 */
export interface FakeSerialControl {
  /** The single fake device the fixture exposes. */
  port: SerialPort;
  /** The protocol currently driving the emulator. */
  rigName: string;
  openedOptions: FakeSerialOptions | null;
  openCount: number;
  closeCount: number;
  isOpen: boolean;
  closedWithLockedStreams: boolean;
  failNextOpen: string | null;
  /** True while a held `open()` is parked. */
  openPending: boolean;
  /** Delay applied to every emulator reply, in milliseconds. */
  replyDelayMs: number;
  /** When true, every host write is refused, as a device that rejects commands. */
  failWrites: boolean;
  setSignalsCalls: number;
  outputSignals: Record<string, boolean> | null;
  commands: string[];
  state: FakeRigState;
  /** Switch the emulated radio; only valid while the port is closed. */
  useRig(name: FakeRigName): void;
  removeWebSerial(): void;
  /** Hold the next `open()` until `releaseOpen()`. */
  holdNextOpen: boolean;
  /** Release a parked `open()`. */
  releaseOpen(): void;
  /** Inject bytes into the readable stream without a write. */
  pushRaw(text: string): void;
  /** Fail the readable stream, as a device unplug would. */
  errorReadable(name: string): void;
}

/** The emulated radios the fixture can drive. */
export type FakeRigName =
  | 'kenwood-ts480'
  | 'icom-ic703'
  | 'icom-ic746'
  | 'icom-ic746pro'
  | 'yaesu-ft710'
  | 'yaesu-ft757gx2'
  | 'yaesu-frg100';

/** The virtual clock's control surface, as the specs see it. */
export interface VirtualClockControl {
  now(): number;
  mode: VirtualClockMode;
  pendingTimers(): number;
  advance(ms: number): Promise<void>;
  settle<T>(promise: Promise<T>): Promise<T>;
  until(predicate: () => boolean): Promise<void>;
}

declare global {
  interface Window {
    __fakeSerial: FakeSerialControl;
    __virtualClock: VirtualClockControl;
  }
}

export interface FakeSerialSnapshot {
  rigName: string;
  openedOptions: FakeSerialOptions | null;
  openCount: number;
  closeCount: number;
  isOpen: boolean;
  closedWithLockedStreams: boolean;
  openPending: boolean;
  setSignalsCalls: number;
  outputSignals: Record<string, boolean> | null;
  commands: string[];
  state: FakeRigState;
}

/** How the page's virtual clock moves; see fixtures/virtual-clock.ts. */
export type VirtualClockMode = 'auto' | 'manual';

/**
 * Put the page on virtual time before any page script runs.
 *
 * Every timer and clock the page reads is then virtual: time moves only to the
 * deadline of the timer that fires next, so what a scenario observes never
 * depends on how fast the machine runs it.  `auto` fires the next timer
 * whenever the page has drained; `manual` only when a spec asks
 * ({@link advanceClock}, or `window.__virtualClock` in the page).
 */
export async function installVirtualClock(
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

/** Install the fake Web Serial surface before any page script runs. */
export async function installFakeSerial(page: Page): Promise<void> {
  await page.addInitScript({ content: FAKE_SERIAL_SOURCE });
}

/**
 * Install the in-page assertion helpers.
 *
 * Injected before page scripts like the serial fixture, because the helper
 * reads `window.__hamlibHarness`, which the harness page publishes on load.
 */
export async function installTestHelpers(page: Page): Promise<void> {
  await page.addInitScript({ content: TEST_HELPERS_SOURCE });
}

/** Remove `navigator.serial` so the unavailable path can be exercised. */
export async function removeWebSerial(page: Page): Promise<void> {
  await page.evaluate(() => {
    if (!window.__fakeSerial) {
      throw new Error('the fake Web Serial fixture is not installed');
    }

    window.__fakeSerial.removeWebSerial();
  });
}

/** Select the emulated radio the fixture should answer as. */
export async function useRig(page: Page, name: FakeRigName): Promise<void> {
  await page.evaluate((rigName: string) => {
    if (!window.__fakeSerial) {
      throw new Error('the fake Web Serial fixture is not installed');
    }

    window.__fakeSerial.useRig(rigName as Parameters<
      typeof window.__fakeSerial.useRig
    >[0]);
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
