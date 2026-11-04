#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/**
 * Audit the pinned backends for what a browser cannot provide.
 *
 * The browser transport only covers code that goes through Hamlib's common port
 * layer.  A backend that opens its own device file, drives termios/ioctl
 * directly, needs a worker thread or asks for a line setting Web Serial cannot
 * express behaves differently here, so the sets are recorded and checked
 * instead of being assumed.
 *
 * Categories:
 *   thread        files that start a thread (`pthread_create`)
 *   line-settings files whose capabilities declare XON/XOFF or mark/space
 *                 parity, which `native/web_serial.c` refuses with -RIG_ECONF
 *   posix-io      files that touch the device outside the common layer
 *                 (termios, ioctl, or a bare read/write call)
 *
 * `thread` and `line-settings` feed the runtime classification in
 * `src/browser-support.ts`; they are reported, not asserted.  `posix-io` is
 * asserted against a recorded set: growing it means a backend the transport
 * cannot serve, which should be a deliberate decision.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { releaseSourceDir } from './paths.ts';
import { loadUpstream } from './upstream.ts';

const UPSTREAM = loadUpstream();

const SOURCE_DIR = releaseSourceDir(UPSTREAM);

/**
 * Files that reach the device outside the common port layer in the pinned
 * release.  Investigated: `winradio` is excluded by `--disable-winradio` and
 * the `v4l` files are tuner backends, not rigs, so none of them is compiled
 * into the browser build.
 */
const EXPECTED_POSIX_IO = [
  'rigs/tuner/v4l.c',
  'rigs/tuner/v4l2.c',
  'rigs/winradio/g313-posix.c',
  'rigs/winradio/winradio.c',
];

const POSIX_IO = [
  /\btermios\.h\b/,
  /\btcsetattr\s*\(/,
  /\bioctl\s*\(/,
];

const BARE_IO_EXCEPTIONS = [
  /write_block\s*\(/,
  /read_block\s*\(/,
  /SNPRINTF\s*\(/,
  /snprintf\s*\(/,
  /sprintf\s*\(/,
  /fwrite\s*\(/,
  /fread\s*\(/,
  /write3Bytes\s*\(/,
  /writeByte\s*\(/,
  /writeShort\s*\(/,
  /readByte\s*\(/,
  /readShort\s*\(/,
  /read3Bytes\s*\(/,
  /readSignal\s*\(/,
  /pwrite\s*\(/,
  /pread\s*\(/,
];

interface Counts {
  thread: string[];
  lineSettings: string[];
  posixIo: string[];
}

/** The report sections, in the order they are printed. */
const CATEGORIES = ['thread', 'lineSettings', 'posixIo'] as const;

function walk(directory: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);

    if (entry.isDirectory()) { files.push(...walk(full)); }
    else if (entry.name.endsWith('.c') || entry.name.endsWith('.h')) { files.push(full); }
  }

  return files;
}

/** Comments talk about reading and writing; only code counts. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
}

function looksLikeBareIo(code: string): boolean {
  for (const line of code.split('\n')) {
    if (BARE_IO_EXCEPTIONS.some((pattern) => pattern.test(line))) { continue; }

    if (/(^|[^_a-zA-Z.])(read|write)\s*\(/.test(line)) { return true; }
  }

  return false;
}

function main(): void {
  if (!path.isAbsolute(SOURCE_DIR) || !existsSync(path.join(SOURCE_DIR, 'rigs'))) {
    process.stderr.write('[audit-backends] error: the source tree is missing\n');
    process.exit(1);
  }

  const counts: Counts = { thread: [], lineSettings: [], posixIo: [] };
  const relative = (file: string): string => path.relative(SOURCE_DIR, file);

  for (const file of walk(path.join(SOURCE_DIR, 'rigs'))) {
    let source: string;

    try {
      source = readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    const code = stripComments(source);

    if (/pthread_create\s*\(/.test(code)) { counts.thread.push(relative(file)); }

    if (/RIG_HANDSHAKE_XONXOFF|RIG_PARITY_MARK|RIG_PARITY_SPACE/.test(code)) {
      counts.lineSettings.push(relative(file));
    }

    const touchesDevice = POSIX_IO.some((pattern) => pattern.test(code))
      || looksLikeBareIo(code);

    if (touchesDevice) { counts.posixIo.push(relative(file)); }
  }

  for (const key of CATEGORIES) { counts[key].sort(); }

  process.stdout.write(
    `[audit-backends] ${UPSTREAM.version}: `
    + `${counts.thread.length} threaded, `
    + `${counts.lineSettings.length} with unwritable line settings, `
    + `${counts.posixIo.length} bypassing the port layer\n`,
  );
  process.stdout.write(`[audit-backends] threaded: ${counts.thread.join(', ')}\n`);
  process.stdout.write(
    `[audit-backends] unwritable line settings: ${counts.lineSettings.join(', ')}\n`,
  );

  const unexpected = counts.posixIo.filter((file) => !EXPECTED_POSIX_IO.includes(file));
  const vanished = EXPECTED_POSIX_IO.filter((file) => !counts.posixIo.includes(file));

  if (unexpected.length > 0) {
    process.stderr.write(
      '[audit-backends] error: these backends now bypass the common port layer:\n'
      + `${unexpected.map((file) => `  - ${file}`).join('\n')}\n`
      + 'The browser transport does not cover them; classify them deliberately.\n',
    );
    process.exit(1);
  }

  if (vanished.length > 0) {
    process.stdout.write(
      `[audit-backends] note: no longer bypassing the port layer: ${vanished.join(', ')}\n`,
    );
  }

  process.stdout.write('[audit-backends] the port layer still covers every other backend\n');
}

main();
