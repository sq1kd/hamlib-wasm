// SPDX-License-Identifier: MIT

// Emits the Markdown that @semantic-release/exec appends to the generated
// release notes.  Only the "Bundled components" block goes to stdout, because
// semantic-release treats stdout as the notes themselves.
//
// This script must never fail a release: provenance is best-effort, so every
// problem is reported on stderr and the block is built from whatever is
// available.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_ROOT = path.join(REPO_ROOT, 'packages', 'hamlib-wasm');
const CONFIG_PATH = path.join(PACKAGE_ROOT, 'hamlib.config.yaml');
const MISE_PATH = path.join(REPO_ROOT, 'mise.toml');

// The build writes provenance next to the packaged third-party tree.  Check
// the package-relative location first, but tolerate a root-level dist for
// callers that copy the package output elsewhere.
const PROVENANCE_PATHS = [
  path.join(PACKAGE_ROOT, 'dist', 'third_party', 'hamlib', 'SOURCE.json'),
  path.join(REPO_ROOT, 'dist', 'third_party', 'hamlib', 'SOURCE.json'),
];

function warn(message) {
  process.stderr.write(`hamlib-release-notes: ${message}\n`);
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function readYamlFile(filePath) {
  return parseYaml(readFileSync(filePath, 'utf8'));
}

/**
 * Reduces the full `emcc --version` banner recorded in SOURCE.json to the
 * release number release notes should show.
 */
function shortEmscriptenVersion(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const match = /\b\d+\.\d+\.\d+\b/.exec(value);
  return match ? match[0] : value;
}

function readProvenance() {
  for (const filePath of PROVENANCE_PATHS) {
    try {
      const source = readJson(filePath);
      return {
        hamlibVersion: source.version,
        hamlibCommit: source.upstreamCommit,
        emscriptenVersion: shortEmscriptenVersion(source.emscriptenVersion),
      };
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        warn(`cannot read ${filePath}: ${error.message}`);
      }
    }
  }
  return undefined;
}

function readConfig() {
  try {
    const config = readYamlFile(CONFIG_PATH);
    return {
      hamlibVersion: config?.release?.version,
      hamlibCommit: config?.release?.commit,
      emscriptenVersion: readPinnedEmscripten(),
    };
  } catch (error) {
    warn(`cannot read ${CONFIG_PATH}: ${error.message}`);
    return undefined;
  }
}

// mise.toml is TOML, not YAML.  Only the pinned emsdk string is needed here,
// so read the [tools] table without taking on a TOML parser dependency.
function readPinnedEmscripten() {
  try {
    const text = readFileSync(MISE_PATH, 'utf8');
    const start = /^\[tools\][^\n]*$/m.exec(text);
    if (!start) return undefined;
    const block = text
      .slice(start.index + start[0].length)
      .split(/^\[/m)[0];
    const match = /^\s*emsdk\s*=\s*["']([^"']+)["']/m.exec(block);
    return match?.[1];
  } catch (error) {
    warn(`cannot read ${MISE_PATH}: ${error.message}`);
    return undefined;
  }
}

function buildBlock() {
  const provenance = readProvenance();
  const needsConfig =
    !provenance ||
    !provenance.hamlibVersion ||
    !provenance.hamlibCommit ||
    !provenance.emscriptenVersion;
  const config = needsConfig ? readConfig() : undefined;

  if (needsConfig && provenance) {
    warn('provenance is incomplete; filling the missing fields from the pinned config');
  } else if (!provenance) {
    warn('build provenance not found; using the pinned config instead');
  }

  const version = provenance?.hamlibVersion ?? config?.hamlibVersion;
  const commit = provenance?.hamlibCommit ?? config?.hamlibCommit;
  const emscripten = provenance?.emscriptenVersion ?? config?.emscriptenVersion;

  const lines = ['## Bundled components', ''];

  if (version) lines.push(`- Hamlib: \`${version}\``);
  if (commit) lines.push(`- Hamlib revision: \`${commit}\``);
  if (emscripten) lines.push(`- Emscripten: \`${emscripten}\``);

  if (lines.length === 2) {
    warn('no bundled component metadata was available');
    lines.push('_Bundled component provenance was unavailable._');
  }

  return `${lines.join('\n')}\n`;
}

try {
  process.stdout.write(buildBlock());
} catch (error) {
  warn(`cannot build the bundled components block: ${error.message}`);
  process.stdout.write(
    '## Bundled components\n\n_Bundled component provenance was unavailable._\n',
  );
}

// Deliberately exit 0: release notes are not a release gate.
process.exitCode = 0;
