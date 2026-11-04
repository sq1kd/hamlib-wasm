/**
 * Playwright fixture: a Web Serial `SerialPort` implementation driven by one of
 * the emulated rigs in ./rigs.ts.
 *
 * This file is compiled to `generated/fake-serial.js` by the neighbouring
 * tsconfig.json and injected into the page as *text* (see
 * tests/browser/fixtures.ts) so nothing transpiles it in the browser and no
 * bundler helper can leak into the page; a transpiler-wrapped
 * `addInitScript(fn)` would reference helpers that do not exist in the page.
 * The rig registry is injected first.
 *
 * The default protocol is the Kenwood TS-480; a spec switches with
 * `window.__fakeSerial.useRig('icom-ic703')` before opening the port.
 *
 * A test drives it through `window.__fakeSerial`.
 */

(function installFakeWebSerial() {
  var registry = window.__fakeRigRegistry;

  if (!registry) {
    throw new Error('the fake rig registry was not installed first');
  }

  var rig = registry['kenwood-ts480']();

  /** The controller of the port's readable stream, while the port is open. */
  var readableController: ReadableStreamDefaultController<Uint8Array> | null = null;

  /* The spec-only verbs and the port are attached below, once the transport
   * they drive exists; the object literal is checked against the base shape and
   * then widened to the surface the specs see. */
  var control = ({
    /** The protocol currently driving the emulator. */
    rigName: rig.name,
    /** Options handed to SerialPort.open(), or null. */
    openedOptions: null,
    openCount: 0,
    closeCount: 0,
    isOpen: false,
    /** Set to a DOMException name to make the next open() fail. */
    failNextOpen: null,
    /** True when the next open() should park until releaseOpen(). */
    holdNextOpen: false,
    /** True while a parked open() is waiting. */
    openPending: false,
    /** Release a parked open().  A no-op when none is parked. */
    releaseOpen: function (): void { /* replaced while an open is parked */ },
    /**
     * Delay every emulator reply by this many milliseconds - of virtual time
     * when the page runs on the virtual clock, as every harness spec does.
     */
    replyDelayMs: 0,
    /** When true, every host write is refused, as a device that rejects commands. */
    failWrites: false,
    /** True when close() found a locked stream, i.e. the transport leaked. */
    closedWithLockedStreams: false,
    /** Every command the emulator decoded, without its framing. */
    commands: rig.commands,
    /** Last value passed to setSignals(). */
    outputSignals: null,
    /** SetSignals calls, for asserting the transport only drives what it must. */
    setSignalsCalls: 0,
    /** Input modem lines reported by getSignals(). */
    inputSignals: {
      clearToSend: true,
      dataSetClearToSend: true,
      dataSetReady: true,
      dataCarrierDetect: true,
      ringIndicator: false,
    },
    /** Emulated protocol state, exposed for assertions. */
    state: rig.state,
  } satisfies FakeSerialControlBase) as FakeSerialControl;

  /**
   * Switch the emulated radio.  Must be called while the port is closed.
   *
   * `name` is a key of window.__fakeRigRegistry.
   */
  control.useRig = function (name: string): void {
    var factory = registry[name];

    if (!factory) {
      throw new Error('unknown emulated rig "' + name + '"');
    }

    if (control.isOpen) {
      throw new Error('switch the emulated rig before opening the port');
    }

    rig = factory();
    control.rigName = rig.name;
    control.commands = rig.commands;
    control.state = rig.state;
  };

  /** Feed host bytes to the emulator and hand its replies to the reader. */
  function receive(chunk: Uint8Array): void {
    /* A rig behind a real UART hears the one rate its own menu is set to.
     * Opened at any other, it sees framing errors and says nothing at all -
     * the failure a rate scan exists to get past, and one no protocol-level
     * answer can report. */
    if (
      rig.baudRate !== undefined
      && control.openedOptions !== null
      && control.openedOptions.baudRate !== rig.baudRate
    ) {
      return;
    }

    var replies = rig.feed(chunk);

    for (var i = 0; i < replies.length; i++) {
      if (control.state.silent) { continue; }

      enqueueReply(replies[i]!);
    }
  }

  /**
   * Hand one reply to the reader, after `replyDelayMs` when one is set.  The
   * delay is an ordinary timer, so on the virtual clock it fires in deadline
   * order with Hamlib's own read timeout.
   */
  function enqueueReply(chunk: Uint8Array): void {
    if (control.replyDelayMs > 0) {
      setTimeout(function () {
        if (readableController !== null) { readableController.enqueue(chunk); }
      }, control.replyDelayMs);

      return;
    }

    if (readableController !== null) { readableController.enqueue(chunk); }
  }

  function encodeAscii(text: string): Uint8Array {
    var bytes = new Uint8Array(text.length);

    for (var i = 0; i < text.length; i++) { bytes[i] = text.charCodeAt(i); }

    return bytes;
  }

  /**
   * Minimal but faithful Web Serial SerialPort surface.
   *
   * The methods live on the prototype, a shape TypeScript cannot infer for a
   * function expression, so the constructor is asserted to the interface that
   * describes it and the emitted script stays a plain script.
   */
  var FakeSerialPort = function (this: FakePort): void {
    this.readable = null;
    this.writable = null;
  } as unknown as FakePortConstructor;

  /** @param options the line settings the transport opened the port with */
  FakeSerialPort.prototype.open = function (
    this: FakePort,
    options: FakeSerialOptions,
  ): Promise<void> {
    if (this.readable || this.writable) {
      return Promise.reject(
        new DOMException('The port is already open', 'InvalidStateError'),
      );
    }

    if (control.failNextOpen !== null) {
      var name = control.failNextOpen;
      control.failNextOpen = null;
      return Promise.reject(new DOMException('serial settings rejected', name));
    }

    var port = this;

    var complete = function (): void {
      control.openCount += 1;
      control.openedOptions = {
        baudRate: options.baudRate,
        dataBits: options.dataBits,
        stopBits: options.stopBits,
        parity: options.parity,
        flowControl: options.flowControl,
      };
      control.isOpen = true;
      rig.reset();
      rig.commands.length = 0;

      port.readable = new ReadableStream<Uint8Array>({
        start: function (controller) {
          readableController = controller;
        },
        cancel: function () {
          readableController = null;
        },
      });

      port.writable = new WritableStream<Uint8Array>({
        write: function (chunk) {
          if (control.failWrites) {
            return Promise.reject(
              new DOMException('the device refused the command', 'NetworkError'),
            );
          }

          receive(chunk);
        },
      });
    };

    if (!control.holdNextOpen) {
      complete();
      return Promise.resolve();
    }

    /* A controlled gate: the connection attempt parks here until the spec
     * releases it, so a race can be exercised without a sleep. */
    control.holdNextOpen = false;
    control.openPending = true;

    var gate = Promise.withResolvers<void>();

    control.releaseOpen = function (): void {
      control.openPending = false;
      complete();
      gate.resolve();
    };

    return gate.promise;
  };

  FakeSerialPort.prototype.close = function (this: FakePort): Promise<void> {
    if (!this.readable || !this.writable) {
      return Promise.reject(
        new DOMException('The port is not open', 'InvalidStateError'),
      );
    }

    if (this.readable.locked || this.writable.locked) {
      control.closedWithLockedStreams = true;
      return Promise.reject(
        new DOMException('The port is still locked', 'InvalidStateError'),
      );
    }

    readableController = null;
    this.readable = null;
    this.writable = null;
    control.isOpen = false;
    control.closeCount += 1;
    return Promise.resolve();
  };

  FakeSerialPort.prototype.setSignals = function (
    this: FakePort,
    signals: FakeOutputSignals,
  ): Promise<void> {
    control.setSignalsCalls += 1;
    control.outputSignals = Object.assign({}, control.outputSignals, signals);
    return Promise.resolve();
  };

  FakeSerialPort.prototype.getSignals = function (this: FakePort): Promise<FakeInputSignals> {
    return Promise.resolve(Object.assign({}, control.inputSignals));
  };

  FakeSerialPort.prototype.getInfo = function (this: FakePort) {
    return { usbVendorId: 0x1234, usbProductId: 0x5678 };
  };

  var port = new FakeSerialPort();
  control.port = port;

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

  /** Lets a spec remove Web Serial to exercise the unavailable path. */
  control.removeWebSerial = function (): void {
    Object.defineProperty(navigator, 'serial', {
      value: undefined,
      configurable: true,
    });
  };

  /**
   * Inject bytes into the port's readable stream without a write.  Lets a spec
   * exercise the receive queue, the waiters and the flush semantics directly.
   */
  control.pushRaw = function (text: string): void {
    if (readableController === null) {
      throw new Error('the fake port is not open');
    }

    readableController.enqueue(encodeAscii(text));
  };

  /**
   * Fail the readable stream, as a device unplug would.
   *
   * `name` is a DOMException name.
   */
  control.errorReadable = function (name: string): void {
    if (readableController === null) {
      throw new Error('the fake port is not open');
    }

    readableController.error(new DOMException('device failure', name));
  };

  window.__fakeSerial = control;
})();
