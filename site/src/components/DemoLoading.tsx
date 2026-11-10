/**
 * The placeholder the live demo shows while it loads.
 *
 * Shared by the island (while the demo's own chunk arrives) and the demo
 * (while the Hamlib module instantiates), so the two waits read as one.
 */
import type { ReactElement } from 'react';

import { megabytes } from '../bytes';

export function DemoLoading(): ReactElement {
  return (
    <div className="live-demo-loader not-content" data-testid="demo-loading" role="status" aria-live="polite">
      <span className="live-demo-spinner" aria-hidden="true" />
      <p>Loading Hamlib… about {megabytes(__DEMO_DOWNLOAD__.gzip)}</p>
    </div>
  );
}
