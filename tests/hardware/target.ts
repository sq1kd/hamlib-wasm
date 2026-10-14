/**
 * Which rig to drive: the environment's selection, and the resolution that
 * turns a profile into a port the rig demonstrably answers on.
 *
 * The suite is opt-in and the machine's rigs are not, so selection is data
 * driven - the variables say what to drive, `devices.ts` says where to look,
 * and the shipped catalogue says which model id to open.  Resolution is the one
 * step that must touch the rig: a path is not proof that a backend answers on
 * it, so every candidate port is opened and the rig's own reply to `rig_open()`
 * decides, the first that answers being kept.  A QMX+ can enumerate more than
 * one CDC interface and a wrong one must not read as a code defect, so every
 * attempt is remembered and a run that finds nothing reports all of them.
 *
 * Nothing here writes to a rig.  The frequency round-trip in `write.test.ts` is
 * the only writing call in this project, and only when asked for.
 */
import { createHamlib } from 'hamlib-wasm/hamlib';
import type { Hamlib, RigModel } from 'hamlib-wasm/hamlib';
import type { NodeSerialTransport } from 'hamlib-wasm/node';

import { DEVICES } from './devices.js';
import type { HardwareDevice } from './devices.js';

/** The process environment, as this module reads it. */
type Environment = Readonly<Record<string, string | undefined>>;

const DEVICE_VARIABLE = 'HAMLIB_WASM_HARDWARE_DEVICE';
const PORT_VARIABLE = 'HAMLIB_WASM_HARDWARE_PORT';
const BAUD_VARIABLE = 'HAMLIB_WASM_HARDWARE_BAUD';
const WRITE_VARIABLE = 'HAMLIB_WASM_HARDWARE_WRITE';

/** What the environment selects.  `none` is what makes the suite skip. */
export type HardwareSelection =
  | { readonly kind: 'none' }
  | { readonly kind: 'invalid'; readonly reason: string }
  | { readonly kind: 'device'; readonly device: HardwareDevice };

/** The rig a run resolved to, with the evidence that it answered. */
export interface HardwareTarget {
  readonly device: HardwareDevice;
  /** The catalogue entry the profile named. */
  readonly model: RigModel;
  /** The port the rig answered on. */
  readonly path: string;
  /** The rate it answered at, to be handed to `open()` unchanged. */
  readonly baudRate: number;
  /** Every attempt, in order; the last one is the attempt that answered. */
  readonly tried: readonly string[];
}

/**
 * Read the selection out of the environment.
 *
 * Neither variable set is a normal outcome - the task is safe to run anywhere -
 * and the caller skips on it.  Anything else is a mistake in the invocation, so
 * it fails with the ids that would work rather than quietly skipping.
 */
export function selectDevice(env: Environment = process.env): HardwareSelection {
  const id = (env[DEVICE_VARIABLE] ?? '').trim();
  const path = (env[PORT_VARIABLE] ?? '').trim();
  const ids = Object.keys(DEVICES).join(', ');

  if (id === '' && path === '') {
    return { kind: 'none' };
  }

  if (id === '') {
    return {
      kind: 'invalid',
      reason: `${PORT_VARIABLE} names a port, but the model comes from a profile: `
        + `set ${DEVICE_VARIABLE} to one of ${ids}`,
    };
  }

  const device = DEVICES[id];

  if (!device) {
    return { kind: 'invalid', reason: `unknown ${DEVICE_VARIABLE} "${id}"; known ids: ${ids}` };
  }

  return { kind: 'device', device };
}

/** True when the environment asks for the frequency round-trip. */
export function writesEnabled(env: Environment = process.env): boolean {
  return (env[WRITE_VARIABLE] ?? '').trim() === '1';
}

/**
 * The profile to drive, or a failure that says what to pass instead.
 *
 * Kept apart from {@link selectDevice} so a suite can skip on "nothing asked
 * for" while still failing, with the ids that would work, on a bad invocation.
 */
export function requireDevice(selection: HardwareSelection): HardwareDevice {
  if (selection.kind === 'device') {
    return selection.device;
  }

  throw new Error(
    selection.kind === 'invalid' ? selection.reason : 'no hardware rig is selected',
  );
}

/**
 * Find the model, the port and the rate, and leave nothing open behind it.
 *
 * The trial opens prove the whole chain - the transport, the `serialport`
 * addon, the rig's own driver - before a test asserts anything about the rig.
 */
export async function resolveTarget(
  transport: NodeSerialTransport,
  device: HardwareDevice,
  env: Environment = process.env,
): Promise<HardwareTarget> {
  const hamlib = await createHamlib({ transport });

  try {
    const target = await probeForAnswer(hamlib, transport, device, env);

    await hamlib.dispose();
    return target;
  } catch (error) {
    /* The message the operator needs lists the paths and rates that were tried;
     * a leftover registration is a second, smaller problem and must not replace
     * it.  Either way the port is released for the next attempt. */
    await hamlib.dispose().catch(() => undefined);
    throw error;
  }
}

async function probeForAnswer(
  hamlib: Hamlib,
  transport: NodeSerialTransport,
  device: HardwareDevice,
  env: Environment,
): Promise<HardwareTarget> {
  const model = catalogueModel(hamlib.models, device);
  const candidates = await candidatePorts(transport, device, env);
  const requested = (env[BAUD_VARIABLE] ?? '').trim();
  const fixedRate = requested === '' ? device.baudRate : Number(requested);

  if (fixedRate !== undefined && (!Number.isInteger(fixedRate) || fixedRate <= 0)) {
    throw new Error(`${BAUD_VARIABLE} must be a positive whole number of baud, got "${requested}"`);
  }

  const tried: string[] = [];

  for (const path of candidates) {
    const port = await transport.requestPort({ path });
    let baudRate = fixedRate;

    try {
      /* The rate a rig answers at is not on the port: with none configured the
       * search runs first, exactly as the browser examples do. */
      baudRate ??= await hamlib.detectBaudRate({ modelId: model.id, port });

      const rig = await hamlib.open({ modelId: model.id, port, baudRate });

      await rig.close();
      tried.push(`${path} at ${String(baudRate)} baud: opened`);
      return { device, model, path, baudRate, tried };
    } catch (error) {
      const rate = baudRate === undefined ? 'an unknown rate' : `${String(baudRate)} baud`;
      const note = error instanceof Error ? error.message : String(error);

      tried.push(`${path} at ${rate}: ${note}`);
    }
  }

  throw new Error(
    `no ${device.label} answered.  Every attempt, in order:\n  ${tried.join('\n  ')}\n`
    + 'The rig and its port are the operator\'s to fix (another application holding it, a '
    + 'renamed /dev/cu.* node, the menu rate); the profiles are data, in tests/hardware/devices.ts.',
  );
}

/** The profile's model, looked up the way `hamlib.models` reports it. */
function catalogueModel(models: readonly RigModel[], device: HardwareDevice): RigModel {
  const model = models.find(
    (candidate) => candidate.manufacturer === device.model.manufacturer
      && candidate.model === device.model.model,
  );

  if (model) {
    return model;
  }

  const siblings = models
    .filter((candidate) => candidate.manufacturer === device.model.manufacturer)
    .map((candidate) => candidate.model);

  throw new Error(
    `${device.model.manufacturer} ${device.model.model} is not in the catalogue; `
    + `${device.model.manufacturer} entries: ${siblings.join(', ') || 'none'}`,
  );
}

/** The port to try: the one named, else the ones the profile's USB ids match. */
async function candidatePorts(
  transport: NodeSerialTransport,
  device: HardwareDevice,
  env: Environment,
): Promise<readonly string[]> {
  const named = (env[PORT_VARIABLE] ?? '').trim();

  if (named !== '') {
    return [named];
  }

  const usb = device.usb;

  if (!usb) {
    throw new Error(
      `${PORT_VARIABLE} is not set and the ${device.id} profile has no USB ids to look for; `
      + `set ${PORT_VARIABLE} to the port ${device.label} is attached to`,
    );
  }

  const entries = await transport.listPorts();
  /* Hex case is the platform's business: darwin reports `a34c`, win32 `A34C`. */
  const matching = entries.filter(
    (entry) => entry.vendorId?.toLowerCase() === usb.vendorId.toLowerCase()
      && entry.productId?.toLowerCase() === usb.productId.toLowerCase(),
  );

  if (matching.length === 0) {
    throw new Error(
      `${device.label} is not attached: no port reports USB ids `
      + `${usb.vendorId}:${usb.productId}.  This machine has:\n`
      + entries
        .map((entry) => `  ${entry.path} (${entry.manufacturer ?? 'unknown manufacturer'}, `
          + `${entry.vendorId ?? '?'}:${entry.productId ?? '?'})`)
        .join('\n'),
    );
  }

  return matching.map((entry) => entry.path);
}
