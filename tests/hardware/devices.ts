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

import type { RigMode } from 'hamlib-wasm';

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
  /**
   * A mode in which keying PTT alone puts out a carrier, for a rig whose
   * backend reads a forward-power meter: the transmit test then checks the
   * meter, not only the PTT state.  Absent when PTT alone emits nothing to
   * measure - a data mode waits for audio - or nothing can measure it.
   */
  readonly carrierMode?: RigMode;
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
    /* No carrierMode: the backend reads no power meter for the QMX. */
  },
  'ft-710': {
    id: 'ft-710',
    label: 'Yaesu FT-710',
    /* `ft710.c`: 8N1, no handshake, 4800-115200. */
    model: { manufacturer: 'Yaesu', model: 'FT-710' },
    /* Measured on the reference machine: a CP2105 dual UART, so both of its
     * interfaces report these ids; resolution keeps the one the rig answers
     * on (the first, CAT; the second carries the RTS/DTR keying lines). */
    usb: { vendorId: '10c4', productId: 'ea70' },
    /* The rig's CAT RATE menu, as `detectBaudRate()` found it: fixing it keeps
     * the run one open instead of a scan through the silent rates above it. */
    baudRate: 38_400,
    writeFrequency: 7_074_000,
    /* AM keys a carrier, and `RFPOWER_METER` reads it (measured: 0.05 idle,
     * 0.17 keyed at 10% power). */
    carrierMode: 'AM',
  },
};
