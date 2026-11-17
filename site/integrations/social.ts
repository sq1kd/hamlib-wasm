/**
 * The link-preview image: what Open Graph and X cards show for every page.
 *
 * `mise run social-image` captures it from the built landing page into
 * `public/`, so it shows the same facts the hero does.
 */
export const SOCIAL_IMAGE = {
  file: 'social.png',
  width: 1280,
  height: 640,
  alt: 'hamlib-wasm: control your radio from a web page',
} as const;
