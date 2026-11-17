/**
 * One serial port over one emulated rig from ./rigs.ts: the double every
 * test drives.
 *
 * The rules here - a second open is refused, an opened port records its line
 * settings, closing while a stream is locked is remembered, an open can be
 * held or failed, replies can be delayed, fragmented or echoed - are the rules
 * the package's transport layer is written against, not a property of Web
 * Serial.  So the browser's `navigator.serial` double (./fake-serial.ts) and
 * the Node tests (tests/node/fake-port.ts) wrap this one implementation, and
 * the port is typed as the package's own `SerialPortLike`, so contract drift
 * fails `mise run typecheck`.
 *
 * This file is compiled to `generated/fake-port.js` by the neighbouring
 * tsconfig.json and injected into the page as *text* after the rig registry
 * (see tests/browser/fixtures.ts); Node imports it for its side effect.
 */

(function installFakePortFactory() {
  window.__createFakePort = function createFakePort(
    initialRig: FakeRigName = 'kenwood-ts480',
  ): FakePortControl {
    var rig = window.__fakeRigRegistry[initialRig]();

    /** The controller of the port's readable stream, while the port is open. */
    var readableController: ReadableStreamDefaultController<Uint8Array> | null = null;
    var readable: ReadableStream<Uint8Array> | null = null;
    var writable: WritableStream<Uint8Array> | null = null;

    /** Hand host bytes to the line: the echo first, then the rig's answers. */
    function receive(chunk: Uint8Array): void {
      if (control.echo && readableController !== null) {
        readableController.enqueue(chunk.slice());
      }

      var opened = control.openedOptions;
      var replies = rig.hear(chunk, opened === null ? null : opened.baudRate);

      for (var i = 0; i < replies.length; i++) { enqueueReply(replies[i]!); }
    }

    /**
     * Hand one reply to the reader, after `replyDelayMs` when one is set, and
     * in `fragmentBytes` pieces when that is set.  The delays are ordinary
     * timers, so on a virtual clock they fire in deadline order with Hamlib's
     * own read timeout.
     */
    function enqueueReply(chunk: Uint8Array): void {
      if (control.fragmentBytes > 0) {
        for (var offset = 0, piece = 0; offset < chunk.length; offset += control.fragmentBytes, piece++) {
          deliver(chunk.slice(offset, offset + control.fragmentBytes), control.replyDelayMs + piece * control.fragmentGapMs);
        }

        return;
      }

      deliver(chunk, control.replyDelayMs);
    }

    function deliver(chunk: Uint8Array, delayMs: number): void {
      if (delayMs > 0) {
        setTimeout(function () {
          if (readableController !== null) { readableController.enqueue(chunk); }
        }, delayMs);

        return;
      }

      if (readableController !== null) { readableController.enqueue(chunk); }
    }

    function completeOpen(options: import('hamlib-wasm/raw').SerialLineSettings): void {
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

      readable = new ReadableStream<Uint8Array>({
        start: function (controller) {
          readableController = controller;
        },
        cancel: function () {
          readableController = null;
        },
      });

      writable = new WritableStream<Uint8Array>({
        write: function (chunk) {
          if (control.failWrites) {
            return Promise.reject(
              new DOMException('the device refused the command', 'NetworkError'),
            );
          }

          receive(chunk);
          return undefined;
        },
      });
    }

    var port: import('hamlib-wasm/raw').SerialPortLike = {
      get readable() { return readable; },
      get writable() { return writable; },

      open: function (options) {
        if (readable || writable) {
          return Promise.reject(
            new DOMException('The port is already open', 'InvalidStateError'),
          );
        }

        if (control.failNextOpen !== null) {
          var name = control.failNextOpen;
          control.failNextOpen = null;
          return Promise.reject(new DOMException('serial settings rejected', name));
        }

        if (!control.holdNextOpen) {
          completeOpen(options);
          return Promise.resolve();
        }

        control.holdNextOpen = false;
        control.openPending = true;

        var gate = Promise.withResolvers<void>();

        control.releaseOpen = function (): void {
          control.releaseOpen = function (): void { /* nothing is parked */ };
          control.openPending = false;
          completeOpen(options);
          gate.resolve();
        };

        return gate.promise;
      },

      close: function () {
        control.closeRequests += 1;

        if (!readable || !writable) {
          return Promise.reject(
            new DOMException('The port is not open', 'InvalidStateError'),
          );
        }

        if (readable.locked || writable.locked) {
          control.closedWithLockedStreams = true;
          return Promise.reject(
            new DOMException('The port is still locked', 'InvalidStateError'),
          );
        }

        readableController = null;
        readable = null;
        writable = null;
        control.isOpen = false;
        control.closeCount += 1;
        return Promise.resolve();
      },

      setSignals: function (signals) {
        control.setSignalsCalls += 1;
        control.outputSignals = Object.assign({}, control.outputSignals, signals);
        return Promise.resolve();
      },

      getSignals: function () {
        return Promise.resolve(Object.assign({}, control.inputSignals));
      },

      getInfo: function () {
        return { usbVendorId: 0x1234, usbProductId: 0x5678 };
      },
    };

    var control: FakePortControl = {
      port: port,
      rigName: initialRig,
      openedOptions: null,
      openCount: 0,
      closeCount: 0,
      isOpen: false,
      failNextOpen: null,
      holdNextOpen: false,
      openPending: false,
      releaseOpen: function (): void { /* nothing is parked */ },
      replyDelayMs: 0,
      fragmentBytes: 0,
      fragmentGapMs: 0,
      echo: false,
      failWrites: false,
      closeRequests: 0,
      closedWithLockedStreams: false,
      commands: rig.commands,
      outputSignals: null,
      setSignalsCalls: 0,
      inputSignals: {
        clearToSend: true,
        dataSetReady: true,
        dataCarrierDetect: true,
        ringIndicator: false,
      },
      state: rig.state,

      useRig: function (name: FakeRigName): void {
        var factory = window.__fakeRigRegistry[name];

        if (!factory) {
          throw new Error('unknown emulated rig "' + name + '"');
        }

        if (control.isOpen) {
          throw new Error('switch the emulated rig before opening the port');
        }

        rig = factory();
        control.rigName = name;
        control.commands = rig.commands;
        control.state = rig.state;
      },

      pushRaw: function (text: string): void {
        if (readableController === null) {
          throw new Error('the fake port is not open');
        }

        readableController.enqueue(new TextEncoder().encode(text));
      },

      errorReadable: function (name: string): void {
        if (readableController === null) {
          throw new Error('the fake port is not open');
        }

        readableController.error(new DOMException('device failure', name));
      },
    };

    return control;
  };
})();
