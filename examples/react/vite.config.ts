import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const PACKAGE_DIR = fileURLToPath(new URL('../../packages/hamlib-wasm/', import.meta.url));

interface LicensingManifest {
  readonly copy: readonly { readonly from: string; readonly to: string }[];
}

/**
 * The deployed site serves the Hamlib WASM, which is a distribution of the
 * library binary, so the notices and corresponding-source materials that ship
 * in the npm package must be available from the site too.  The copy list is
 * generated with the package build.
 */
function hamlibLicensing(): Plugin {
  let outDir = '';

  return {
    name: 'hamlib-licensing',
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const manifestPath = path.join(
        PACKAGE_DIR,
        'dist/third_party/hamlib/PACKAGE-LICENSING.json',
      );

      if (!existsSync(manifestPath)) {
        throw new Error(`missing generated manifest ${manifestPath}; run mise run build-package`);
      }

      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as LicensingManifest;
      const licensingDir = path.join(outDir, 'licensing');

      rmSync(licensingDir, { recursive: true, force: true });

      for (const entry of manifest.copy) {
        const destination = path.join(licensingDir, entry.to);

        mkdirSync(path.dirname(destination), { recursive: true });
        cpSync(path.join(PACKAGE_DIR, entry.from), destination, { recursive: true });
      }
    },
  };
}

export default defineConfig({
  /* Relative asset URLs: the same build works at the repository root and under
   * the `/<repository>/` path GitHub Pages serves a project site from. */
  base: './',
  plugins: [react(), hamlibLicensing()],
  /* hamlib-wasm is a linked workspace package: bundling it would break the
   * `new URL(..., import.meta.url)` wasm lookup, so let Vite serve it as is. */
  optimizeDeps: {
    exclude: ['hamlib-wasm'],
  },
  build: {
    target: 'es2022',
  },
  /* Bind explicitly: `localhost` resolves to ::1 on Node 17+, which makes the
   * documented 127.0.0.1 URL unreachable for tests and users alike. */
  server: {
    host: '127.0.0.1',
    port: 5174,
    strictPort: true,
  },
  preview: {
    host: '127.0.0.1',
    port: 4175,
    strictPort: true,
  },
});
