// SPDX-License-Identifier: MIT

/**
 * The browser transport: ports come from Web Serial.
 *
 * This is the transport a browser gets by default (`src/transport-select.ts`),
 * and the only one a page can use: `navigator.serial.requestPort()` is what a
 * user gesture reaches, and
 * the browser, not the page, decides which devices exist.  A runtime without
 * Web Serial reports itself unsupported instead of throwing from a getter, so
 * the facade can say what is missing before it asks for a port.
 *
 * The port objects it hands out are the browser's own `SerialPort`s: the
 * {@link SerialPortLike} contract in `src/transport.ts` is the shape they
 * already have, so nothing is wrapped here.
 */

import { HamlibError, transportError } from './errors.js';
import type { PortRequest, SerialPortLike, SerialTransport } from './transport.js';

/** `navigator.serial`, when this runtime has one. */
function webSerial(): Serial | undefined {
  if (typeof navigator === 'undefined') { return undefined; }

  return (navigator as Navigator & { serial?: Serial }).serial;
}

/** The default transport: the browser's Web Serial API. */
export function webSerialTransport(): SerialTransport {
  return {
    name: 'Web Serial',

    isSupported(): boolean {
      const serial = webSerial();

      return Boolean(serial && typeof serial.requestPort === 'function');
    },

    async requestPort(request?: PortRequest): Promise<SerialPortLike> {
      /* The request is checked first, so mixing `path` with the browser
       * transport is reported as the caller mistake it is - in every runtime,
       * and not as "Web Serial is unavailable", which would hide it. */
      if (request?.path !== undefined) {
        throw new HamlibError(
          'the Web Serial transport picks the port in the browser; pass `filters`, not `path`',
          { code: 'INVALID_ARGUMENT', operation: 'requestPort' },
        );
      }

      const serial = webSerial();

      if (!serial) {
        throw new HamlibError(
          'Web Serial is not available in this runtime; the Node transport is selected '
          + 'automatically where Node is present, otherwise pass a transport to createHamlib()',
          { code: 'TRANSPORT_UNAVAILABLE', operation: 'requestPort' },
        );
      }

      try {
        return await serial.requestPort(
          request?.filters ? { filters: [...request.filters] } : undefined,
        );
      } catch (error) {
        /* A dismissed chooser or a blocked port is Web Serial's to report. */
        throw transportError(error, 'requestPort');
      }
    },
  };
}
