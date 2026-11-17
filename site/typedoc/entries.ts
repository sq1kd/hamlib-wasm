/**
 * The package's entry points, read from its `exports`: every subpath with
 * types is one documented module, named after the specifier a consumer
 * imports and built from the source file its declarations come from.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

interface PackageJson {
  readonly name: string;
  readonly exports: Readonly<Record<string, string | { readonly types?: string }>>;
}

const PACKAGE_DIR = new URL('../../packages/hamlib-wasm/', import.meta.url);

const manifest = JSON.parse(readFileSync(new URL('package.json', PACKAGE_DIR), 'utf8')) as PackageJson;

export interface Entry {
  /** What a consumer imports, e.g. `hamlib-wasm/raw`. */
  readonly specifier: string;
  /** The source file's name without its extension, which TypeDoc names the module after. */
  readonly module: string;
  readonly source: string;
}

export const ENTRIES: readonly Entry[] = Object.entries(manifest.exports).flatMap(([subpath, target]) => {
  const types = typeof target === 'string' ? undefined : target.types;
  const module = types === undefined ? undefined : /^\.\/dist\/(.+)\.d\.ts$/.exec(types)?.[1];

  return module === undefined
    ? []
    : [{
      specifier: subpath === '.' ? manifest.name : `${manifest.name}/${subpath.slice(2)}`,
      module,
      source: fileURLToPath(new URL(`src/${module}.ts`, PACKAGE_DIR)),
    }];
});

export const TSCONFIG = fileURLToPath(new URL('tsconfig.json', PACKAGE_DIR));
