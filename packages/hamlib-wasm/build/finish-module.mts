// SPDX-License-Identifier: MIT

/**
 * Finish a linked Emscripten module.  The native build imports this and the
 * relink kit runs it after `em++` (`node finish-module.mts <loader> <d.mts>`),
 * so a relinked loader matches the published one.
 *
 * The kit runs it without the repository, so it imports nothing but Node
 * built-ins and must stay erasable TypeScript.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/* Generated Emscripten output must carry the notices a bare copyright line
 * would otherwise lose. */
const LOADER_BANNER = [
  '// SPDX-License-Identifier: MIT',
  '// Emscripten-generated loader. The Emscripten runtime and sysroot',
  '// components are MIT/NCSA-licensed. The WASM binary this loader',
  '// instantiates contains LGPL-2.1-or-later Hamlib; see LICENSE.md and',
  '// THIRD_PARTY_NOTICES.md.',
].join('\n');

const DECLARATION_BANNER = [
  '// SPDX-License-Identifier: MIT',
  '// Emscripten-generated TypeScript declarations for the project-owned',
  '// Embind facade. See THIRD_PARTY_NOTICES.md for toolchain notices.',
].join('\n');

function prependBanner(file: string, banner: string): void {
  const content = readFileSync(file, 'utf8');

  if (!content.startsWith(banner)) {
    writeFileSync(file, `${banner}\n${content}`);
  }
}

/**
 * Emscripten's `ENVIRONMENT=web,node` loader reaches `node:module` through a
 * dynamic import that only runs under Node.  A browser bundler still resolves
 * the literal specifier and warns about externalizing a Node builtin in every
 * application that bundles the package, so the specifier is made opaque to
 * static analysis.  Under Node the import is unchanged at run time.
 */
const NODE_MODULE_IMPORT = 'await import("node:module")';
const OPAQUE_NODE_MODULE_IMPORT =
  'await import(/* @vite-ignore */ /* webpackIgnore: true */ String("node:module"))';

function hideNodeImportFromBundlers(file: string): void {
  const content = readFileSync(file, 'utf8');

  if (content.includes(OPAQUE_NODE_MODULE_IMPORT)) {
    return;
  }

  const occurrences = content.split(NODE_MODULE_IMPORT).length - 1;

  if (occurrences !== 1) {
    throw new Error(
      `expected one \`${NODE_MODULE_IMPORT}\` in ${file}, found ${occurrences}`,
    );
  }

  writeFileSync(file, content.replace(NODE_MODULE_IMPORT, OPAQUE_NODE_MODULE_IMPORT));
}

/** Idempotent, so a repeated build leaves the outputs unchanged. */
export function finishModule(loader: string, declaration: string): void {
  hideNodeImportFromBundlers(loader);
  prependBanner(loader, LOADER_BANNER);
  prependBanner(declaration, DECLARATION_BANNER);
}

const entryPoint = process.argv[1];

if (entryPoint && path.resolve(entryPoint) === fileURLToPath(import.meta.url)) {
  const [loader, declaration] = process.argv.slice(2);

  if (!loader || !declaration) {
    process.stderr.write('usage: node finish-module.mts <loader.mjs> <declarations.d.mts>\n');
    process.exitCode = 2;
  } else {
    finishModule(loader, declaration);
  }
}
