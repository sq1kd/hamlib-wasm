/**
 * What loading the live demo costs, measured from the built package.
 *
 * The bulk of the demo is the Hamlib module: `hamlib-wasm.wasm` (~5 MB raw)
 * and its Emscripten glue `hamlib-wasm.mjs` (~150 KB raw).  Both are measured
 * here at config time, gzip level 9 and brotli quality 11 - GitHub Pages
 * serves gzip, a CDN in front of it may serve brotli.  The demo's own React
 * chunk (a few tens of KB compressed) is not included; the loader says
 * "about".
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

export interface DemoDownload {
  /** Uncompressed bytes. */
  readonly raw: number;
  readonly gzip: number;
  readonly brotli: number;
}

export function measureDemoDownload(): DemoDownload {
  const wasm = new URL(import.meta.resolve('hamlib-wasm/native/hamlib-wasm.wasm'));
  /* The package does not export its glue; it sits beside the Wasm. */
  const files = [wasm, new URL('hamlib-wasm.mjs', wasm)];
  let raw = 0;
  let gzip = 0;
  let brotli = 0;

  for (const file of files) {
    const bytes = readFileSync(fileURLToPath(file));

    raw += bytes.length;
    gzip += gzipSync(bytes, { level: 9 }).length;
    brotli += brotliCompressSync(bytes, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length },
    }).length;
  }

  return { raw, gzip, brotli };
}
