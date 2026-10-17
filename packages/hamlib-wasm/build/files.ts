// SPDX-License-Identifier: MIT

import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { assert } from './errors.ts';

export function sha256File(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** Stable digest of a file's path relative to a root and its bytes. */
export function fileDigest(file: string, root: string): string {
  return createHash('sha256')
    .update(path.relative(root, file))
    .update('\0')
    .update(readFileSync(file))
    .digest('hex');
}

export function walk(dir: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...walk(full));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }

  return files;
}

export function directoryFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(dir, entry.name))
    .sort();
}

export function assertFile(file: string, what: string): void {
  assert(existsSync(file), `${what} is missing: ${file}`);
  assert(statSync(file).size > 0, `${what} is empty: ${file}`);
}

export function readJson<T = Record<string, unknown>>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

export function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
