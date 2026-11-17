// SPDX-License-Identifier: MIT

/**
 * `struct confparams` as the binding surface sees it.
 *
 * The C++ struct is declared in `native/facade.cpp`; the value object crosses
 * with every field typed `EmbindString`, so this is the one place that narrows
 * one to the public shape.  It lives outside `src/index.ts` because the
 * generated method classes call it and must not import the public entry point.
 */
import { drainVector } from '../embind.js';
import type { RigConfparams, RigConfparamsList } from './hamlib-wasm.mjs';

/**
 * One configuration or extension parameter, as `struct confparams` describes
 * it: the opaque token the get/set calls take, its name, and the declared type.
 */
export interface RigConfparam {
  /** Opaque token, accepted by the generated level/parameter getters. */
  token: number;
  /** Parameter name, e.g. `"rig_pathname"`. */
  name: string;
  /** Human readable label. */
  label: string;
  /** Hint on the parameter. */
  tooltip: string;
  /** Default value, as text. */
  dflt: string;
  /** Hamlib `enum rig_conf_e` value: 0 string, 1 combo, 2 numeric, 3 checkbutton, 4 button, 5 binary, 6 int. */
  type: number;
}

/**
 * Narrow one native value object to the public shape.
 *
 * The emitted declaration types every `std::string` field as `EmbindString`, so
 * this is also what makes the fields plain strings for a caller.
 */
export function projectConfparam(value: RigConfparams): RigConfparam {
  return {
    token: value.token,
    name: String(value.name),
    label: String(value.label),
    tooltip: String(value.tooltip),
    dflt: String(value.dflt),
    type: value.type,
  };
}

/**
 * Drain one Embind vector of projected confparams, releasing the Wasm memory it
 * owns.
 *
 * The table walkers (`tokenForeach` and the three `ext*Foreach` methods) return
 * `std::vector<RigConfparams>`; the caller gets a plain array of the projected
 * value objects, never the vector or its elements.
 */
export function collectConfparams(list: RigConfparamsList): RigConfparam[] {
  return drainVector(list, projectConfparam);
}
