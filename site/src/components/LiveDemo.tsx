/**
 * The on-demand loader for the live demo.
 *
 * This island is all the demo page loads up front: a button and a sentence.
 * Only a click runs the dynamic `import()` below, and only that chunk reaches
 * `hamlib-wasm` - so the Emscripten glue and the ~5 MB Wasm are never fetched
 * for a reader who just wants the documentation.
 */
import { useState } from 'react';
import type { ComponentType, ReactElement } from 'react';

function megabytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

const SIZE = __DEMO_DOWNLOAD__;

type Status =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly Demo: ComponentType }
  | { readonly kind: 'failed'; readonly message: string };

export default function LiveDemo(): ReactElement {
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  if (status.kind === 'ready') {
    return <status.Demo />;
  }

  const load = (): void => {
    setStatus({ kind: 'loading' });
    import('../demo/Demo').then(
      (module) => { setStatus({ kind: 'ready', Demo: module.default }); },
      (cause: unknown) => {
        setStatus({ kind: 'failed', message: cause instanceof Error ? cause.message : String(cause) });
      },
    );
  };

  return (
    <div className="live-demo-loader not-content">
      <button
        type="button"
        data-testid="load-demo"
        disabled={status.kind === 'loading'}
        onClick={load}
      >
        {status.kind === 'loading' ? 'Loading…' : `Load live demo (about ${megabytes(SIZE.gzip)})`}
      </button>
      <p>
        Downloads the Hamlib WebAssembly module and its loader: {megabytes(SIZE.gzip)} gzip
        ({megabytes(SIZE.brotli)} brotli, {megabytes(SIZE.raw)} uncompressed), plus the demo's
        own scripts.
      </p>
      {status.kind === 'failed' && <p className="live-demo-error">Could not load the demo: {status.message}</p>}
    </div>
  );
}
