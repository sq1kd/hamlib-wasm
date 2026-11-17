// SPDX-License-Identifier: MIT

/**
 * The transport policy of `hamlib.config.yaml` - the line settings every
 * transport accepts and the configuration tokens the facade owns - in each
 * language that enforces it: `native/generated/policy.h` for the serial layer
 * and the facade, `as const` lists in `names.ts` for the TypeScript layer, and
 * the narrowed types the JS library opens a port with.
 *
 * Authored as TypeScript and run directly by Node's type stripping, so this
 * file must stay erasable (no enums, namespaces or parameter properties).
 */
import type { Model } from '../config.ts';
import type { NameVocabulary } from '../names.ts';
import { GENERATED_HEADER } from './common.ts';

interface NamedSetting {
  readonly names: readonly string[];
  /** The C constant of each name. */
  readonly constants: readonly string[];
  readonly spelling: string;
  readonly union: string;
}

/** A configured parity or handshake list, checked against the enum it names. */
function named(names: readonly string[], enumName: string, vocabularies: readonly NameVocabulary[]): NamedSetting {
  const vocabulary = vocabularies.find((candidate) => candidate.record.enumName === enumName);

  if (!vocabulary?.constants || !vocabulary.spelling || !vocabulary.record.names) {
    throw new Error(`no vocabulary names ${enumName}`);
  }

  const declared = vocabulary.constants;
  const constants = names.map((name) => {
    const constant = declared[vocabulary.names.indexOf(name)];

    if (constant === undefined) {
      throw new Error(`lineSettings: "${name}" is not one of ${vocabulary.names.join(', ')}`);
    }

    return constant.name;
  });

  return { names, constants, spelling: vocabulary.spelling, union: vocabulary.record.names.type };
}

function resolve(model: Model, vocabularies: readonly NameVocabulary[]) {
  return {
    parity: named(model.lineSettings.parity, 'serial_parity_e', vocabularies),
    handshake: named(model.lineSettings.handshake, 'serial_handshake_e', vocabularies),
  };
}

function predicate(name: string, type: string, values: readonly (string | number)[]): string[] {
  return [
    `static inline int ${name}(${type} value)`,
    '{',
    `    return ${values.map((value) => `value == ${value}`).join(' || ')};`,
    '}',
    '',
  ];
}

/** `native/generated/policy.h`. */
export function emitPolicyHeader(model: Model, vocabularies: readonly NameVocabulary[]): string {
  const { parity, handshake } = resolve(model, vocabularies);
  const { dataBits, stopBits } = model.lineSettings;

  return [
    GENERATED_HEADER,
    '',
    '#ifndef HAMLIB_WASM_POLICY_H',
    '#define HAMLIB_WASM_POLICY_H',
    '',
    '#include "hamlib/rig.h"',
    '',
    '/* The line settings every transport accepts (lineSettings). */',
    ...predicate('webserial_supports_data_bits', 'int', dataBits),
    ...predicate('webserial_supports_stop_bits', 'int', stopBits),
    ...predicate('webserial_supports_parity', parity.spelling, parity.constants),
    ...predicate('webserial_supports_handshake', handshake.spelling, handshake.constants),
    '/* The configuration tokens the facade sets itself (ownedConf). */',
    'static const char *const kOwnedConf[] = {',
    ...Object.keys(model.ownedConf).map((token) => `    "${token}",`),
    '};',
    '',
    '#endif /* HAMLIB_WASM_POLICY_H */',
    '',
  ].join('\n');
}

/** A TypeScript string literal. */
function quote(text: string): string {
  return `'${text.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

/** The policy as TypeScript constants, for `names.ts`. */
export function policyConstants(model: Model, vocabularies: readonly NameVocabulary[]): string[] {
  const { parity, handshake } = resolve(model, vocabularies);
  const { dataBits, stopBits } = model.lineSettings;

  return [
    '/** The data bits every transport accepts, from hamlib.config.yaml. */',
    `export const LINE_DATA_BITS = [${dataBits.join(', ')}] as const;`,
    '',
    '/** The stop bits every transport accepts, from hamlib.config.yaml. */',
    `export const LINE_STOP_BITS = [${stopBits.join(', ')}] as const;`,
    '',
    '/** The parities every transport accepts, from hamlib.config.yaml. */',
    `export const LINE_PARITIES = [${parity.names.map(quote).join(', ')}] as const satisfies readonly ${parity.union}[];`,
    '',
    '/** The flow controls every transport accepts, from hamlib.config.yaml. */',
    `export const LINE_HANDSHAKES = [${handshake.names.map(quote).join(', ')}] as const satisfies readonly ${handshake.union}[];`,
    '',
    '/** The configuration tokens the facade sets itself, with what to use instead, from hamlib.config.yaml. */',
    'export const OWNED_CONF = {',
    ...Object.entries(model.ownedConf).map(([token, why]) => `  ${token}: ${quote(why)},`),
    '} as const;',
    '',
    '/** One of the tokens of {@link OWNED_CONF}. */',
    'export type OwnedConfToken = keyof typeof OWNED_CONF;',
    '',
  ];
}

/** The settings a JS-library port opens with, for `transport.d.ts`. */
export function lineSettingsTypes(model: Model, vocabularies: readonly NameVocabulary[]): string[] {
  const { parity, handshake } = resolve(model, vocabularies);
  const { dataBits, stopBits } = model.lineSettings;

  return [
    '/** The line settings every transport accepts, from hamlib.config.yaml. */',
    `type LineDataBits = ${dataBits.join(' | ')};`,
    `type LineStopBits = ${stopBits.join(' | ')};`,
    `type LineParity = ${parity.names.map(quote).join(' | ')};`,
    `type LineHandshake = ${handshake.names.map(quote).join(' | ')};`,
    '',
  ];
}
