/**
 * Node command line example: the same package, without a browser.
 *
 * The documentation site's live demo acquires a port from a page's Web Serial
 * chooser.  A terminal has no chooser, so this entry names the device itself
 * and lets `createHamlib()` select the Node transport, the one this runtime
 * gets.  `hamlib-wasm/node` is imported for `listPorts()`.  Everything above
 * the transport - the model catalogue, the ids `open()` takes, the baud-rate
 * search and `refresh()` - is the package's ordinary API, unchanged by the
 * transport underneath it.
 *
 * Read only: it never writes a frequency, a mode or PTT.  It prints what the
 * rig reports and closes the port again.  Nothing opens a port before the
 * arguments have been accepted, and every exit path after an open closes it.
 *
 * Run with plain Node's type stripping (`node src/main.ts`), like the build
 * scripts in this repository, so this file has to stay erasable (no enums, no
 * namespaces, no parameter properties):
 *
 *   node src/main.ts --list
 *   node src/main.ts --port /dev/tty.usbserial-1410 --model TS-480
 *
 * In an Electron application a renderer is a browser and keeps Web Serial;
 * this entry is what an Electron main process (or any CLI) uses instead.  See
 * README.md.
 */
import process from 'node:process';

import { createHamlib, HamlibError } from 'hamlib-wasm';
import type { Rig, RigModel, RigState } from 'hamlib-wasm';
import { nodeSerialTransport } from 'hamlib-wasm/node';
import type { NodeSerialPortListEntry } from 'hamlib-wasm/node';

/** The model `--port` opens when `--model` is not given. */
const DEFAULT_MODEL = 'TS-480';

const USAGE = [
  'usage: node src/main.ts --list',
  '       node src/main.ts --port <path> [--model <name>] [--baud <rate>]',
  '',
  '  --list            list the serial ports this machine reports',
  '  --port <path>     the device to open, e.g. /dev/tty.usbserial-1410 or COM3',
  '  --model <name>    rig model to open, by `RigModel.model` (default: TS-480)',
  '  --baud <rate>     baud rate; when omitted it is detected before opening',
].join('\n');

/** `--port` and its options: which device to open, and how to reach the rig. */
interface OpenCommand {
  readonly path: string;
  readonly model: string;
  readonly baudRate?: number;
}

/** What the command line asked for, once every argument has been accepted. */
type Command =
  | { readonly kind: 'list' }
  | { readonly kind: 'open'; readonly options: OpenCommand };

/** An argument this program cannot act on.  Reported together with the usage. */
class UsageError extends Error {}

/** The token after a value flag, or a usage error naming the flag that lacks one. */
function argumentAfter(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];

  if (value === undefined) {
    throw new UsageError(`${flag} needs a value`);
  }

  return value;
}

/**
 * Validate `--baud` here, so a rate the transport would refuse surfaces as a
 * usage message rather than half way into an open.
 */
function parseBaudRate(value: string): number {
  const rate = Number(value);

  if (!Number.isInteger(rate) || rate <= 0) {
    throw new UsageError(`--baud needs a positive whole rate, got "${value}"`);
  }

  return rate;
}

/**
 * Accept the arguments or reject the whole command line: a partial parse is
 * never acted on, so a typo cannot open a port with default settings.
 */
function parseArguments(argv: readonly string[]): Command {
  let list = false;
  let path: string | undefined;
  let model = DEFAULT_MODEL;
  let baudRate: number | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] ?? '';

    switch (flag) {
      case '--list':
        list = true;
        break;
      case '--port':
        path = argumentAfter(argv, index, flag);
        index += 1;
        break;
      case '--model':
        model = argumentAfter(argv, index, flag);
        index += 1;
        break;
      case '--baud':
        baudRate = parseBaudRate(argumentAfter(argv, index, flag));
        index += 1;
        break;
      default:
        throw new UsageError(`unknown argument "${flag}"`);
    }
  }

  if (list) {
    if (path !== undefined) {
      throw new UsageError('--list and --port are two different commands; pass one of them');
    }

    return { kind: 'list' };
  }

  if (path === undefined) {
    throw new UsageError('pass --list, or --port <path> to open a rig');
  }

  return { kind: 'open', options: { path, model, baudRate } };
}

/**
 * The catalogue entry `--model` names.
 *
 * Matched on `RigModel.model`, the catalogue's short name, ignoring case.
 */
function findModel(models: readonly RigModel[], name: string): RigModel {
  const wanted = name.toLowerCase();
  const model = models.find((entry) => entry.model.toLowerCase() === wanted);

  if (model === undefined) {
    throw new Error(
      `no rig model matches "${name}"; --model takes a \`RigModel.model\` name, e.g. "TS-480"`,
    );
  }

  return model;
}

/**
 * One line per port: the path to hand to `--port`, then what the entry adds -
 * who makes the device, its serial number and its USB ids.  A field the
 * operating system did not report prints as `-`, so the columns keep their
 * meaning instead of shifting.
 */
function describePort(entry: NodeSerialPortListEntry): string {
  const manufacturer = entry.manufacturer ?? '-';
  const serialNumber = entry.serialNumber ?? '-';
  const usb =
    entry.vendorId === undefined && entry.productId === undefined
      ? '-'
      : `${entry.vendorId ?? '-'}:${entry.productId ?? '-'}`;

  return [entry.path, manufacturer, serialNumber, usb].join('\t');
}

/**
 * One line for the terminal: which model was opened, on which device and at
 * which rate, then what it answered.  A field the model cannot read is absent
 * from the snapshot and absent here - never invented.
 */
function describeState(
  model: RigModel,
  path: string,
  baudRate: number,
  state: RigState,
): string {
  const parts = [`${model.manufacturer} ${model.model}`, path, `${baudRate} baud`];

  if (state.frequency !== undefined) {
    parts.push(`${state.frequency} Hz`);
  }

  if (state.mode !== undefined) {
    parts.push(state.passband === undefined ? state.mode : `${state.mode} ${state.passband}`);
  }

  if (state.ptt !== undefined) {
    parts.push(`ptt ${state.ptt}`);
  }

  return parts.join(' · ');
}

/** `--list`: every port this machine reports, one per line. */
async function listPorts(): Promise<void> {
  const entries = await nodeSerialTransport().listPorts();

  for (const entry of entries) {
    process.stdout.write(`${describePort(entry)}\n`);
  }
}

/**
 * `--port`: open the named device, read it once, print, and close it again.
 *
 * The port is closed on every path out of here, including the failure paths -
 * the closing `finally` runs before the error reaches the terminal.  A rig the
 * package refused to open is already closed by the package itself, so there is
 * nothing to release and the port is left exactly as it was found.
 */
async function openRig(options: OpenCommand): Promise<void> {
  /* No transport passed: `createHamlib()` picks the Node transport itself, since
   * this runtime has no Web Serial.  `hamlib-wasm/node` is here for
   * `listPorts()` below. */
  const hamlib = await createHamlib();
  let rig: Rig | undefined;

  try {
    const model = findModel(hamlib.models, options.model);
    const port = await hamlib.requestPort({ path: options.path });
    const baudRate = options.baudRate ?? (await hamlib.detectBaudRate({ modelId: model.id, port }));

    rig = await hamlib.open({ modelId: model.id, port, baudRate });

    const state = await rig.refresh();
    process.stdout.write(`${describeState(model, options.path, rig.baudRate, state)}\n`);
  } finally {
    try {
      await rig?.close();
    } finally {
      await hamlib.dispose();
    }
  }
}

/**
 * Explain a failure: the operation, the stable code, Hamlib's own text and
 * the underlying cause.  A terminal has no panel to
 * put this in, so it goes to stderr and the exit code carries the outcome.
 */
function reportError(error: unknown): void {
  if (!(error instanceof HamlibError)) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return;
  }

  const lines = [`${error.operation} failed: ${error.message} [${error.code}]`];

  if (error.hamlibCode !== undefined) {
    lines.push(
      error.hamlibMessage === undefined
        ? `hamlib: ${error.hamlibCode}`
        : `hamlib: ${error.hamlibMessage} (${error.hamlibCode})`,
    );
  }

  if (error.cause !== undefined) {
    lines.push(`cause: ${error.cause instanceof Error ? error.cause.message : String(error.cause)}`);
  }

  process.stderr.write(`${lines.join('\n')}\n`);
}

try {
  const command = parseArguments(process.argv.slice(2));

  if (command.kind === 'list') {
    await listPorts();
  } else {
    await openRig(command.options);
  }
} catch (error) {
  if (error instanceof UsageError) {
    process.stderr.write(`${error.message}\n\n${USAGE}\n`);
    process.exitCode = 2;
  } else {
    reportError(error);
    process.exitCode = 1;
  }
}
