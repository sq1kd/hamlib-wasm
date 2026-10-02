/**
 * `struct confparams` as the binding surface sees it.
 *
 * The C++ struct is declared in `native/facade.cpp` and the table walkers
 * return it as an Embind vector; the value-object fields come across as
 * `EmbindString`, so the collector is the one place that drains and narrows
 * them.  It lives outside `src/index.ts` because the generated method classes
 * call it and must not import the public entry point.
 */
import type { MainModule } from './hamlib-web.mjs';

type NativeConfparamList = Awaited<ReturnType<MainModule['tokenForeach']>>;
type NativeConfparam = NonNullable<ReturnType<NativeConfparamList['get']>>;

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

/** Drain one Embind vector of confparams, releasing the Wasm memory it owns. */
export function collectConfparams(list: NativeConfparamList): RigConfparam[] {
  const entries: RigConfparam[] = [];

  try {
    for (let index = 0; index < list.size(); index++) {
      const entry: NativeConfparam | undefined = list.get(index);

      if (!entry) {
        continue;
      }

      entries.push({
        token: entry.token,
        name: String(entry.name),
        label: String(entry.label),
        tooltip: String(entry.tooltip),
        dflt: String(entry.dflt),
        type: entry.type,
      });
    }
  } finally {
    /* The Embind vector owns Wasm memory. */
    list.delete();
  }

  return entries;
}
