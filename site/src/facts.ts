/** Facts the pages and the panels state, each from one source. */

/** The first Firefox release with Web Serial. */
export const FIREFOX_WEB_SERIAL = 151;

/** Where a page can reach a serial port, as a reader would be told. */
export const WEB_SERIAL_BROWSERS = `desktop Chrome, Edge or Firefox ${String(FIREFOX_WEB_SERIAL)}+`;

/** The radios the opt-in hardware suite runs on; see guides/rigs.mdx. */
export const HARDWARE_TESTED = [
  { manufacturer: 'QRP Labs', model: 'QMX+' },
  { manufacturer: 'Yaesu', model: 'FT-710' },
] as const;

/** Bytes the live demo's Hamlib module costs; see integrations/demo-size.ts. */
export const DEMO_DOWNLOAD = __DEMO_DOWNLOAD__;

/** The model catalogue and Hamlib release; see integrations/catalogue.ts. */
export const CATALOGUE = __CATALOGUE__;

export function radioNames(radios: readonly { readonly manufacturer: string; readonly model: string }[]): string[] {
  return radios.map((radio) => `${radio.manufacturer} ${radio.model}`);
}

/** `['a', 'b', 'c']` → `a, b and c`, split so a page can style the items. */
export function listParts(items: readonly string[]): ReturnType<Intl.ListFormat['formatToParts']> {
  return new Intl.ListFormat('en-GB', { type: 'conjunction' }).formatToParts(items);
}
