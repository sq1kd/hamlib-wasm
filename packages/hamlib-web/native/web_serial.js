/*
 * Browser serial transport for the Hamlib WebAssembly build.
 *
 * This Emscripten JS library owns everything about Web Serial that cannot be
 * expressed in C:
 *
 *   - the registry of browser-selected SerialPort objects under opaque
 *     logical paths of the form "webserial/<n>",
 *   - opaque positive integer handles stored in hamlib_port_t.fd,
 *   - a chunked RX byte queue fed by one continuous reader per open port,
 *   - waitReadable(handle, timeoutMs) semantics for Hamlib's select(),
 *   - one serialized writer per open port,
 *   - RTS/DTR/BREAK output and CTS/DCD/DSR input signal access,
 *   - the latest DOM exception, so the TypeScript layer can attach transport
 *     context to a HamlibError.
 *
 * Functions declared here are called from native/web_serial.c.  Every
 * function that awaits a browser promise is annotated with __async: "auto"
 * so Emscripten adds it to ASYNCIFY_IMPORTS and rewrites callers to suspend.
 *
 * The object exposed as Module.HamlibWs is also the only JavaScript entry
 * point used by the TypeScript package: registering a SerialPort object
 * requires a real JavaScript value, which cannot be marshalled through the
 * Wasm boundary, so the TypeScript layer stores the object here and passes
 * the opaque token on to the facade.
 */

addToLibrary({
  $HamlibWs: {
    WS_OK: 0,
    WS_ERR_IO: -1,
    WS_ERR_CONF: -2,
    WS_ERR_INVAL: -3,
    WS_ERR_TIMEOUT: -4,
    WS_ERR_ACCESS: -5,
    WS_ERR_BUSY: -6,

    /* token -> SerialPort, waiting for the facade to bind it to a logical path */
    pendingPorts: new Map(),
    /* logical path -> { path, port, openCount, state } */
    ports: new Map(),
    /* handle -> { record, state } */
    handles: new Map(),
    nextToken: 1,
    nextHandle: 1,
    lastError: null,

    /* --- diagnostics ---------------------------------------------------- */

    recordError: function (name, message, context) {
      this.lastError = {
        name: name || 'Error',
        message: message || 'serial transport failure',
        context: context || '',
      };
    },

    fail: function (error, context) {
      var name = (error && error.name) || 'Error';
      var message = (error && error.message) || String(error);
      this.recordError(name, message, context);

      if (name === 'TypeError' || name === 'NotSupportedError') {
        /* SerialPort.open() rejects with TypeError for settings the adapter
         * cannot express, e.g. a parity mode outside none/even/odd. */
        return this.WS_ERR_CONF;
      }

      if (name === 'SecurityError') {
        return this.WS_ERR_ACCESS;
      }

      if (name === 'NotFoundError') {
        return this.WS_ERR_INVAL;
      }

      if (name === 'InvalidStateError') {
        return this.WS_ERR_BUSY;
      }

      return this.WS_ERR_IO;
    },

    lastErrorText: function () {
      if (!this.lastError) { return ''; }

      var text = this.lastError.name + ': ' + this.lastError.message;

      if (this.lastError.context) {
        text += ' (' + this.lastError.context + ')';
      }

      return text;
    },

    /* --- registry ------------------------------------------------------- */

    /* Called by the TypeScript layer with a real SerialPort object. */
    storePort: function (port) {
      if (!port || typeof port.open !== 'function') {
        this.recordError('TypeError', 'object is not a SerialPort');
        return 0;
      }

      var token = this.nextToken++;
      this.pendingPorts.set(token, port);
      return token;
    },

    isSerialSupported: function () {
      return !!(globalThis.navigator && globalThis.navigator.serial
                && typeof globalThis.navigator.serial.requestPort === 'function');
    },

    /* Called by the facade: binds a stored port to an opaque logical path. */
    registerPort: function (path, token) {
      if (!path) {
        this.recordError('TypeError', 'logical path is required', 'registerPort');
        return this.WS_ERR_INVAL;
      }

      var port = this.pendingPorts.get(token);

      if (!port) {
        this.recordError('InvalidStateError',
                         'unknown serial port token ' + token, 'registerPort');
        return this.WS_ERR_INVAL;
      }

      this.pendingPorts.delete(token);

      if (this.ports.has(path)) {
        this.recordError('InvalidStateError',
                         'logical path ' + path + ' is already registered',
                         'registerPort');
        return this.WS_ERR_BUSY;
      }

      this.ports.set(path, { path: path, port: port, openCount: 0, state: null });
      return this.WS_OK;
    },

    /* Idempotent: removing an unknown path succeeds. */
    unregisterPort: function (path) {
      var record = this.ports.get(path);

      if (!record) { return this.WS_OK; }

      if (record.state) {
        this.recordError('InvalidStateError',
                         'logical path ' + path + ' is still open',
                         'unregisterPort');
        return this.WS_ERR_BUSY;
      }

      this.ports.delete(path);
      return this.WS_OK;
    },

    /* --- byte queue ----------------------------------------------------- */

    queuePush: function (queue, chunk) {
      if (!chunk || chunk.length === 0) { return; }

      queue.chunks.push(chunk);
      queue.length += chunk.length;
    },

    /* Copies at most `max` buffered bytes into Wasm memory at `ptr`. */
    queueRead: function (queue, heap, ptr, max) {
      var want = Math.min(max, queue.length);
      var copied = 0;
      var out = ptr;

      while (copied < want && queue.chunks.length > 0) {
        var head = queue.chunks[0];
        var available = head.length - queue.offset;
        var take = Math.min(available, want - copied);

        if (take > 0) {
          heap.set(head.subarray(queue.offset, queue.offset + take), out);
          queue.offset += take;
          out += take;
          copied += take;
          queue.length -= take;
        }

        if (queue.offset >= head.length) {
          queue.chunks.shift();
          queue.offset = 0;
        } else {
          break;
        }
      }

      return copied;
    },

    queueClear: function (queue) {
      queue.chunks.length = 0;
      queue.offset = 0;
      queue.length = 0;
    },

    /* --- waiters -------------------------------------------------------- */

    /* reason: 'data' | 'timeout' | 'error' */
    wake: function (state, reason) {
      var waiters = state.waiters;
      state.waiters = [];

      for (var i = 0; i < waiters.length; i++) {
        waiters[i](reason);
      }
    },

    /* --- RX pump -------------------------------------------------------- */

    startPump: function (record, state) {
      var self = this;
      var reader = state.reader;

      return (async function () {
        try {
          for (;;) {
            var result = await reader.read();

            if (result.done) { break; }

            if (result.value && result.value.length > 0) {
              self.queuePush(state.queue, result.value);
              self.wake(state, 'data');
            }
          }
        } catch (error) {
          if (!state.closed) {
            var name = (error && error.name) || 'Error';
            var message = (error && error.message) || String(error);
            state.failure = { name: name, message: message };
            self.recordError(name, message, 'read');
          }
        } finally {
          self.wake(state, 'error');
        }
      })();
    },

    /* --- open/close ----------------------------------------------------- */

    makeState: function (options) {
      return {
        options: options,
        queue: { chunks: [], offset: 0, length: 0 },
        waiters: [],
        failure: null,
        closed: false,
        reader: null,
        writer: null,
        writeChain: null,
        pumpPromise: null,
        lastRts: 0,
        lastDtr: 0,
        rtsKnown: false,
        dtrKnown: false,
      };
    },

    allocHandle: function (record) {
      var handle = this.nextHandle++;
      this.handles.set(handle, { record: record, state: record.state });
      return handle;
    },

    /* Tears down one open port.  Never throws: reports through lastError. */
    teardown: async function (record, state) {
      state.closed = true;

      if (state.reader) {
        try {
          await state.reader.cancel();
        } catch (error) {
          /* The stream may already be closed or errored. */
        }

        if (state.pumpPromise) {
          try {
            await state.pumpPromise;
          } catch (error) {
            /* Reported by the pump itself. */
          }
        }

        try {
          state.reader.releaseLock();
        } catch (error) {
          /* Ignore: the reader is no longer usable either way. */
        }
      }

      if (state.writeChain) {
        try {
          await state.writeChain;
        } catch (error) {
          /* Individual writes report their own failure. */
        }
      }

      if (state.writer) {
        try {
          state.writer.releaseLock();
        } catch (error) {
          /* Ignore. */
        }

        state.writer = null;
      }

      record.state = null;
      record.openCount = 0;

      try {
        await record.port.close();
      } catch (error) {
        return this.fail(error, 'close');
      }

      return this.WS_OK;
    },

    /* --- transport primitives called from C ----------------------------- */

    openPort: async function (path, rate, dataBits, stopBits, parity,
                              flowControl) {
      var record = this.ports.get(path);

      if (!record) {
        this.recordError('NotFoundError',
                         'serial port ' + path + ' is not registered', 'open');
        return this.WS_ERR_INVAL;
      }

      if (record.state) {
        /* A rig may open its CAT and PTT lines on the same physical port. */
        record.openCount++;
        return this.allocHandle(record);
      }

      var parityName = ['none', 'odd', 'even', 'mark', 'space'][parity];
      var flowName = ['none', 'xon-xoff', 'hardware'][flowControl];

      if (!parityName || !flowName) {
        this.recordError('TypeError', 'unsupported serial configuration', 'open');
        return this.WS_ERR_CONF;
      }

      var options = {
        baudRate: rate,
        dataBits: dataBits,
        stopBits: stopBits,
        parity: parityName,
        flowControl: flowName,
        bufferSize: 255,
      };

      try {
        await record.port.open(options);
      } catch (error) {
        return this.fail(error, 'open');
      }

      var state = this.makeState(options);
      record.state = state;
      record.openCount = 1;

      try {
        state.reader = record.port.readable.getReader();
      } catch (error) {
        await this.teardown(record, state);
        return this.fail(error, 'open');
      }

      state.pumpPromise = this.startPump(record, state);

      return this.allocHandle(record);
    },

    closePort: async function (handle) {
      var entry = this.handles.get(handle);

      if (!entry) { return this.WS_OK; }

      this.handles.delete(handle);

      var record = entry.record;
      record.openCount--;

      if (record.openCount > 0) { return this.WS_OK; }

      var state = record.state;

      if (!state) { return this.WS_OK; }

      return this.teardown(record, state);
    },

    matchesOpenOptions: function (handle, rate, dataBits, stopBits, parity,
                                  flowControl) {
      var entry = this.handles.get(handle);

      if (!entry) { return this.WS_ERR_INVAL; }

      var options = entry.state.options;
      var parityName = ['none', 'odd', 'even', 'mark', 'space'][parity];
      var flowName = ['none', 'xon-xoff', 'hardware'][flowControl];

      if (options.baudRate === rate
          && options.dataBits === dataBits
          && options.stopBits === stopBits
          && options.parity === parityName
          && options.flowControl === flowName) {
        return 1;
      }

      return 0;
    },

    read: function (handle, ptr, len) {
      var entry = this.handles.get(handle);

      if (!entry) { return this.WS_ERR_INVAL; }

      if (entry.state.queue.length === 0) { return 0; }

      return this.queueRead(entry.state.queue, HEAPU8, ptr, len);
    },

    write: function (handle, ptr, len) {
      var self = this;
      var entry = this.handles.get(handle);

      if (!entry) { return this.WS_ERR_INVAL; }

      if (len <= 0) { return 0; }

      var state = entry.state;
      /* Copy the outgoing range once, before awaiting the writer. */
      var chunk = HEAPU8.slice(ptr, ptr + len);

      var perform = async function () {
        try {
          if (!state.writer) {
            state.writer = entry.record.port.writable.getWriter();
          }

          await state.writer.write(chunk);
          return len;
        } catch (error) {
          return self.fail(error, 'write');
        }
      };

      var previous = state.writeChain
        ? state.writeChain.then(function () {}, function () {})
        : Promise.resolve();

      state.writeChain = previous.then(perform);
      return state.writeChain;
    },

    waitReadable: function (handle, timeoutMs) {
      var self = this;
      var entry = this.handles.get(handle);

      if (!entry) { return this.WS_ERR_INVAL; }

      var state = entry.state;

      if (state.queue.length > 0) { return 1; }

      if (state.failure) {
        this.recordError(state.failure.name, state.failure.message, 'read');
        return this.WS_ERR_IO;
      }

      if (state.closed) {
        this.recordError('InvalidStateError', 'serial port is closed', 'read');
        return this.WS_ERR_IO;
      }

      return new Promise(function (resolve) {
        var settled = false;
        var timer = null;

        var waiter = function (reason) {
          if (settled) { return; }

          settled = true;
          clearTimeout(timer);
          resolve(reason);
        };

        state.waiters.push(waiter);

        if (timeoutMs >= 0) {
          timer = setTimeout(function () { waiter('timeout'); }, timeoutMs);
        }
      }).then(function (reason) {
        if (reason === 'data') { return 1; }

        if (reason === 'timeout') { return 0; }

        if (state.failure) {
          self.recordError(state.failure.name, state.failure.message, 'read');
        } else if (state.closed) {
          self.recordError('InvalidStateError', 'serial port is closed', 'read');
        }

        return self.WS_ERR_IO;
      });
    },

    flush: function (handle) {
      var entry = this.handles.get(handle);

      if (!entry) { return this.WS_ERR_INVAL; }

      this.queueClear(entry.state.queue);
      return this.WS_OK;
    },

    setSignals: async function (handle, rts, dtr, brk) {
      var entry = this.handles.get(handle);

      if (!entry) { return this.WS_ERR_INVAL; }

      var state = entry.state;
      var signals = {};

      if (rts >= 0) {
        signals.requestToSend = rts !== 0;
        state.lastRts = rts !== 0 ? 1 : 0;
        state.rtsKnown = true;
      }

      if (dtr >= 0) {
        signals.dataTerminalReady = dtr !== 0;
        state.lastDtr = dtr !== 0 ? 1 : 0;
        state.dtrKnown = true;
      }

      if (brk >= 0) { signals.break = brk !== 0; }

      try {
        await entry.record.port.setSignals(signals);
      } catch (error) {
        return this.fail(error, 'setSignals');
      }

      return this.WS_OK;
    },

    getSignals: async function (handle) {
      var entry = this.handles.get(handle);

      if (!entry) { return this.WS_ERR_INVAL; }

      try {
        var signals = await entry.record.port.getSignals();
        var mask = 0;

        if (signals.clearToSend) { mask |= 0x1; }

        if (signals.dataSetReady) { mask |= 0x2; }

        if (signals.dataCarrierDetect) { mask |= 0x4; }

        if (signals.ringIndicator) { mask |= 0x8; }

        return mask;
      } catch (error) {
        return this.fail(error, 'getSignals');
      }
    },

    /* Web Serial cannot read back output lines, so report the last state we
     * requested.  A freshly opened port has both lines deasserted. */
    lastRts: function (handle) {
      var entry = this.handles.get(handle);
      return entry ? entry.state.lastRts : this.WS_ERR_INVAL;
    },

    lastDtr: function (handle) {
      var entry = this.handles.get(handle);
      return entry ? entry.state.lastDtr : this.WS_ERR_INVAL;
    },

    writeLastError: function (ptr, len) {
      if (len <= 0) { return 0; }

      var text = this.lastErrorText();

      if (!text) { return 0; }

      var written = Math.min(lengthBytesUTF8(text), len - 1);
      stringToUTF8(text, ptr, len);
      return written;
    },

    clearLastError: function () {
      this.lastError = null;
      return 0;
    },
  },

  hamlibWsRegisterPort__deps: ['$HamlibWs'],
  hamlibWsRegisterPort: function (path, token) {
    return HamlibWs.registerPort(UTF8ToString(path), token);
  },

  hamlibWsUnregisterPort__deps: ['$HamlibWs'],
  hamlibWsUnregisterPort: function (path) {
    return HamlibWs.unregisterPort(UTF8ToString(path));
  },

  hamlibWsOpenPort__deps: ['$HamlibWs'],
  hamlibWsOpenPort__async: 'auto',
  hamlibWsOpenPort: function (path, rate, dataBits, stopBits, parity,
                              flowControl) {
    return HamlibWs.openPort(UTF8ToString(path), rate, dataBits, stopBits,
                             parity, flowControl);
  },

  hamlibWsClosePort__deps: ['$HamlibWs'],
  hamlibWsClosePort__async: 'auto',
  hamlibWsClosePort: function (handle) {
    return HamlibWs.closePort(handle);
  },

  hamlibWsMatchesOpenOptions__deps: ['$HamlibWs'],
  hamlibWsMatchesOpenOptions: function (handle, rate, dataBits, stopBits, parity,
                                        flowControl) {
    return HamlibWs.matchesOpenOptions(handle, rate, dataBits, stopBits, parity,
                                       flowControl);
  },

  hamlibWsRead__deps: ['$HamlibWs'],
  hamlibWsRead: function (handle, ptr, len) {
    return HamlibWs.read(handle, ptr, len);
  },

  hamlibWsWrite__deps: ['$HamlibWs'],
  hamlibWsWrite__async: 'auto',
  hamlibWsWrite: function (handle, ptr, len) {
    return HamlibWs.write(handle, ptr, len);
  },

  hamlibWsWaitReadable__deps: ['$HamlibWs'],
  hamlibWsWaitReadable__async: 'auto',
  hamlibWsWaitReadable: function (handle, timeoutMs) {
    return HamlibWs.waitReadable(handle, timeoutMs);
  },

  hamlibWsFlush__deps: ['$HamlibWs'],
  hamlibWsFlush: function (handle) {
    return HamlibWs.flush(handle);
  },

  hamlibWsSetSignals__deps: ['$HamlibWs'],
  hamlibWsSetSignals__async: 'auto',
  hamlibWsSetSignals: function (handle, rts, dtr, brk) {
    return HamlibWs.setSignals(handle, rts, dtr, brk);
  },

  hamlibWsGetSignals__deps: ['$HamlibWs'],
  hamlibWsGetSignals__async: 'auto',
  hamlibWsGetSignals: function (handle) {
    return HamlibWs.getSignals(handle);
  },

  hamlibWsLastRts__deps: ['$HamlibWs'],
  hamlibWsLastRts: function (handle) {
    return HamlibWs.lastRts(handle);
  },

  hamlibWsLastDtr__deps: ['$HamlibWs'],
  hamlibWsLastDtr: function (handle) {
    return HamlibWs.lastDtr(handle);
  },

  hamlibWsWriteLastError__deps: ['$HamlibWs'],
  hamlibWsWriteLastError: function (ptr, len) {
    return HamlibWs.writeLastError(ptr, len);
  },

  hamlibWsClearLastError__deps: ['$HamlibWs'],
  hamlibWsClearLastError: function () {
    return HamlibWs.clearLastError();
  },
});
