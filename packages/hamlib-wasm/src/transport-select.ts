// SPDX-License-Identifier: MIT

import type { SerialTransport } from './transport.js';
import type * as NodeEntry from './node.js';
import { webSerialTransport } from './web-serial.js';

/**
 * The transport a caller gets when none is passed: Web Serial where the
 * runtime has it, the `serialport` transport in Node - the way `serialport`'s
 * own entry auto-detects its binding.  The Node entry is imported
 * dynamically, so a page never executes it; a runtime that is neither falls
 * back to Web Serial, whose own TRANSPORT_UNAVAILABLE error names what is
 * missing.
 */
export async function selectTransport(explicit?: SerialTransport): Promise<SerialTransport> {
  if (explicit) { return explicit; }

  const web = webSerialTransport();

  if (web.isSupported()) { return web; }

  try {
    /* Dynamic, and invisible to bundlers, on purpose.  A static import would
     * pull `serialport` and its native bindings into every browser bundle; a
     * literal specifier would let a bundler resolve this Node-only entry from
     * the shared chunk and ship it - about 60 kB in the examples - to pages
     * that can never use it.  `@vite-ignore` keeps the specifier out of the
     * page's module graph; Node resolves it relative to this file at runtime,
     * and a runtime that cannot load it reports Web Serial. */
    const nodeEntry = './node.js';
    const entry: typeof NodeEntry = await import(/* @vite-ignore */ nodeEntry);
    const node = entry.nodeSerialTransport();

    return node.isSupported() ? node : web;
  } catch {
    /* A runtime that cannot load the Node entry at all reports Web Serial. */
    return web;
  }
}
