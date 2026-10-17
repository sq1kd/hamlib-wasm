// SPDX-License-Identifier: MIT

/**
 * Render release-specific licensing documents from the pinned config and the
 * generated provenance data.  The templates live in docs/templates; the
 * rendered files are committed so a normal build is deterministic and a drift
 * check can compare them byte-for-byte.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { assert } from './errors.ts';
import { readJson } from './files.ts';
import {
  LINK_INPUTS_JSON,
  PACKAGE_JSON,
  PACKAGE_NOTICES,
  PACKAGE_REBUILDING,
  REPO_ROOT,
  ROOT_NOTICES,
  SOURCE_JSON,
  TEMPLATES_DIR,
  releaseSourceDirName,
} from './paths.ts';
import { loadUpstream } from './upstream.ts';

export interface RenderOptions {
  readonly check: boolean;
}

export interface RenderResult {
  readonly files: ReadonlyMap<string, string>;
  readonly changed: readonly string[];
}

interface LinkInputsFile {
  readonly included: readonly unknown[];
  readonly linkedLicenses: readonly string[];
}

interface SourceFile {
  readonly emscriptenVersion?: string | null;
  readonly nodeVersion?: string | null;
  readonly patchSha256?: string | null;
}

function render(template: string, values: Record<string, string>, name: string): string {
  let output = template;

  for (const [key, value] of Object.entries(values)) {
    output = output.split(`{{${key}}}`).join(value);
  }

  const unresolved = /\{\{[^}]+\}\}/.exec(output);

  assert(!unresolved, `${name} has unresolved template token ${unresolved?.[0] ?? ''}`);
  return output;
}

function tokenValues(): Record<string, string> {
  const upstream = loadUpstream();
  const source = readJson<SourceFile>(SOURCE_JSON);
  const linkInputs = readJson<LinkInputsFile>(LINK_INPUTS_JSON);
  const manifest = readJson<{ version?: string }>(PACKAGE_JSON);
  const patch = upstream.patches[0];

  assert(patch, 'the release config has no patch');
  assert(manifest.version, 'package.json has no version');

  const emscripten = /(\d+\.\d+\.\d+)/.exec(String(source.emscriptenVersion ?? ''));
  const linked = linkInputs.linkedLicenses.map((license) => `\`${license}\``).join(', ');
  const nodeMajor = process.version.replace(/^v/, '').split('.')[0] ?? 'unknown';

  return {
    HAMLIB_VERSION: upstream.version,
    HAMLIB_SERIES: upstream.series,
    HAMLIB_REPOSITORY: upstream.repository,
    HAMLIB_COMMIT: upstream.commit,
    HAMLIB_TAG_OBJECT: upstream.tagObject,
    HAMLIB_ARCHIVE_NAME: upstream.archive.name,
    HAMLIB_ARCHIVE_URL: upstream.archive.url,
    HAMLIB_ARCHIVE_SHA256: upstream.archive.sha256,
    HAMLIB_PATCH_FILE: patch.file,
    HAMLIB_PATCH_SHA256: String(source.patchSha256 ?? ''),
    HAMLIB_SOURCE_DIR: releaseSourceDirName(upstream),
    PACKAGE_VERSION: manifest.version,
    EMSCRIPTEN_VERSION: emscripten?.[1] ?? 'unknown',
    NODE_MAJOR: nodeMajor,
    LINKED_OBJECT_COUNT: String(linkInputs.included.length),
    LINKED_LICENSE_LIST: linked,
  };
}

function template(name: string): string {
  return readFileSync(path.join(TEMPLATES_DIR, name), 'utf8');
}

function outputPath(name: string): string {
  switch (name) {
    case 'THIRD_PARTY_NOTICES.md.in':
      return ROOT_NOTICES;
    case 'REBUILDING.md.in':
      return PACKAGE_REBUILDING;
    case 'LICENSING_AUDIT.md.in':
      return path.join(REPO_ROOT, 'docs', 'licensing-audit.md');
    case 'LICENSING_REBUILD.md.in':
      return path.join(REPO_ROOT, 'docs', 'licensing-rebuild.md');
    default:
      throw new Error(`unknown licensing template: ${name}`);
  }
}

export function renderLicensingDocs(options: RenderOptions): RenderResult {
  const values = tokenValues();
  const files = new Map<string, string>();
  const changed: string[] = [];

  for (const name of [
    'THIRD_PARTY_NOTICES.md.in',
    'REBUILDING.md.in',
    'LICENSING_AUDIT.md.in',
    'LICENSING_REBUILD.md.in',
  ]) {
    const rendered = render(template(name), values, name);
    const destination = outputPath(name);

    files.set(destination, rendered);

    if (options.check) {
      let existing = '';

      try {
        existing = readFileSync(destination, 'utf8');
      } catch {
        existing = '';
      }

      if (existing !== rendered) {
        changed.push(path.relative(REPO_ROOT, destination));
      }
    } else {
      writeFileSync(destination, rendered);
    }
  }

  if (options.check) {
    assert(
      changed.length === 0,
      `release documents are stale: ${changed.join(', ')}. Run \`mise run build-package\`.`,
    );
  }

  const notices = files.get(ROOT_NOTICES);
  assert(notices, 'the notices renderer produced no output');

  if (options.check) {
    const packaged = readFileSync(PACKAGE_NOTICES, 'utf8');
    assert(
      packaged === notices,
      'packages/hamlib-wasm/THIRD_PARTY_NOTICES.md is not the rendered copy',
    );
  } else {
    writeFileSync(PACKAGE_NOTICES, notices);
  }

  return { files, changed };
}
