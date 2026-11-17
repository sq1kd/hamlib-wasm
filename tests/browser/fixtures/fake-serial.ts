/**
 * Playwright fixture: a Web Serial `navigator.serial` whose one port is the
 * fake port from ./fake-port.ts, over one of the emulated rigs in ./rigs.ts.
 *
 * This file is compiled to `generated/fake-serial.js` by the neighbouring
 * tsconfig.json and injected into the page as *text* (see
 * tests/browser/fixtures.ts) so nothing transpiles it in the browser and no
 * bundler helper can leak into the page; a transpiler-wrapped
 * `addInitScript(fn)` would reference helpers that do not exist in the page.
 * The rig registry and the port factory are injected first.
 *
 * The default protocol is the Kenwood TS-480; a spec switches with
 * `window.__fakeSerial.useRig('icom-ic703')` before opening the port.
 *
 * A test drives it through `window.__fakeSerial`.
 */

(function installFakeWebSerial() {
  var control = window.__createFakePort();
  var port = control.port;

  var serial = {
    getPorts: function () { return Promise.resolve([port]); },
    requestPort: function () { return Promise.resolve(port); },
    onconnect: null,
    ondisconnect: null,
    addEventListener: function () { /* the double never signals */ },
    removeEventListener: function () { /* the double never signals */ },
    dispatchEvent: function () { return true; },
  };

  Object.defineProperty(navigator, 'serial', {
    value: serial,
    configurable: true,
  });

  window.__fakeSerial = control;
})();
