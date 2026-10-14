/**
 * The rigs this suite knows how to drive, as data.
 *
 * A new rig is a new entry here, never a change to the tests.  A profile names
 * the model in the shipped catalogue, the USB ids `listPorts()` reports for the
 * rig (so its port is found without asking the operator), the line rate its own
 * menu is set to, and the frequency the opt-in write test round-trips.
 *
 * A rig that has never been enumerated on the test machine has no `usb` block:
 * its port then comes from `HAMLIB_WASM_HARDWARE_PORT`.
 */

export interface HardwareDevice {
  /** The `HAMLIB_WASM_HARDWARE_DEVICE` value. */
  readonly id: string;
  /** Printed in the report. */
  readonly label: string;
  /** Catalogue lookup, by the manufacturer and model `hamlib.models` reports. */
  readonly model: { readonly manufacturer: string; readonly model: string };
  /** The USB ids `listPorts()` reports, lower-case hex without `0x`. */
  readonly usb?: { readonly vendorId: string; readonly productId: string };
  /** The rate the rig's own menu is set to; absent means `detectBaudRate()` searches. */
  readonly baudRate?: number;
  /** The frequency the write test round-trips, inside the range the backend declares. */
  readonly writeFrequency: number;
}

export const DEVICES: Readonly<Record<string, HardwareDevice>> = {
  qmx: {
    id: 'qmx',
    label: 'QRP Labs QMX+',
    /* `qrplabs_qmx_caps` in rigs/kenwood/ts480.c: 8N1, no handshake, and it
     * implements `get_freq`, so `rig_open()` verifies the link itself. */
    model: { manufacturer: 'QRPLabs', model: 'QMX' },
    /* Measured on the reference machine: the rig enumerates as one CDC
     * interface and `listPorts()` reports these ids for it. */
    usb: { vendorId: '0483', productId: 'a34c' },
    /* A USB CDC-ACM interface ignores the line rate, so the menu setting cannot
     * make this wrong - fixing it keeps the run one open instead of a scan. */
    baudRate: 9600,
    /* Inside the 4-14 MHz receive list the backend declares. */
    writeFrequency: 7_074_000,
  },
  'ft-710': {
    id: 'ft-710',
    label: 'Yaesu FT-710',
    /* `ft710.c`: 8N1, no handshake, 4800-115200. */
    model: { manufacturer: 'Yaesu', model: 'FT-710' },
    /* No `usb` block and no `baudRate`: the rig has never been enumerated on the
     * test machine and its menu rate is unknown, so the port comes from
     * `HAMLIB_WASM_HARDWARE_PORT` and the rate from `detectBaudRate()`. */
    writeFrequency: 7_074_000,
  },
};
