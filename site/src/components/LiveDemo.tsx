/**
 * The loader for the live demo.
 *
 * This island is all the demo page ships up front.  Once it mounts it runs the
 * dynamic `import()` below, and only that chunk reaches `hamlib-wasm` - so the
 * Emscripten glue and the ~5 MB Wasm stay off every other documentation page.
 *
 * A reader who asked the browser to save data, or who is on a 2G-class link,
 * gets a button instead and decides for themselves.  Browsers without the
 * Network Information API (Firefox, Safari) always load straight away.
 */
import { useCallback, useEffect, useState } from 'react';
import type { ComponentType, ReactElement } from 'react';

import { DemoLoading, megabytes } from './DemoLoading';

const SIZE = __DEMO_DOWNLOAD__;

type Status =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly Demo: ComponentType }
  | { readonly kind: 'failed'; readonly message: string };

interface NetworkInformation {
  readonly saveData?: boolean;
  readonly effectiveType?: string;
}

/** Whether the connection asks us not to fetch megabytes unprompted. */
function constrained(): boolean {
  const connection = (navigator as { connection?: NetworkInformation }).connection;

  return connection?.saveData === true || connection?.effectiveType === 'slow-2g' || connection?.effectiveType === '2g';
}

export default function LiveDemo(): ReactElement {
  const [status, setStatus] = useState<Status>(() => (constrained() ? { kind: 'idle' } : { kind: 'loading' }));

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
    if (!constrained()) {
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
