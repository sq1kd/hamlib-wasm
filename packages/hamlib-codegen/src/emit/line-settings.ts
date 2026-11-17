// SPDX-License-Identifier: MIT

/**
 * The supported line settings of `hamlib.config.yaml`, in each language that
 * checks them: a C predicate per setting for the serial layer, `as const`
 * lists for the catalogue, and the narrowed types the JS library opens a
 * port with.
 *
 * Authored as TypeScript and run directly by Node's type stripping, so this
 * file must stay erasable (no enums, namespaces or parameter properties).
 */
import type { LineSettings } from '../config.ts';
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

  const constants = names.map((name) => {
    const index = vocabulary.names.indexOf(name);

    if (index < 0) {
      throw new Error(`lineSettings: "${name}" is not one of ${vocabulary.names.join(', ')}`);
    }

    return (vocabulary.constants?.[index] as { readonly name: string }).name;
  });

  return { names, constants, spelling: vocabulary.spelling, union: vocabulary.record.names.type };
}

function resolve(settings: LineSettings, vocabularies: readonly NameVocabulary[]) {
  return {
    parity: named(settings.parity, 'serial_parity_e', vocabularies),
    handshake: named(settings.handshake, 'serial_handshake_e', vocabularies),
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

/** `native/generated/line_settings.h`, for `ws_validate_config` in the serial layer. */
export function emitLineSettingsHeader(settings: LineSettings, vocabularies: readonly NameVocabulary[]): string {
  const { parity, handshake } = resolve(settings, vocabularies);

  return [
    GENERATED_HEADER,
    '',
    '#ifndef HAMLIB_WASM_LINE_SETTINGS_H',
    '#define HAMLIB_WASM_LINE_SETTINGS_H',
    '',
    '#include "hamlib/rig.h"',
    '',
    ...predicate('webserial_supports_data_bits', 'int', settings.dataBits),
    ...predicate('webserial_supports_stop_bits', 'int', settings.stopBits),
    ...predicate('webserial_supports_parity', parity.spelling, parity.constants),
    ...predicate('webserial_supports_handshake', handshake.spelling, handshake.constants),
    '#endif /* HAMLIB_WASM_LINE_SETTINGS_H */',
    '',
  ].join('\n');
}

const quote = (name: string): string => `'${name}'`;

/** The lists the catalogue explains an unusable model with, for `names.ts`. */
export function lineSettingsConstants(settings: LineSettings, vocabularies: readonly NameVocabulary[]): string[] {
  const { parity, handshake } = resolve(settings, vocabularies);

  return [
    '/** The data bits every transport accepts, from hamlib.config.yaml. */',
    `export const LINE_DATA_BITS = [${settings.dataBits.join(', ')}] as const;`,
    '',
    '/** The stop bits every transport accepts, from hamlib.config.yaml. */',
    `export const LINE_STOP_BITS = [${settings.stopBits.join(', ')}] as const;`,
    '',
    '/** The parities every transport accepts, from hamlib.config.yaml. */',
    `export const LINE_PARITIES = [${parity.names.map(quote).join(', ')}] as const satisfies readonly ${parity.union}[];`,
    '',
    '/** The flow controls every transport accepts, from hamlib.config.yaml. */',
    `export const LINE_HANDSHAKES = [${handshake.names.map(quote).join(', ')}] as const satisfies readonly ${handshake.union}[];`,
    '',
  ];
}

/** The settings a JS-library port opens with, for `transport.d.ts`. */
export function lineSettingsTypes(settings: LineSettings, vocabularies: readonly NameVocabulary[]): string[] {
  const { parity, handshake } = resolve(settings, vocabularies);

  return [
    '/** The line settings every transport accepts, from hamlib.config.yaml. */',
    `type LineDataBits = ${settings.dataBits.join(' | ')};`,
    `type LineStopBits = ${settings.stopBits.join(' | ')};`,
    `type LineParity = ${parity.names.map(quote).join(' | ')};`,
    `type LineHandshake = ${handshake.names.map(quote).join(' | ')};`,
    '',
  ];
}
