/*
 * The stack one call travels, top to bottom: who owns each layer, and what
 * `rig.setFrequency(7_074_000)` on a TS-480 looks like when it passes through.
 */
export type Owner = 'you' | 'ours' | 'hamlib' | 'platform';

export interface Layer {
  name: string;
  owner: Owner;
  role: string;
  sees: string;
}

export const OWNER_LABEL: Record<Owner, string> = {
  you: 'your code',
  ours: 'hamlib-wasm',
  hamlib: 'Hamlib, unmodified',
  platform: 'browser or Node',
};

export const layers: Layer[] = [
  {
    name: 'Your app',
    owner: 'you',
    role: 'Asks for a frequency, in Hz.',
    sees: 'await rig.setFrequency(7_074_000)',
  },
  {
    name: 'TypeScript API',
    owner: 'ours',
    role: 'Checks the model can do it, then queues the call behind any other.',
    sees: 'rig.raw.setFrequency(7074000)',
  },
  {
    name: 'Embind facade',
    owner: 'ours',
    role: 'Generated C++ that turns the call into Hamlib’s public C API.',
    sees: 'rig_set_freq(rig, RIG_VFO_CURR, 7074000)',
  },
  {
    name: 'Rig backend',
    owner: 'hamlib',
    role: 'The Kenwood driver: the part that knows the radio’s language.',
    sees: 'FA00007074000;',
  },
  {
    name: 'Port layer',
    owner: 'hamlib',
    role: 'Upstream’s read loop, timeouts and retries, exactly as rigctl runs them.',
    sees: 'write(fd, "FA00007074000;", 14)',
  },
  {
    name: 'Serial layer',
    owner: 'ours',
    role: 'Link-time wrappers catch that write(); the fd is a handle into JavaScript.',
    sees: 'fd is ours → 14 bytes to JS',
  },
  {
    name: 'Transport',
    owner: 'ours',
    role: 'Writes to the port. Asyncify parks the C stack until the promise settles.',
    sees: 'await writer.write(bytes)',
  },
  {
    name: 'Web Serial or serialport',
    owner: 'platform',
    role: 'The USB cable, and the radio at the other end of it.',
    sees: '46 41 30 30 … 30 3B',
  },
];
