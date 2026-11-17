/*
 * SPDX-License-Identifier: MIT
 *
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

addToLibrary({
  $HamlibWs: {
    /* Bytes the pump may buffer before the reader is treated as stuck.
     * Hamlib's own read loop keeps the queue near empty; a rig that far ahead
     * of the CAT exchange means nothing is draining it, and buffering without
     * bound only postpones the failure. */
    RX_QUEUE_LIMIT: 65536,

    /* token -> port, waiting for the facade to bind it to a logical path */
    pendingPorts: new Map<number, SerialPortLike>(),
    /* logical path -> record */
    ports: new Map<string, PortRecord>(),
    /* handle -> record + state */
    handles: new Map<number, HandleEntry>(),
    nextToken: 1,
    nextHandle: 1,
    lastError: null as ErrorRecord | null,
    onLog: null as ((level: number, message: string) => void) | null,
    onTrace: null as ((direction: 'tx' | 'rx', path: string, bytes: Uint8Array) => void) | null,

    /* --- diagnostics ---------------------------------------------------- */

    /* A hook that throws must not take the CAT exchange down with it. */
    log(level: number, message: string): void {
      try {
        this.onLog?.(level, message);
      } catch {
        /* the hook's own problem */
      }
    },

    trace(direction: 'tx' | 'rx', path: string, bytes: Uint8Array): void {
      try {
        this.onTrace?.(direction, path, bytes);
      } catch {
        /* the hook's own problem */
      }
    },

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
        return WsStatus.ERR_CONF;
      }

      if (name === 'SecurityError') {
        return WsStatus.ERR_ACCESS;
      }

      if (name === 'NotFoundError') {
        return WsStatus.ERR_INVAL;
      }

      if (name === 'InvalidStateError') {
        return WsStatus.ERR_BUSY;
      }

      return WsStatus.ERR_IO;
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
        return WsStatus.ERR_INVAL;
      }

      const port = this.pendingPorts.get(token);

      if (!port) {
        this.recordError('InvalidStateError', `unknown serial port token ${token}`, 'registerPort');
        return WsStatus.ERR_INVAL;
      }

      this.pendingPorts.delete(token);

      if (this.ports.has(path)) {
        this.recordError('InvalidStateError', `logical path ${path} is already registered`, 'registerPort');
        return WsStatus.ERR_BUSY;
      }

      this.ports.set(path, { path, port, openCount: 0, state: null });
      return WsStatus.OK;
    },

    /* Idempotent: removing an unknown path succeeds. */
    unregisterPort(path: string): number {
      const record = this.ports.get(path);

      if (!record) {
        return WsStatus.OK;
      }

      if (record.state) {
        this.recordError('InvalidStateError', `logical path ${path} is still open`, 'unregisterPort');
        return WsStatus.ERR_BUSY;
      }

      this.ports.delete(path);
      return WsStatus.OK;
    },

    /*
     * Release every port from JavaScript alone.
     *
     * Called by `HamlibInstance.dispose()` when a native call is stuck: the
     * suspended Asyncify stack owns the module, so nothing may cross Embind,
     * but the port objects are ordinary JavaScript and the device must not be
     * left open.  Best effort by design - the instance is dead either way.
     */
    forceCloseAll(): void {
      this.handles.clear();
      this.pendingPorts.clear();

      for (const record of this.ports.values()) {
        const state = record.state;
        record.state = null;
        record.openCount = 0;

        if (state) {
          state.closed = true;

          if (state.reader) {
            try {
              void state.reader.cancel().catch(() => {
                /* Already closed or errored. */
              });
            } catch {
              /* Nothing left to release. */
            }
          }
        }

        try {
          void Promise.resolve(record.port.close()).catch(() => {
            /* Best effort. */
          });
        } catch {
          /* Best effort. */
        }
      }

      this.ports.clear();
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

    startPump(state: PortState, path: string): Promise<void> {
      const reader = state.reader as ReadableStreamDefaultReader<Uint8Array>;

      return (async () => {
        try {
          for (;;) {
            const result = await reader.read();

            if (result.done) {
              break;
            }

            if (result.value && result.value.length > 0) {
              state.rxBytes += result.value.length;
              this.trace('rx', path, result.value);
              this.queuePush(state.queue, result.value);
              this.wake(state, 'data');

              if (state.queue.length > this.RX_QUEUE_LIMIT) {
                /* Nothing is draining the port: stop reading and report it,
                 * rather than growing a buffer no CAT exchange will consume. */
                const message = `serial receive buffer exceeded ${this.RX_QUEUE_LIMIT} bytes`;
                state.failure = { name: 'Error', message };
                this.recordError('Error', message, 'read');

                try {
                  await reader.cancel();
                } catch {
                  /* The stream may already be closed or errored. */
                }

                break;
              }
            }
          }
        } catch (error) {
          if (!state.closed) {
            const name = (error as { name?: string } | null)?.name ?? 'Error';
            const message = (error as { message?: string } | null)?.message ?? String(error);
            state.failure = { name, message };
            this.recordError(name, message, 'read');
          }
        } finally {
          this.wake(state, 'error');
        }
      })();
    },

    /* --- open/close ----------------------------------------------------- */

    makeState(options: SerialLineSettings, rts: number, dtr: number): PortState {
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
        /* What the transport asserts as it opens: Web Serial leaves both
         * deasserted, `serialport` does not, and the readback must not claim
         * a line the device never saw. */
        lastRts: rts,
        lastDtr: dtr,
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

      return WsStatus.OK;
    },

    /* --- transport primitives called from C ----------------------------- */

    async openPort(
      path: string,
      rate: number,
      dataBits: number,
      stopBits: number,
      parity: string,
      flowControl: string,
    ): Promise<number> {
      const record = this.ports.get(path);

      if (!record) {
        this.recordError('NotFoundError', `serial port ${path} is not registered`, 'open');
        return WsStatus.ERR_INVAL;
      }

      if (record.state) {
        /* A rig may open its CAT and PTT lines on the same physical port. */
        record.openCount++;
        return this.allocHandle(record);
      }

      const options: SerialLineSettings = {
        baudRate: rate,
        dataBits: dataBits as SerialLineSettings['dataBits'],
        stopBits: stopBits as SerialLineSettings['stopBits'],
        parity: parity as SerialLineSettings['parity'],
        flowControl: flowControl as SerialLineSettings['flowControl'],
        bufferSize: 255,
      };

      try {
        await record.port.open(options);
      } catch (error) {
        return this.fail(error, 'open');
      }

      const initial = record.port.initialSignals?.() ?? { rts: false, dtr: false };
      const state = this.makeState(options, initial.rts ? 1 : 0, initial.dtr ? 1 : 0);
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
        return WsStatus.ERR_IO;
      }

      state.pumpPromise = this.startPump(state, record.path);

      return this.allocHandle(record);
    },

    async closePort(handle: number): Promise<number> {
      const entry = this.handles.get(handle);

      if (!entry) {
        return WsStatus.OK;
      }

      this.handles.delete(handle);

      const record = entry.record;
      record.openCount--;

      if (record.openCount > 0) {
        return WsStatus.OK;
      }

      const state = record.state;

      if (!state) {
        return WsStatus.OK;
      }

      return this.teardown(record, state);
    },

    matchesOpenOptions(
      handle: number,
      rate: number,
      dataBits: number,
      stopBits: number,
      parity: string,
      flowControl: string,
    ): number {
      const entry = this.handles.get(handle);

      if (!entry) {
        return WsStatus.ERR_INVAL;
      }

      const options = entry.state.options;

      if (
        options.baudRate === rate
        && options.dataBits === dataBits
        && options.stopBits === stopBits
        && options.parity === parity
        && options.flowControl === flowControl
      ) {
        return 1;
      }

      return 0;
    },

    read(handle: number, ptr: number, len: number): number {
      const entry = this.handles.get(handle);

      if (!entry) {
        return WsStatus.ERR_INVAL;
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
    /*
     * Whether the port opened at `path` stopped delivering: its reader failed,
     * as an unplugged device makes it.  The TypeScript layer reads this to
     * report a rig as no longer connected.
     */
    portLost(path: string): boolean {
      return this.ports.get(path)?.state?.failure != null;
    },

    bytesReceived(handle: number): number {
      const entry = this.handles.get(handle);

      if (!entry) {
        return WsStatus.ERR_INVAL;
      }

      return entry.state.rxBytes;
    },

    write(handle: number, ptr: number, len: number): Promise<number> {
      const entry = this.handles.get(handle);

      if (!entry) {
        return Promise.resolve(WsStatus.ERR_INVAL);
      }

      if (len <= 0) {
        return Promise.resolve(0);
      }

      const state = entry.state;
      /* Copy the outgoing range once, before awaiting the writer. */
      const chunk = HEAPU8.slice(ptr, ptr + len);

      const perform = async (): Promise<number> => {
        try {
          if (!state.writer) {
            state.writer = entry.record.port.writable?.getWriter() ?? null;
          }

          if (!state.writer) {
            this.recordError('InvalidStateError', 'serial port has no writable stream', 'write');
            return WsStatus.ERR_IO;
          }

          await state.writer.write(chunk);
          this.trace('tx', entry.record.path, chunk);
          return len;
        } catch (error) {
          return this.fail(error, 'write');
        }
      };

      const previous = state.writeChain
        ? state.writeChain.then(() => {}, () => {})
        : Promise.resolve();

      state.writeChain = previous.then(perform);
      return state.writeChain;
    },

    waitReadable(handle: number, timeoutMs: number): Promise<number> {
      const entry = this.handles.get(handle);

      if (!entry) {
        return Promise.resolve(WsStatus.ERR_INVAL);
      }

      const state = entry.state;

      if (state.queue.length > 0) {
        return Promise.resolve(1);
      }

      if (state.failure) {
        this.recordError(state.failure.name, state.failure.message, 'read');
        return Promise.resolve(WsStatus.ERR_IO);
      }

      if (state.closed) {
        this.recordError('InvalidStateError', 'serial port is closed', 'read');
        return Promise.resolve(WsStatus.ERR_IO);
      }

      return new Promise<WakeReason>((resolve) => {
        let settled = false;
        let timer: number | undefined;

        const waiter = (why: WakeReason): void => {
          if (settled) {
            return;
          }

          settled = true;
          clearTimeout(timer);
          resolve(why);
        };

        state.waiters.push(waiter);

        if (timeoutMs >= 0) {
          timer = setTimeout(() => {
            waiter('timeout');
          }, timeoutMs);
        }
      }).then((reason) => {
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
          this.recordError(failure.name, failure.message, 'read');
        } else if (state.closed) {
          this.recordError('InvalidStateError', 'serial port is closed', 'read');
        }

        return WsStatus.ERR_IO;
      });
    },

    flush(handle: number): number {
      const entry = this.handles.get(handle);

      if (!entry) {
        return WsStatus.ERR_INVAL;
      }

      this.queueClear(entry.state.queue);
      return WsStatus.OK;
    },

    async setSignals(handle: number, rts: number, dtr: number, brk: number): Promise<number> {
      const entry = this.handles.get(handle);

      if (!entry) {
        return WsStatus.ERR_INVAL;
      }

      const state = entry.state;
      const signals: SerialOutputSignals = {};

      if (rts >= 0) {
        signals.requestToSend = rts !== 0;
      }

      if (dtr >= 0) {
        signals.dataTerminalReady = dtr !== 0;
      }

      if (brk >= 0) {
        signals.break = brk !== 0;
      }

      try {
        await entry.record.port.setSignals(signals);
      } catch (error) {
        return this.fail(error, 'setSignals');
      }

      /* The readback reports what the device accepted, not what was asked:
       * a transport may reject one of the lines. */
      if (rts >= 0) {
        state.lastRts = rts !== 0 ? 1 : 0;
      }

      if (dtr >= 0) {
        state.lastDtr = dtr !== 0 ? 1 : 0;
      }

      return WsStatus.OK;
    },

    async getSignals(handle: number): Promise<number> {
      const entry = this.handles.get(handle);

      if (!entry) {
        return WsStatus.ERR_INVAL;
      }

      try {
        const signals = await entry.record.port.getSignals();
        let mask = 0;

        if (signals.clearToSend) {
          mask |= WsSignal.CTS;
        }

        if (signals.dataSetReady) {
          mask |= WsSignal.DSR;
        }

        if (signals.dataCarrierDetect) {
          mask |= WsSignal.DCD;
        }

        if (signals.ringIndicator) {
          mask |= WsSignal.RI;
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
      return entry ? entry.state.lastRts : WsStatus.ERR_INVAL;
    },

    lastDtr(handle: number): number {
      const entry = this.handles.get(handle);
      return entry ? entry.state.lastDtr : WsStatus.ERR_INVAL;
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
  hamlibWsRegisterPort: (path: number, token: number): number => HamlibWs.registerPort(UTF8ToString(path), token),

  hamlibWsUnregisterPort__deps: ['$HamlibWs'],
  hamlibWsUnregisterPort: (path: number): number => HamlibWs.unregisterPort(UTF8ToString(path)),

  hamlibWsOpenPort__deps: ['$HamlibWs'],
  hamlibWsOpenPort__async: 'auto',
  hamlibWsOpenPort: (
    path: number,
    rate: number,
    dataBits: number,
    stopBits: number,
    parity: number,
    flowControl: number,
  ): Promise<number> => HamlibWs.openPort(
    UTF8ToString(path), rate, dataBits, stopBits, UTF8ToString(parity), UTF8ToString(flowControl),
  ),

  hamlibWsClosePort__deps: ['$HamlibWs'],
  hamlibWsClosePort__async: 'auto',
  hamlibWsClosePort: (handle: number): Promise<number> => HamlibWs.closePort(handle),

  hamlibWsMatchesOpenOptions__deps: ['$HamlibWs'],
  hamlibWsMatchesOpenOptions: (
    handle: number,
    rate: number,
    dataBits: number,
    stopBits: number,
    parity: number,
    flowControl: number,
  ): number => HamlibWs.matchesOpenOptions(
    handle, rate, dataBits, stopBits, UTF8ToString(parity), UTF8ToString(flowControl),
  ),

  hamlibWsRead__deps: ['$HamlibWs'],
  hamlibWsRead: (handle: number, ptr: number, len: number): number => HamlibWs.read(handle, ptr, len),

  hamlibWsBytesReceived__deps: ['$HamlibWs'],
  hamlibWsBytesReceived: (handle: number): number => HamlibWs.bytesReceived(handle),

  hamlibWsWrite__deps: ['$HamlibWs'],
  hamlibWsWrite__async: 'auto',
  hamlibWsWrite: (handle: number, ptr: number, len: number): Promise<number> => HamlibWs.write(handle, ptr, len),

  hamlibWsWaitReadable__deps: ['$HamlibWs'],
  hamlibWsWaitReadable__async: 'auto',
  hamlibWsWaitReadable: (handle: number, timeoutMs: number): Promise<number> => HamlibWs.waitReadable(handle, timeoutMs),

  hamlibWsFlush__deps: ['$HamlibWs'],
  hamlibWsFlush: (handle: number): number => HamlibWs.flush(handle),

  hamlibWsSetSignals__deps: ['$HamlibWs'],
  hamlibWsSetSignals__async: 'auto',
  hamlibWsSetSignals: (handle: number, rts: number, dtr: number, brk: number): Promise<number> => HamlibWs.setSignals(handle, rts, dtr, brk),

  hamlibWsGetSignals__deps: ['$HamlibWs'],
  hamlibWsGetSignals__async: 'auto',
  hamlibWsGetSignals: (handle: number): Promise<number> => HamlibWs.getSignals(handle),

  hamlibWsLastRts__deps: ['$HamlibWs'],
  hamlibWsLastRts: (handle: number): number => HamlibWs.lastRts(handle),

  hamlibWsLastDtr__deps: ['$HamlibWs'],
  hamlibWsLastDtr: (handle: number): number => HamlibWs.lastDtr(handle),

  hamlibWsWriteLastError__deps: ['$HamlibWs'],
  hamlibWsWriteLastError: (ptr: number, len: number): number => HamlibWs.writeLastError(ptr, len),

  hamlibWsLog__deps: ['$HamlibWs'],
  hamlibWsLog: (level: number, message: number): void => {
    HamlibWs.log(level, UTF8ToString(message));
  },

  hamlibWsClearLastError__deps: ['$HamlibWs'],
  hamlibWsClearLastError: (): number => HamlibWs.clearLastError(),

  hamlibWsForceCloseAll__deps: ['$HamlibWs'],
  hamlibWsForceCloseAll: (): number => {
    HamlibWs.forceCloseAll();
    return 0;
  },
});
