// SPDX-License-Identifier: MIT

import {
  execFileSync,
  spawn,
  type StdioOptions,
} from 'node:child_process';
import process from 'node:process';

import { assert, fail } from './errors.ts';

export interface RunOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly stdio?: StdioOptions;
  readonly encoding?: BufferEncoding;
}

export function log(scope: string, message: string): void {
  process.stdout.write(`[${scope}] ${message}\n`);
}

export function run(
  scope: string,
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): void {
  try {
    execFileSync(command, args, {
      stdio: options.stdio ?? 'inherit',
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      encoding: options.encoding,
    });
  } catch (error) {
    fail(scope, `${command} failed: ${String(error)}`);
  }
}

export function capture(
  scope: string,
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): string {
  try {
    return execFileSync(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      encoding: options.encoding ?? 'utf8',
      stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    throw new Error(`[${scope}] ${command} failed: ${String(error)}`);
  }
}

export function requireTool(scope: string, tool: string, hint: string): void {
  try {
    execFileSync('which', [tool], { stdio: 'ignore' });
  } catch {
    fail(scope, `${tool} is not available. ${hint}`);
  }
}

export interface ConcurrentCommand {
  readonly scope: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

function prefixLines(scope: string, chunk: Buffer): string {
  return chunk
    .toString()
    .split('\n')
    .filter((line, index, lines) => line.length > 0 || index < lines.length - 1)
    .map((line) => `[${scope}] ${line}\n`)
    .join('');
}

/** Run commands concurrently, wait for all, and fail if any exits non-zero. */
export async function runConcurrent(commands: readonly ConcurrentCommand[]): Promise<void> {
  const results = await Promise.allSettled(commands.map((entry) => new Promise<void>((resolve, reject) => {
    const child = spawn(entry.command, entry.args, {
      cwd: entry.cwd,
      env: { ...process.env, ...entry.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout.on('data', (chunk: Buffer) => {
      process.stdout.write(prefixLines(entry.scope, chunk));
    });
    child.stderr.on('data', (chunk: Buffer) => {
      process.stderr.write(prefixLines(entry.scope, chunk));
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${entry.scope} exited with code ${String(code)}`));
      }
    });
  })));

  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => String(result.reason));

  if (failures.length > 0) {
    throw new Error(failures.join('; '));
  }
}

export function parseFlag(args: readonly string[], flag: string): string | null {
  const index = args.indexOf(flag);
  return index >= 0 ? (args[index + 1] ?? null) : null;
}

export function hasFlag(args: readonly string[], flag: string): boolean {
  return args.includes(flag);
}

export function assertFlag(value: string | null, flag: string): string {
  assert(value, `${flag} requires a value`);
  return value;
}
