/**
 * External consumer fixture.
 *
 * This file is only typechecked (never executed).  It imports the package the
 * way a real application would - from the packed tarball through the published
 * exports map - and walks the complete documented flow, so a mismatch between
 * the generated declarations and the package exports fails `mise run
 * typecheck`.
 */
import { createHamlib, HamlibError } from 'hamlib-web';
import type {
  Hamlib,
  HamlibErrorCode,
  HamlibOptions,
  OpenRigOptions,
  PttState,
  Rig,
  RigCapabilities,
  RigMode,
  RigModeState,
  RigModel,
  RigStatus,
} from 'hamlib-web';

export interface ConsumerSummary {
  version: string;
  modelId: number;
  status: RigStatus;
  frequency: number;
  mode: RigModeState;
  ptt: PttState;
  capabilities: RigCapabilities;
}

export async function runConsumerFlow(
  port: SerialPort,
  locateFile: HamlibOptions['locateFile'],
): Promise<ConsumerSummary> {
  const hamlib: Hamlib = await createHamlib({ locateFile });
  const version: string = hamlib.version;
  const models: readonly RigModel[] = hamlib.models;

  const model: RigModel | undefined = models.find(
    (candidate: RigModel) => candidate.manufacturer === 'Kenwood'
      && candidate.model === 'TS-480',
  );

  if (!model) {
    await hamlib.dispose();
    throw new Error('the TS-480 model is missing from the catalogue');
  }

  const options: OpenRigOptions = {
    modelId: model.id,
    port,
    baudRate: model.serialRateMax,
  };

  let rig: Rig | undefined;
  let summary: ConsumerSummary | undefined;

  try {
    /* requestPort() needs a user gesture in a real page; a granted port may be
     * passed straight to open() instead. */
    const granted: SerialPort = await hamlib.requestPort();
    rig = await hamlib.open({ ...options, port: granted });

    const status: RigStatus = await rig.getStatus();
    await rig.setFrequency(7_074_000);
    const frequency: number = await rig.getFrequency();
    const mode: RigModeState = await rig.getMode();
    await rig.setMode('CW', 500);
    await rig.setPtt('on');
    const ptt: PttState = await rig.getPtt();

    summary = {
      version,
      modelId: rig.model.id,
      status,
      frequency,
      mode,
      ptt,
      capabilities: {
        canGetFrequency: model.canGetFrequency,
        canSetFrequency: model.canSetFrequency,
        canGetMode: model.canGetMode,
        canSetMode: model.canSetMode,
        canGetPtt: model.canGetPtt,
        canSetPtt: model.canSetPtt,
      },
    };
  } catch (error) {
    if (error instanceof HamlibError) {
      const code: HamlibErrorCode = error.code;
      const operation: string = error.operation;
      const hamlibCode: number | undefined = error.hamlibCode;
      const hamlibMessage: string | undefined = error.hamlibMessage;
      const cause: unknown = error.cause;

      throw new Error(
        `${operation} failed with ${code}`
        + (hamlibCode === undefined ? '' : ` (#${hamlibCode} ${hamlibMessage})`)
        + (cause === undefined ? '' : ` caused by ${String(cause)}`),
        { cause: error },
      );
    }

    throw error;
  } finally {
    if (rig) {
      await rig.close();
    }

    await hamlib.dispose();
  }

  return summary;
}

export function describeMode(mode: RigMode, passband: number): string {
  return `${mode} ${passband} Hz`;
}
