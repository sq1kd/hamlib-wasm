/*
 * Serial transport for the Hamlib WebAssembly build.
 *
 * This Emscripten JS library owns everything about a serial port that cannot
 * be expressed in C, for every transport the package offers (Web Serial in the
 * browser, the `serialport` adapter in Node; see src/web-serial.ts and
 * src/node.ts):
 *
 *   - the registry of caller-acquired port objects under opaque
 *     logical paths of the form "serial/<n>",
 *   - opaque positive integer handles stored in hamlib_port_t.fd,
 *   - a chunked RX byte queue fed by one continuous reader per open port,
 *   - waitReadable(handle, timeoutMs) semantics for Hamlib's select(),
 *   - one serialized writer per open port,
 *   - RTS/DTR/BREAK output and CTS/DCD/DSR input signal access,
 *   - the latest transport error, so the TypeScript layer can attach transport
 *     context to a HamlibError.
 *
 * The port objects it drives are whatever the package's transport acquired;
 * the contract they must satisfy is SerialPortLike in emscripten-globals.d.ts,
 * which mirrors src/transport.ts.  Every method it uses - open, close,
 * readable/writable, setSignals, getSignals - is Web Serial's own shape, which
 * is why the browser needs no adapter and Node needs only a thin one.
 *
 * Functions declared here are called from native/web_serial.c.  Every
 * function that awaits a transport promise is annotated with __async: "auto"
 * so Emscripten adds it to ASYNCIFY_IMPORTS and rewrites callers to suspend.
 *
 * Emscripten lifts each entry out of this file into its own generated scope,
 * so the entries reference only the `$HamlibWs` global Emscripten injects
 * (`HamlibWs`) and other Emscripten globals.  A module-scope binding - a
 * closure, a `const` - does not survive the lift, so the transport is one
 * object literal whose methods share state through `this`, and every helper
 * value is either an own property or a local inside the method.  The literal
 * is still type-checked as strict TypeScript.
 *
 * Authored as strict TypeScript and compiled to the JS library Emscripten
 * consumes; see native/tsconfig.library.json and build/compile-native.ts.
 */

/* Hamlib's serial enum order.  The transport contract accepts neither the
 * mark/space parity names nor xon-xoff flow control, so a rig that declares
 * them is refused earlier by ws_validate_config in native/web_serial.c;
 * keeping the full table preserves the index mapping.  These are inlined at
 * each use because a module-scope binding would not survive Emscripten's
 * library lift. */

addToLibrary({
  $HamlibWs: {
    WS_OK: 0,
    WS_ERR_IO: -1,
    WS_ERR_CONF: -2,
    WS_ERR_INVAL: -3,
    WS_ERR_TIMEOUT: -4,
    WS_ERR_ACCESS: -5,
    WS_ERR_BUSY: -6,

    /* token -> port, waiting for the facade to bind it to a logical path */
    pendingPorts: new Map<number, SerialPortLike>(),
    /* logical path -> record */
    ports: new Map<string, PortRecord>(),
    /* handle -> record + state */
    handles: new Map<number, HandleEntry>(),
    nextToken: 1,
    nextHandle: 1,
    lastError: null as ErrorRecord | null,

    /* --- diagnostics ---------------------------------------------------- */

    recordError(name: string, message: string, context?: string): void {
      this.lastError = {
        name: name || 'Error',
        message: message || 'serial transport failure',
        context: context || '',
      };
    },

    fail(error: unknown, context: string): number {
      const name = (error as { name?: string } | null)?.name ?? 'Error';
      const message = (error as { message?: string } | null)?.message ?? String(error);
      this.recordError(name, message, context);

      if (name === 'TypeError' || name === 'NotSupportedError') {
        /* A transport rejects settings it cannot express - port.open() with a
         * parity mode outside none/even/odd, for instance - with a TypeError. */
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

    lastErrorText(): string {
      if (!this.lastError) {
        return '';
      }

      let text = `${this.lastError.name}: ${this.lastError.message}`;

      if (this.lastError.context) {
        text += ` (${this.lastError.context})`;
      }

      return text;
    },

    /* --- registry ------------------------------------------------------- */

    /* Called by the TypeScript layer with a port its transport acquired. */
    storePort(port: SerialPortLike): number {
      if (!port || typeof port.open !== 'function') {
        this.recordError('TypeError', 'object is not a serial port');
        return 0;
      }

      const token = this.nextToken++;
      this.pendingPorts.set(token, port);
      return token;
    },

    /* Called by the facade: binds a stored port to an opaque logical path. */
    registerPort(path: string, token: number): number {
      if (!path) {
        this.recordError('TypeError', 'logical path is required', 'registerPort');
        return this.WS_ERR_INVAL;
      }

      const port = this.pendingPorts.get(token);

      if (!port) {
        this.recordError('InvalidStateError', `unknown serial port token ${token}`, 'registerPort');
        return this.WS_ERR_INVAL;
      }

      this.pendingPorts.delete(token);

      if (this.ports.has(path)) {
        this.recordError('InvalidStateError', `logical path ${path} is already registered`, 'registerPort');
        return this.WS_ERR_BUSY;
      }

      this.ports.set(path, { path, port, openCount: 0, state: null });
      return this.WS_OK;
    },

    /* Idempotent: removing an unknown path succeeds. */
    unregisterPort(path: string): number {
      const record = this.ports.get(path);

      if (!record) {
        return this.WS_OK;
      }

      if (record.state) {
        this.recordError('InvalidStateError', `logical path ${path} is still open`, 'unregisterPort');
        return this.WS_ERR_BUSY;
      }

      this.ports.delete(path);
      return this.WS_OK;
    },

    /* --- byte queue ----------------------------------------------------- */

    queuePush(queue: ByteQueue, chunk: Uint8Array): void {
      if (chunk.length === 0) {
        return;
      }

      queue.chunks.push(chunk);
      queue.length += chunk.length;
    },

    /* Copies at most `max` buffered bytes into Wasm memory at `ptr`. */
    queueRead(queue: ByteQueue, heap: Uint8Array, ptr: number, max: number): number {
      const want = Math.min(max, queue.length);
      let copied = 0;
      let out = ptr;

      while (copied < want && queue.chunks.length > 0) {
        const head = queue.chunks[0] as Uint8Array;
        const available = head.length - queue.offset;
        const take = Math.min(available, want - copied);

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

    queueClear(queue: ByteQueue): void {
      queue.chunks.length = 0;
      queue.offset = 0;
      queue.length = 0;
    },

    /* --- waiters -------------------------------------------------------- */

    wake(state: PortState, reason: WakeReason): void {
      const waiters = state.waiters;
      state.waiters = [];

      for (const waiter of waiters) {
        waiter(reason);
      }
    },

    /* --- RX pump -------------------------------------------------------- */

    startPump(state: PortState): Promise<void> {
      const self = this;
      const reader = state.reader as ReadableStreamDefaultReader<Uint8Array>;

      return (async function () {
        try {
          for (;;) {
            const result = await reader.read();

            if (result.done) {
              break;
            }

            if (result.value && result.value.length > 0) {
              state.rxBytes += result.value.length;
              self.queuePush(state.queue, result.value);
              self.wake(state, 'data');
            }
          }
        } catch (error) {
          if (!state.closed) {
            const name = (error as { name?: string } | null)?.name ?? 'Error';
            const message = (error as { message?: string } | null)?.message ?? String(error);
            state.failure = { name, message };
            self.recordError(name, message, 'read');
          }
        } finally {
          self.wake(state, 'error');
        }
      })();
    },

    /* --- open/close ----------------------------------------------------- */

    makeState(options: SerialLineSettings): PortState {
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
        rxBytes: 0,
        lastRts: 0,
        lastDtr: 0,
        rtsKnown: false,
        dtrKnown: false,
      };
    },

    allocHandle(record: PortRecord): number {
      const handle = this.nextHandle++;
      this.handles.set(handle, { record: record, state: record.state as PortState });
      return handle;
    },

    /* Tears down one open port.  Never throws: reports through lastError. */
    async teardown(record: PortRecord, state: PortState): Promise<number> {
      state.closed = true;

      if (state.reader) {
        try {
          await state.reader.cancel();
        } catch {
          /* The stream may already be closed or errored. */
        }

        if (state.pumpPromise) {
          try {
            await state.pumpPromise;
          } catch {
            /* Reported by the pump itself. */
          }
        }

        try {
          state.reader.releaseLock();
        } catch {
          /* Ignore: the reader is no longer usable either way. */
        }
      }

      if (state.writeChain) {
        try {
          await state.writeChain;
        } catch {
          /* Individual writes report their own failure. */
        }
      }

      if (state.writer) {
        try {
          state.writer.releaseLock();
        } catch {
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

    async openPort(
      path: string,
      rate: number,
      dataBits: number,
      stopBits: number,
      parity: number,
      flowControl: number,
    ): Promise<number> {
      const record = this.ports.get(path);

      if (!record) {
        this.recordError('NotFoundError', `serial port ${path} is not registered`, 'open');
        return this.WS_ERR_INVAL;
      }

      if (record.state) {
        /* A rig may open its CAT and PTT lines on the same physical port. */
        record.openCount++;
        return this.allocHandle(record);
      }

      const parityName = ['none', 'odd', 'even', 'mark', 'space'][parity];
      const flowName = ['none', 'xon-xoff', 'hardware'][flowControl];

      if (!parityName || !flowName) {
        this.recordError('TypeError', 'unsupported serial configuration', 'open');
        return this.WS_ERR_CONF;
      }

      const options: SerialLineSettings = {
        baudRate: rate,
        dataBits: dataBits as SerialLineSettings['dataBits'],
        stopBits: stopBits as SerialLineSettings['stopBits'],
        parity: parityName as SerialLineSettings['parity'],
        flowControl: flowName as SerialLineSettings['flowControl'],
        bufferSize: 255,
      };

      try {
        await record.port.open(options);
      } catch (error) {
        return this.fail(error, 'open');
      }

      const state = this.makeState(options);
      record.state = state;
      record.openCount = 1;

      try {
        state.reader = record.port.readable?.getReader() ?? null;
      } catch (error) {
        await this.teardown(record, state);
        return this.fail(error, 'open');
      }

      if (!state.reader) {
        await this.teardown(record, state);
        this.recordError('InvalidStateError', 'serial port has no readable stream', 'open');
        return this.WS_ERR_IO;
      }

      state.pumpPromise = this.startPump(state);

      return this.allocHandle(record);
    },

    async closePort(handle: number): Promise<number> {
      const entry = this.handles.get(handle);

      if (!entry) {
        return this.WS_OK;
      }

      this.handles.delete(handle);

      const record = entry.record;
      record.openCount--;

      if (record.openCount > 0) {
        return this.WS_OK;
      }

      const state = record.state;

      if (!state) {
        return this.WS_OK;
      }

      return this.teardown(record, state);
    },

    matchesOpenOptions(
      handle: number,
      rate: number,
      dataBits: number,
      stopBits: number,
      parity: number,
      flowControl: number,
    ): number {
      const entry = this.handles.get(handle);

      if (!entry) {
        return this.WS_ERR_INVAL;
      }

      const options = entry.state.options;

      if (
        options.baudRate === rate
        && options.dataBits === dataBits
        && options.stopBits === stopBits
        && options.parity === ['none', 'odd', 'even', 'mark', 'space'][parity]
        && options.flowControl === ['none', 'xon-xoff', 'hardware'][flowControl]
      ) {
        return 1;
      }

      return 0;
    },

    read(handle: number, ptr: number, len: number): number {
      const entry = this.handles.get(handle);

      if (!entry) {
        return this.WS_ERR_INVAL;
      }

      if (entry.state.queue.length === 0) {
        return 0;
      }

      return this.queueRead(entry.state.queue, HEAPU8, ptr, len);
    },

    /*
     * Bytes the rig has sent on this handle since the port was opened.
     *
     * Unlike the RX queue this is never drained, so it answers "did the rig
     * ever speak" - the question the facade has to ask before it can believe
     * that rig_open() really reached a radio.  A port that has received
     * nothing has not been talked to by anything.
     */
    bytesReceived(handle: number): number {
      const entry = this.handles.get(handle);

      if (!entry) {
        return this.WS_ERR_INVAL;
      }

      return entry.state.rxBytes;
    },

    write(handle: number, ptr: number, len: number): Promise<number> {
      const self = this;
      const entry = this.handles.get(handle);

      if (!entry) {
        return Promise.resolve(this.WS_ERR_INVAL);
      }

      if (len <= 0) {
        return Promise.resolve(0);
      }

      const state = entry.state;
      /* Copy the outgoing range once, before awaiting the writer. */
      const chunk = HEAPU8.slice(ptr, ptr + len);

      const perform = async function (): Promise<number> {
        try {
          if (!state.writer) {
            state.writer = entry.record.port.writable?.getWriter() ?? null;
          }

          if (!state.writer) {
            self.recordError('InvalidStateError', 'serial port has no writable stream', 'write');
            return self.WS_ERR_IO;
          }

          await state.writer.write(chunk);
          return len;
        } catch (error) {
          return self.fail(error, 'write');
        }
      };

      const previous = state.writeChain
        ? state.writeChain.then(() => {}, () => {})
        : Promise.resolve();

      state.writeChain = previous.then(perform);
      return state.writeChain;
    },

    waitReadable(handle: number, timeoutMs: number): Promise<number> {
      const self = this;
      const entry = this.handles.get(handle);

      if (!entry) {
        return Promise.resolve(this.WS_ERR_INVAL);
      }

      const state = entry.state;

      if (state.queue.length > 0) {
        return Promise.resolve(1);
      }

      if (state.failure) {
        this.recordError(state.failure.name, state.failure.message, 'read');
        return Promise.resolve(this.WS_ERR_IO);
      }

      if (state.closed) {
        this.recordError('InvalidStateError', 'serial port is closed', 'read');
        return Promise.resolve(this.WS_ERR_IO);
      }

      return new Promise<WakeReason>(function (resolve) {
        let settled = false;
        let timer: number | undefined;

        const waiter = function (why: WakeReason): void {
          if (settled) {
            return;
          }

          settled = true;
          clearTimeout(timer);
          resolve(why);
        };

        state.waiters.push(waiter);

        if (timeoutMs >= 0) {
          timer = setTimeout(function () {
            waiter('timeout');
          }, timeoutMs);
        }
      }).then(function (reason) {
        if (reason === 'data') {
          return 1;
        }

        if (reason === 'timeout') {
          return 0;
        }

        /* The pump may have recorded a failure while this call was waiting, so
         * the property is re-read through an assertion that defeats the
         * earlier narrow. */
        const failure = state.failure as TransportFailure | null;

        if (failure) {
          self.recordError(failure.name, failure.message, 'read');
        } else if (state.closed) {
          self.recordError('InvalidStateError', 'serial port is closed', 'read');
        }

        return self.WS_ERR_IO;
      });
    },

    flush(handle: number): number {
      const entry = this.handles.get(handle);

      if (!entry) {
        return this.WS_ERR_INVAL;
      }

      this.queueClear(entry.state.queue);
      return this.WS_OK;
    },

    async setSignals(handle: number, rts: number, dtr: number, brk: number): Promise<number> {
      const entry = this.handles.get(handle);

      if (!entry) {
        return this.WS_ERR_INVAL;
      }

      const state = entry.state;
      const signals: SerialOutputSignals = {};

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

      if (brk >= 0) {
        signals.break = brk !== 0;
      }

      try {
        await entry.record.port.setSignals(signals);
      } catch (error) {
        return this.fail(error, 'setSignals');
      }

      return this.WS_OK;
    },

    async getSignals(handle: number): Promise<number> {
      const entry = this.handles.get(handle);

      if (!entry) {
        return this.WS_ERR_INVAL;
      }

      try {
        const signals = await entry.record.port.getSignals();
        let mask = 0;

        if (signals.clearToSend) {
          mask |= 0x1;
        }

        if (signals.dataSetReady) {
          mask |= 0x2;
        }

        if (signals.dataCarrierDetect) {
          mask |= 0x4;
        }

        if (signals.ringIndicator) {
          mask |= 0x8;
        }

        return mask;
      } catch (error) {
        return this.fail(error, 'getSignals');
      }
    },

    /* The transport contract cannot read output lines back, so report the last
     * state we requested.  A freshly opened port has both lines deasserted. */
    lastRts(handle: number): number {
      const entry = this.handles.get(handle);
      return entry ? entry.state.lastRts : this.WS_ERR_INVAL;
    },

    lastDtr(handle: number): number {
      const entry = this.handles.get(handle);
      return entry ? entry.state.lastDtr : this.WS_ERR_INVAL;
    },

    writeLastError(ptr: number, len: number): number {
      if (len <= 0) {
        return 0;
      }

      const text = this.lastErrorText();

      if (!text) {
        return 0;
      }

      const written = Math.min(lengthBytesUTF8(text), len - 1);
      stringToUTF8(text, ptr, len);
      return written;
    },

    clearLastError(): number {
      this.lastError = null;
      return 0;
    },
  } satisfies HamlibWsApi,

  hamlibWsRegisterPort__deps: ['$HamlibWs'],
  hamlibWsRegisterPort: function (path: number, token: number): number {
    return HamlibWs.registerPort(UTF8ToString(path), token);
  },

  hamlibWsUnregisterPort__deps: ['$HamlibWs'],
  hamlibWsUnregisterPort: function (path: number): number {
    return HamlibWs.unregisterPort(UTF8ToString(path));
  },

  hamlibWsOpenPort__deps: ['$HamlibWs'],
  hamlibWsOpenPort__async: 'auto',
  hamlibWsOpenPort: function (
    path: number,
    rate: number,
    dataBits: number,
    stopBits: number,
    parity: number,
    flowControl: number,
  ): Promise<number> {
    return HamlibWs.openPort(UTF8ToString(path), rate, dataBits, stopBits, parity, flowControl);
  },

  hamlibWsClosePort__deps: ['$HamlibWs'],
  hamlibWsClosePort__async: 'auto',
  hamlibWsClosePort: function (handle: number): Promise<number> {
    return HamlibWs.closePort(handle);
  },

  hamlibWsMatchesOpenOptions__deps: ['$HamlibWs'],
  hamlibWsMatchesOpenOptions: function (
    handle: number,
    rate: number,
    dataBits: number,
    stopBits: number,
    parity: number,
    flowControl: number,
  ): number {
    return HamlibWs.matchesOpenOptions(handle, rate, dataBits, stopBits, parity, flowControl);
  },

  hamlibWsRead__deps: ['$HamlibWs'],
  hamlibWsRead: function (handle: number, ptr: number, len: number): number {
    return HamlibWs.read(handle, ptr, len);
  },

  hamlibWsBytesReceived__deps: ['$HamlibWs'],
  hamlibWsBytesReceived: function (handle: number): number {
    return HamlibWs.bytesReceived(handle);
  },

  hamlibWsWrite__deps: ['$HamlibWs'],
  hamlibWsWrite__async: 'auto',
  hamlibWsWrite: function (handle: number, ptr: number, len: number): Promise<number> {
    return HamlibWs.write(handle, ptr, len);
  },

  hamlibWsWaitReadable__deps: ['$HamlibWs'],
  hamlibWsWaitReadable__async: 'auto',
  hamlibWsWaitReadable: function (handle: number, timeoutMs: number): Promise<number> {
    return HamlibWs.waitReadable(handle, timeoutMs);
  },

  hamlibWsFlush__deps: ['$HamlibWs'],
  hamlibWsFlush: function (handle: number): number {
    return HamlibWs.flush(handle);
  },

  hamlibWsSetSignals__deps: ['$HamlibWs'],
  hamlibWsSetSignals__async: 'auto',
  hamlibWsSetSignals: function (handle: number, rts: number, dtr: number, brk: number): Promise<number> {
    return HamlibWs.setSignals(handle, rts, dtr, brk);
  },

  hamlibWsGetSignals__deps: ['$HamlibWs'],
  hamlibWsGetSignals__async: 'auto',
  hamlibWsGetSignals: function (handle: number): Promise<number> {
    return HamlibWs.getSignals(handle);
  },

  hamlibWsLastRts__deps: ['$HamlibWs'],
  hamlibWsLastRts: function (handle: number): number {
    return HamlibWs.lastRts(handle);
  },

  hamlibWsLastDtr__deps: ['$HamlibWs'],
  hamlibWsLastDtr: function (handle: number): number {
    return HamlibWs.lastDtr(handle);
  },

  hamlibWsWriteLastError__deps: ['$HamlibWs'],
  hamlibWsWriteLastError: function (ptr: number, len: number): number {
    return HamlibWs.writeLastError(ptr, len);
  },

  hamlibWsClearLastError__deps: ['$HamlibWs'],
  hamlibWsClearLastError: function (): number {
    return HamlibWs.clearLastError();
  },
});
