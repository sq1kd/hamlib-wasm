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
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { assert, runMain } from './errors.ts';
import { log } from './exec.ts';
import { walk } from './files.ts';
import { releaseSourceDir } from './paths.ts';
import { loadUpstream } from './upstream.ts';

const SCOPE = 'audit-backends';

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
  const upstream = loadUpstream();
  const sourceDir = releaseSourceDir(upstream);

  assert(
    existsSync(path.join(sourceDir, 'rigs')),
    'the source tree is missing; run `mise run fetch-native` first',
  );

  const counts: Counts = { thread: [], lineSettings: [], posixIo: [] };
  const relative = (file: string): string => path.relative(sourceDir, file);
  const sources = walk(path.join(sourceDir, 'rigs'))
    .filter((file) => file.endsWith('.c') || file.endsWith('.h'));

  for (const file of sources) {
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

  log(
    SCOPE,
    `${upstream.version}: `
    + `${counts.thread.length} threaded, `
    + `${counts.lineSettings.length} with unwritable line settings, `
    + `${counts.posixIo.length} bypassing the port layer`,
  );
  log(SCOPE, `threaded: ${counts.thread.join(', ')}`);
  log(SCOPE, `unwritable line settings: ${counts.lineSettings.join(', ')}`);

  const unexpected = counts.posixIo.filter((file) => !EXPECTED_POSIX_IO.includes(file));
  const vanished = EXPECTED_POSIX_IO.filter((file) => !counts.posixIo.includes(file));

  assert(
    unexpected.length === 0,
    'these backends now bypass the common port layer:\n'
    + `${unexpected.map((file) => `  - ${file}`).join('\n')}\n`
    + 'The browser transport does not cover them; classify them deliberately.',
  );

  if (vanished.length > 0) {
    log(SCOPE, `note: no longer bypassing the port layer: ${vanished.join(', ')}`);
  }

  log(SCOPE, 'the port layer still covers every other backend');
}

await runMain(SCOPE, main);
