// SPDX-License-Identifier: MIT
// Excerpt of packages/hamlib-wasm/src/native/hamlib-wasm.d.mts, committed here
// so the emitted-declaration parser has a stable input that does not depend on
// a native build.  The members are copied verbatim from the generated file.
interface EmbindModule {
  RigModelList: {
    new(): RigModelList;
  };
  listModels(): RigModelList;
  capabilities(_0: number): StringList;
  lookupMemCaps(_0: number, _1: number): RigChanList;
  settingToIdx(_0: number): number;
  idxToSetting(_0: number): number;
  initialize(): CodeResult;
  closeRig(_0: number): CodeResult;
  setFrequency(_0: number, _1: number): CodeResult;
}
