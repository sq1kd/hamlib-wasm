/**
 * Serve the package's licensing materials next to the Wasm the site deploys.
 *
 * The live demo ships `hamlib-wasm.wasm`, which embeds LGPL-2.1-or-later
 * Hamlib.  Deploying it is a distribution of the library binary, so the same
 * notices and corresponding-source kit that ship in the npm package must be
 * available from the site.  The copy list is the one the package build
 * generates (`PACKAGE-LICENSING.json`), so the site never drifts from it.
 *
 * Output: `<outDir>/licensing/` (LICENSE.md, THIRD_PARTY_NOTICES.md,
 * REBUILDING.md, LICENSES/, third_party/hamlib/... including
 * corresponding-source.tar.gz).
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AstroIntegration } from 'astro';

interface CopyEntry {
  readonly from: string;
  readonly to: string;
  readonly recursive?: boolean;
}

const manifestUrl = new URL(import.meta.resolve('hamlib-wasm/third_party/hamlib/PACKAGE-LICENSING.json'));
const manifestPath = fileURLToPath(manifestUrl);
/* The manifest's paths are relative to the package root, which the package
 * does not export: three levels up from dist/third_party/hamlib/. */
const packageDir = fileURLToPath(new URL('../../../', manifestUrl));

export function hamlibLicensing(): AstroIntegration {
  return {
    name: 'hamlib-wasm-licensing',
    hooks: {
      'astro:build:done': ({ dir, logger }) => {
        if (!existsSync(manifestPath)) {
          throw new Error(
            `missing ${manifestPath}: build the package first (mise run build-package)`,
          );
        }

        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { copy: CopyEntry[] };
        const licensingDir = path.join(fileURLToPath(dir), 'licensing');

        rmSync(licensingDir, { recursive: true, force: true });

        for (const entry of manifest.copy) {
          const source = path.join(packageDir, entry.from);
          const destination = path.join(licensingDir, entry.to);

          mkdirSync(path.dirname(destination), { recursive: true });

          if (entry.recursive === true) {
            cpSync(source, destination, { recursive: true });
          } else {
            copyFileSync(source, destination);
          }
        }

        logger.info(`copied ${String(manifest.copy.length)} licensing entries to licensing/`);
      },
    },
  };
}
