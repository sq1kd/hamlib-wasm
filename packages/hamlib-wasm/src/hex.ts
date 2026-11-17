// SPDX-License-Identifier: MIT

/** Hex as this package writes it: lower case, two digits a byte, four a USB id. */

export function bytesToHex(bytes: Uint8Array): string {
  let hex = '';

  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }

  return hex;
}

export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);

  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }

  return bytes;
}

export function formatUsbId(id: number): string {
  return id.toString(16).padStart(4, '0');
}

/** A USB id as `serialport` lists it; anything that is not one is `undefined`. */
export function parseUsbId(hex: string | undefined): number | undefined {
  return hex !== undefined && /^[0-9a-f]{1,4}$/i.test(hex) ? Number.parseInt(hex, 16) : undefined;
}
