/**
 * Playwright fixture: a Web Serial `SerialPort` implementation driven by a
 * minimal Kenwood TS-480 CAT emulator.
 *
 * This file is injected into the page as *text* (see tests/browser/fixtures.ts)
 * so nothing transpiles it and no bundler helper can leak into the page; a
 * transpiler-wrapped `addInitScript(fn)` would reference helpers that do not
 * exist in the page.
 *
 * A test drives it through `window.__fakeSerial`.
 */

/* global window, navigator, ReadableStream, WritableStream, DOMException, setTimeout */

(function installFakeWebSerial() {
  /** Kenwood CAT terminator. */
  var TERMINATOR = ';';

  /** Kenwood MD digits used by the TS-480 backend. */
  var MODE_USB = 2;

  // ---------------------------------------------------------------- emulator

  var emulator = {
    /** Hz, matches the frequency the backend reports as VFO A. */
    frequency: 14074000,
    modeDigit: MODE_USB,
    /** FW value: an SSB filter number (0/1/2) or a CW/RTTY width in Hz. */
    filterValue: 0,
    transmitting: false,
    /** When true the emulator stays silent, which makes Hamlib time out. */
    silent: false,
    commands: [],
  };

  /**
   * The 37 character IF status payload, terminator excluded.
   * The backend reads PTT at [28], the mode at [29], the VFO at [30] and the
   * split state at [32].
   */
  function ifPayload() {
    var status = '000000000'
      + (emulator.transmitting ? '1' : '0')
      + String(emulator.modeDigit)
      + '00'
      + '0'
      + '000';

    return 'IF'
      + pad(emulator.frequency, 11)
      + '     '
      + '+'
      + status
      + ' ';
  }

  /** @param {number} value @param {number} width */
  function pad(value, width) {
    var text = String(value);

    while (text.length < width) { text = '0' + text; }

    return text;
  }

  /**
   * Build the reply for one CAT command, or null when the command is a set
   * (Kenwood set commands are verified by the following `ID;` transaction, so
   * answering them would corrupt the protocol).
   *
   * @param {string} command command without its terminator
   */
  function replyFor(command) {
    var prefix = command.slice(0, 2);
    var argument = command.slice(2);

    if (argument.length > 0) {
      switch (prefix) {
        case 'FA':
          emulator.frequency = Number(argument);
          return null;
        case 'MD':
          emulator.modeDigit = Number(argument);
          return null;
        case 'FW':
          emulator.filterValue = Number(argument);
          return null;
        case 'TX':
          emulator.transmitting = true;
          return null;
        default:
          return null;
      }
    }

    switch (command) {
      case 'TX':
        emulator.transmitting = true;
        return null;
      case 'RX':
        emulator.transmitting = false;
        return null;
      case 'ID':
        return 'ID020'; /* TS-480 id digits */
      case 'PS':
        return 'PS1';
      case 'AI':
        return 'AI0';
      case 'FA':
      case 'FB':
        return command + pad(emulator.frequency, 11);
      case 'MD':
        return 'MD' + String(emulator.modeDigit);
      case 'FW':
        return 'FW' + pad(emulator.filterValue, 4);
      case 'IF':
        return ifPayload();
      case 'FR':
        return 'FR0';
      case 'FT':
        return 'FT0';
      default:
        return '?';
    }
  }

  // ------------------------------------------------------------ fake serial

  /** @type {ReadableStreamDefaultController<Uint8Array> | null} */
  var readableController = null;

  /** @type {string} */
  var receiveBuffer = '';

  var control = {
    /** Options handed to SerialPort.open(), or null. */
    openedOptions: null,
    openCount: 0,
    closeCount: 0,
    isOpen: false,
    /** Set to a DOMException name to make the next open() fail. */
    failNextOpen: null,
    /** True when close() found a locked stream, i.e. the transport leaked. */
    closedWithLockedStreams: false,
    /** Every command the emulator decoded, without the terminator. */
    commands: emulator.commands,
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
    /** Emulator state, exposed for assertions. */
    state: emulator,
  };

  /** @param {Uint8Array} chunk */
  function receive(chunk) {
    for (var i = 0; i < chunk.length; i++) {
      receiveBuffer += String.fromCharCode(chunk[i]);
    }

    for (;;) {
      var end = receiveBuffer.indexOf(TERMINATOR);

      if (end < 0) { return; }

      var command = receiveBuffer.slice(0, end);
      receiveBuffer = receiveBuffer.slice(end + 1);

      if (command.length > 0) { emulator.commands.push(command); }

      if (emulator.silent) { continue; }

      var reply = replyFor(command);

      if (reply !== null && readableController !== null) {
        readableController.enqueue(encodeAscii(reply + TERMINATOR));
      }
    }
  }

  /** @param {string} text */
  function encodeAscii(text) {
    var bytes = new Uint8Array(text.length);

    for (var i = 0; i < text.length; i++) { bytes[i] = text.charCodeAt(i); }

    return bytes;
  }

  /** Minimal but faithful Web Serial SerialPort surface. */
  function FakeSerialPort() {
    this.readable = null;
    this.writable = null;
  }

  /**
   * @param {object} options
   * @param {number} options.baudRate
   * @param {number} options.dataBits
   * @param {number} options.stopBits
   * @param {string} options.parity
   * @param {string} options.flowControl
   */
  FakeSerialPort.prototype.open = function (options) {
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

    control.openCount += 1;
    control.openedOptions = {
      baudRate: options.baudRate,
      dataBits: options.dataBits,
      stopBits: options.stopBits,
      parity: options.parity,
      flowControl: options.flowControl,
    };
    control.isOpen = true;
    receiveBuffer = '';
    emulator.commands.length = 0;

    var self = this;

    this.readable = new ReadableStream({
      start: function (controller) {
        readableController = controller;
      },
      cancel: function () {
        readableController = null;
      },
    });

    this.writable = new WritableStream({
      write: function (chunk) {
        receive(chunk);
      },
    });

    void self;
    return Promise.resolve();
  };

  FakeSerialPort.prototype.close = function () {
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

  /** @param {object} signals */
  FakeSerialPort.prototype.setSignals = function (signals) {
    control.setSignalsCalls += 1;
    control.outputSignals = Object.assign({}, control.outputSignals, signals);
    return Promise.resolve();
  };

  FakeSerialPort.prototype.getSignals = function () {
    return Promise.resolve(Object.assign({}, control.inputSignals));
  };

  FakeSerialPort.prototype.getInfo = function () {
    return { usbVendorId: 0x1234, usbProductId: 0x5678 };
  };

  var port = new FakeSerialPort();
  control.port = port;

  var serial = {
    getPorts: function () { return Promise.resolve([port]); },
    requestPort: function () { return Promise.resolve(port); },
    onconnect: null,
    ondisconnect: null,
    addEventListener: function () {},
    removeEventListener: function () {},
    dispatchEvent: function () { return true; },
  };

  Object.defineProperty(navigator, 'serial', {
    value: serial,
    configurable: true,
  });

  /** Lets a spec remove Web Serial to exercise the unavailable path. */
  control.removeWebSerial = function () {
    Object.defineProperty(navigator, 'serial', {
      value: undefined,
      configurable: true,
    });
  };

  /**
   * Inject bytes into the port's readable stream without a write.  Lets a spec
   * exercise the receive queue, the waiters and the flush semantics directly.
   *
   * @param {string} text
   */
  control.pushRaw = function (text) {
    if (readableController === null) {
      throw new Error('the fake port is not open');
    }

    readableController.enqueue(encodeAscii(text));
  };

  /**
   * Fail the readable stream, as a device unplug would.
   *
   * @param {string} name DOMException name
   */
  control.errorReadable = function (name) {
    if (readableController === null) {
      throw new Error('the fake port is not open');
    }

    readableController.error(new DOMException('device failure', name));
  };

  window.__fakeSerial = control;
})();
