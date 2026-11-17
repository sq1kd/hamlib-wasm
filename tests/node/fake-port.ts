/**
 * The fixtures' fake port, for the Node tests.
 *
 * tests/browser/fixtures/fake-port.ts is the one port double the repository
 * has: the browser's `navigator.serial` wraps it, and so does this.  Its port
 * is typed as the package's own `SerialPortLike`, so it is handed to the
 * package as an injected transport would hand over a port.
 */
import './rigs.js';
import '../browser/fixtures/fake-port.ts';

/**
 * One emulated rig behind a port that satisfies the package's port contract.
 *
 * The returned control object is the state the port mutates - not a copy of
 * it - so a test reads the counters after the facade has driven the port.
 */
export function fakePort(rigName?: FakeRigName): FakePortControl {
  return window.__createFakePort(rigName);
}
