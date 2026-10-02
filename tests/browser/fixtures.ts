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
  setSignalsCalls: number;
  outputSignals: Record<string, boolean> | null;
  commands: string[];
  state: FakeRigState;
  /** Switch the emulated radio; only valid while the port is closed. */
  useRig(name: FakeRigName): void;
  removeWebSerial(): void;
  /** Inject bytes into the readable stream without a write. */
  pushRaw(text: string): void;
  /** Fail the readable stream, as a device unplug would. */
  errorReadable(name: string): void;
}

/** The emulated radios the fixture can drive. */
export type FakeRigName = 'kenwood-ts480' | 'icom-ic703' | 'yaesu-ft757gx2';

declare global {
  interface Window {
    __fakeSerial: FakeSerialControl;
  }
}

export interface FakeSerialSnapshot {
  rigName: string;
  openedOptions: FakeSerialOptions | null;
  openCount: number;
  closeCount: number;
  isOpen: boolean;
  closedWithLockedStreams: boolean;
  setSignalsCalls: number;
  outputSignals: Record<string, boolean> | null;
  commands: string[];
  state: FakeRigState;
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
