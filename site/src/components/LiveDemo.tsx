/**
 * The loader for the live demo.
 *
 * This island is all the demo page ships up front.  Once it mounts it runs the
 * dynamic `import()` below, and only that chunk reaches `hamlib-wasm` - so the
 * Emscripten glue and the ~5 MB Wasm stay off every other documentation page.
 *
 * On a constrained connection (`../network.ts`) the reader gets a button
 * instead and decides for themselves.
 */
import { useCallback, useEffect, useState } from 'react';
import type { ComponentType, ReactElement } from 'react';

import { megabytes } from '../bytes';
import { DEMO_DOWNLOAD as SIZE } from '../facts';
import { constrainedConnection } from '../network';
import { DemoLoading } from './DemoLoading';

type Status =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly Demo: ComponentType }
  | { readonly kind: 'failed'; readonly message: string };

export default function LiveDemo(): ReactElement {
  const [status, setStatus] = useState<Status>(() => (constrainedConnection() ? { kind: 'idle' } : { kind: 'loading' }));

  const load = useCallback((): void => {
    setStatus({ kind: 'loading' });
    import('../demo/Demo').then(
      (module) => { setStatus({ kind: 'ready', Demo: module.default }); },
      (cause: unknown) => {
        setStatus({ kind: 'failed', message: cause instanceof Error ? cause.message : String(cause) });
      },
    );
  }, []);

  useEffect(() => {
    if (!constrainedConnection()) {
      load();
    }
  }, [load]);

  switch (status.kind) {
    case 'ready':
      return <status.Demo />;
    case 'loading':
      return <DemoLoading />;
    default:
      return (
        <div className="live-demo-loader not-content">
          <button type="button" data-testid="load-demo" onClick={load}>
            {status.kind === 'failed' ? 'Try again' : `Load live demo (about ${megabytes(SIZE.gzip)})`}
          </button>
          {status.kind === 'failed'
            ? <p className="live-demo-error">Could not load the demo: {status.message}</p>
            : (
              <p>
                Your browser asked to save data, so the demo waits for you. It downloads the Hamlib
                WebAssembly module and its loader: {megabytes(SIZE.gzip)} gzip
                ({megabytes(SIZE.brotli)} brotli, {megabytes(SIZE.raw)} uncompressed).
              </p>
            )}
        </div>
      );
  }
}
