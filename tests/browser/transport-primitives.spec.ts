/**
 * Transport primitives behind the facade.
 *
 * The published native module is driven directly against the Web Serial
 * double, so the registry, the receive queue, the waiters, the flush and the
 * modem signal mapping are checked without involving a rig protocol.
 */
import { expect, test } from '@playwright/test';

import { installFakeSerial, installTestHelpers, readFakeSerial } from './fixtures';
import type { Captured } from './globals';

const HARNESS_URL = 'http://127.0.0.1:4174/';

interface PrimitiveResults {
  /** Error sentinels published by the transport (see web_serial.h). */
  errors: {
    ok: number;
    inval: number;
    busy: number;
    io: number;
  };
  storedTokenIsPositive: boolean;
  storeRejectsNonPort: number;
  registerUnknownToken: number;
  registerPath: number;
  registerKnownPathAgain: number;
  registerConsumedToken: number;
  openUnregisteredPath: number;
  handle: number;
  secondHandle: number;
  matchesSameOptions: number;
  matchesDifferentOptions: number;
  unregisterWhileOpen: number;
  flush: number;
  waitAfterPush: number;
  waitAfterFlush: number;
  waitTimeout: number;
  setSignals: number;
  lastRts: number;
  lastDtr: number;
  inputSignals: number;
  closeFirst: number;
  closeSecond: number;
  closeUnknown: number;
  unregisterAfterClose: number;
  unregisterTwice: number;
  unregisterUnknownPath: number;
  waitAfterError: number;
}

function expectOk<T>(captured: Captured<T>): T {
  if (!captured.ok) {
    throw new Error(
      `expected success but the page reported ${JSON.stringify(captured.error)}`,
    );
  }

  return captured.value;
}

test.beforeEach(async ({ page }) => {
  await installFakeSerial(page);
  await installTestHelpers(page);
  await page.goto(HARNESS_URL);
});

test('drives the serial registry, queue, flush and signals', async ({ page }) => {
  const captured = await page.evaluate((): Promise<Captured<PrimitiveResults>> => {
    return window.__testHelpers.capture(async () => {
      const module = await window.__hamlibHarness.nativeModule();
      const glue = module.HamlibWs;
      const serial = window.__fakeSerial;
      const port = serial.port;
      const errors = {
        ok: glue.WS_OK,
        inval: glue.WS_ERR_INVAL,
        busy: glue.WS_ERR_BUSY,
        io: glue.WS_ERR_IO,
      };

      /* Registry ------------------------------------------------------- */
      const token = glue.storePort(port);
      const storeRejectsNonPort = glue.storePort(null);
      const registerUnknownToken = glue.registerPort('webserial/unknown', 4242);
      const registerPath = glue.registerPort('webserial/1', token);
      const registerKnownPathAgain = glue.registerPort('webserial/1', glue.storePort(port));
      const registerConsumedToken = glue.registerPort('webserial/3', token);
      const openUnregisteredPath = await glue.openPort('webserial/42', 9600, 8, 1, 0, 0);

      /* Open ----------------------------------------------------------- */
      const handle = await glue.openPort('webserial/1', 9600, 8, 1, 0, 0);
      const matchesSameOptions = glue.matchesOpenOptions(handle, 9600, 8, 1, 0, 0);
      const matchesDifferentOptions = glue.matchesOpenOptions(handle, 19200, 8, 1, 0, 0);

      /* A rig may open its CAT and PTT lines on one physical port. */
      const secondHandle = await glue.openPort('webserial/1', 9600, 8, 1, 0, 0);
      const unregisterWhileOpen = glue.unregisterPort('webserial/1');

      /* Receive queue and flush ---------------------------------------- */
      serial.pushRaw('FA00014074000;');
      const waitAfterPush = await glue.waitReadable(handle, 2000);
      const flush = glue.flush(handle);
      const waitAfterFlush = await glue.waitReadable(handle, 30);
      const waitTimeout = await glue.waitReadable(handle, 30);

      /* Modem signals -------------------------------------------------- */
      const setSignals = await glue.setSignals(handle, 1, 0, -1);
      const lastRts = glue.lastRts(handle);
      const lastDtr = glue.lastDtr(handle);
      const inputSignals = await glue.getSignals(handle);

      /* Close ---------------------------------------------------------- */
      const closeFirst = await glue.closePort(secondHandle);
      const closeUnknown = await glue.closePort(987654);
      const closeSecond = await glue.closePort(handle);
      const unregisterAfterClose = glue.unregisterPort('webserial/1');
      const unregisterTwice = glue.unregisterPort('webserial/1');
      const unregisterUnknownPath = glue.unregisterPort('webserial/never');

      /* An errored stream must report an I/O failure to the reader. */
      const errorToken = glue.storePort(port);
      glue.registerPort('webserial/2', errorToken);

      const errorHandle = await glue.openPort('webserial/2', 9600, 8, 1, 0, 0);
      serial.errorReadable('NetworkError');
      const waitAfterError = await glue.waitReadable(errorHandle, 2000);
      await glue.closePort(errorHandle);
      glue.unregisterPort('webserial/2');

      return {
        errors,
        storedTokenIsPositive: token > 0,
        storeRejectsNonPort,
        registerUnknownToken,
        registerPath,
        registerKnownPathAgain,
        registerConsumedToken,
        openUnregisteredPath,
        handle,
        secondHandle,
        matchesSameOptions,
        matchesDifferentOptions,
        unregisterWhileOpen,
        flush,
        waitAfterPush,
        waitAfterFlush,
        waitTimeout,
        setSignals,
        lastRts,
        lastDtr,
        inputSignals,
        closeFirst,
        closeSecond,
        closeUnknown,
        unregisterAfterClose,
        unregisterTwice,
        unregisterUnknownPath,
        waitAfterError,
      };
    });
  });

  const result = expectOk(captured);
  const { errors } = result;

  expect(result.storedTokenIsPositive).toBe(true);
  /* storePort() refuses anything that is not a SerialPort. */
  expect(result.storeRejectsNonPort).toBe(0);
  expect(result.registerUnknownToken).toBe(errors.inval);
  expect(result.registerPath).toBe(errors.ok);
  expect(result.registerKnownPathAgain).toBe(errors.busy);
  expect(result.registerConsumedToken).toBe(errors.inval);
  expect(result.openUnregisteredPath).toBe(errors.inval);

  /* The handle is opaque, positive and distinct per open. */
  expect(result.handle).toBeGreaterThan(0);
  expect(result.secondHandle).toBeGreaterThan(0);
  expect(result.secondHandle).not.toBe(result.handle);

  expect(result.matchesSameOptions).toBe(1);
  expect(result.matchesDifferentOptions).toBe(0);
  expect(result.unregisterWhileOpen).toBe(errors.busy);

  expect(result.flush).toBe(errors.ok);
  expect(result.waitAfterPush).toBe(1);
  expect(result.waitAfterFlush).toBe(0);
  expect(result.waitTimeout).toBe(0);

  expect(result.setSignals).toBe(errors.ok);
  expect(result.lastRts).toBe(1);
  expect(result.lastDtr).toBe(0);
  /* clearToSend | dataSetReady | dataCarrierDetect */
  expect(result.inputSignals).toBe(0x7);

  expect(result.closeFirst).toBe(errors.ok);
  expect(result.closeSecond).toBe(errors.ok);
  /* Closing an unknown handle is idempotent, not an error. */
  expect(result.closeUnknown).toBe(errors.ok);
  expect(result.unregisterAfterClose).toBe(errors.ok);
  expect(result.unregisterTwice).toBe(errors.ok);
  expect(result.unregisterUnknownPath).toBe(errors.ok);

  expect(result.waitAfterError).toBe(errors.io);

  /* One physical port, opened and closed twice (once per logical path), with
   * no stream lock left behind even though a stream errored. */
  const transport = await readFakeSerial(page);
  expect(transport.openCount).toBe(2);
  expect(transport.closeCount).toBe(2);
  expect(transport.isOpen).toBe(false);
  expect(transport.closedWithLockedStreams).toBe(false);
  expect(transport.setSignalsCalls).toBe(1);
  expect(transport.openedOptions).toEqual({
    baudRate: 9600,
    dataBits: 8,
    stopBits: 1,
    parity: 'none',
    flowControl: 'none',
  });
});
