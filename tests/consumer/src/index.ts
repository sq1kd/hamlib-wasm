/**
 * External consumer fixture.
 *
 * This file is only typechecked (never executed).  It imports the package the
 * way a real application would - from the packed tarball through the published
 * exports map - and walks both documented flows, so a mismatch between the
 * generated declarations and the package exports fails `mise run typecheck`.
 *
 * Two entries are exercised: `hamlib-web`, the easy surface, and
 * `hamlib-web/native`, the 1:1 Hamlib surface.
 */
import { HamlibError, createEasy } from 'hamlib-web';
import type {
  EasyCapabilities,
  EasyHamlib,
  EasyRig,
  HamlibErrorCode,
  HamlibOptions,
  PttState,
  RigState,
} from 'hamlib-web';
import { createHamlib } from 'hamlib-web/native';
import type {
  Hamlib,
  OpenRigOptions,
  Rig,
  RigCapabilities,
  RigConfparam,
  RigMode,
  RigModeState,
  RigModel,
} from 'hamlib-web/native';

export interface ConsumerSummary {
  version: string;
  modelId: number;
  frequency: number;
  mode: RigModeState;
  ptt: string;
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

    const frequency: number = await rig.getFrequency();
    await rig.setFrequency(7_074_000);
    const mode: RigModeState = await rig.getMode();
    await rig.setMode('CW', 500);
    await rig.setPtt('on');
    const ptt: string = await rig.getPtt();

    /* The operations whose C++ body is hand-written (the buffer, extended
     * setting and PTT shapes) are typed methods like every other generated
     * one.  An extended lookup crosses as the projected `RigConfparam`. */
    const rigInfo: string = await rig.getRigInfo();
    const extension: RigConfparam = await rig.extLookupTok(0);
    const value: number = await rig.getExtLevel(extension.token);

    await rig.setExtLevel(extension.token, value);

    const codec: number = await rig.parseVfo(await rig.strVfo(0));
    const mask: number = await rig.hasGetLevel('AGC');

    void rigInfo;
    void codec;
    void mask;

    summary = {
      version,
      modelId: rig.model.id,
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

export interface EasySummary {
  version: string;
  state: RigState;
  capabilities: EasyCapabilities;
  ptt: PttState;
}

/** The easy flow: port request, one snapshot, events, a watch, the raw escape. */
export async function runEasyFlow(
  port: SerialPort,
  locateFile: HamlibOptions['locateFile'],
): Promise<EasySummary> {
  const hamlib: EasyHamlib = await createEasy({ locateFile });
  const version: string = hamlib.version;
  const model: RigModel | undefined = hamlib.models.find(
    (candidate: RigModel) => candidate.model === 'TS-480',
  );

  if (!model) {
    await hamlib.dispose();
    throw new Error('the TS-480 model is missing from the catalogue');
  }

  /* A granted port skips requestPort(), so no user gesture is needed here. */
  const rig: EasyRig = await hamlib.open({
    modelId: model.id,
    port,
    baudRate: model.serialRateMax,
  });

  const unsubscribe: () => void = rig.on('state', (state: RigState) => {
    void state.frequency;
  });
  const stopWatching: () => void = rig.watch(1000);

  unsubscribe();
  stopWatching();

  const state: RigState = await rig.refresh();
  await rig.setFrequency(7_074_000);
  await rig.setMode('CW');
  await rig.setPtt(true);

  const ptt: PttState = rig.state?.ptt ?? 'off';
  const capabilities: EasyCapabilities = rig.capabilities;

  /* Anything the easy surface does not cover is still reachable. */
  const raw: Rig = rig.raw;
  const mode: RigMode | undefined = state.mode;
  const rawMode: RigModeState = await raw.getMode();

  void mode;
  void rawMode;

  await rig.close();
  await hamlib.dispose();

  return { version, state, capabilities, ptt };
}

export function describeMode(mode: RigMode, passband: number): string {
  return `${mode} ${passband} Hz`;
}
