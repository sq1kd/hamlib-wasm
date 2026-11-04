/**
 * Playwright fixture: a virtual clock for the page.
 *
 * Compiled to `generated/virtual-clock.js` by the neighbouring tsconfig.json
 * and injected as *text* before any page script (see tests/browser/fixtures.ts),
 * so every timer the page creates - Emscripten's Asyncify sleeps, the Web
 * Serial glue's read timeouts, the library's watch scheduler and call watchdog,
 * the emulator's reply delay - and every clock it reads (`Date`,
 * `performance.now()`, and through them Hamlib's `clock_gettime()`) runs on
 * virtual time.
 *
 * Virtual time never follows the wall clock.  It only moves when a timer is
 * fired, and it moves exactly to that timer's deadline, so what a scenario
 * observes depends on the deadlines and the order of events, never on how fast
 * the machine runs it.  Between two timers the page is drained: the fixture
 * hops over one real macrotask, which runs only once every microtask is done -
 * and everything the emulator does is promise (microtask) driven - so a timer
 * never fires while I/O it could have raced is still in flight.
 *
 * Two modes:
 *
 *  - `auto` (the default): whenever the page is drained, the earliest timer
 *    fires.  A scenario that runs inside one `page.evaluate()` just awaits;
 *    `advance(ms)` lets a stated span of virtual time pass, firing everything
 *    due within it in deadline order.
 *  - `manual`: time does not move unless the spec asks - `advance(ms)` runs a
 *    span, `settle(promise)` and `until(predicate)` run timers in order until
 *    the condition holds.  Work due at the current instant (a zero-delay
 *    timeout, a React render) still runs.  For pages a spec drives across
 *    several `page.evaluate()` calls while timers are pending - the React hooks
 *    poll on an interval, and a call parked on a gate the spec controls has its
 *    watchdog armed - where letting time run while the page merely waits for
 *    the driver would be a race.
 *
 * Every driving call returns only once the work due at the instant it stopped
 * has run, so the next `page.evaluate()` observes a settled page.
 *
 * A spec drives it through `window.__virtualClock`.
 */

(function installVirtualClock() {
  var RealDate = Date;
  var channel = new MessageChannel();

  /** The wall-clock instant virtual time 0 maps to (fixed, so runs agree). */
  var EPOCH = RealDate.UTC(2025, 0, 1);

  /**
   * Virtual milliseconds since the page started.  Not zero: Hamlib treats an
   * all-zero timestamp as "never set".
   */
  var now = 1000;

  var nextId = 1;
  var nextSequence = 1;
  var mode: VirtualClockMode = 'auto';

  /** Driving calls in progress; the background loop stands aside meanwhile. */
  var driving = 0;
  var backgroundRunning = false;

  var timers = new Map<number, VirtualTimer>();

  /** Resolvers waiting for the next real macrotask. */
  var hopWaiters: Array<() => void> = [];

  /** Resolvers waiting for a timer to be scheduled. */
  var scheduleWaiters: Array<() => void> = [];

  channel.port1.onmessage = function (): void {
    var waiters = hopWaiters;

    hopWaiters = [];

    for (var i = 0; i < waiters.length; i++) { waiters[i]!(); }
  };

  /**
   * Resolve after one real macrotask: by then every microtask queued before it
   * has run, so every promise chain the last timer started has gone as far as
   * it can without another timer.
   */
  function hop(): Promise<void> {
    var gate = Promise.withResolvers<void>();

    hopWaiters.push(gate.resolve);

    if (hopWaiters.length === 1) { channel.port2.postMessage(null); }

    return gate.promise;
  }

  /** Resolve once some timer is scheduled. */
  function nextSchedule(): Promise<void> {
    var gate = Promise.withResolvers<void>();

    scheduleWaiters.push(gate.resolve);
    return gate.promise;
  }

  function schedule(
    handler: TimerHandler,
    delay: number | undefined,
    args: unknown[],
    repeat: boolean,
  ): number {
    if (typeof handler !== 'function') {
      throw new TypeError('the virtual clock only schedules function callbacks');
    }

    var callback = handler as (...values: unknown[]) => void;

    var wait = Math.max(0, Number(delay) || 0);

    /* A zero-period interval would fire forever at one instant. */
    if (repeat && wait < 1) { wait = 1; }

    var id = nextId++;

    timers.set(id, {
      id: id,
      callAt: now + wait,
      sequence: nextSequence++,
      period: repeat ? wait : 0,
      callback: callback,
      args: args,
    });

    var waiters = scheduleWaiters;

    scheduleWaiters = [];

    for (var i = 0; i < waiters.length; i++) { waiters[i]!(); }

    startBackground();
    return id;
  }

  function cancel(id: number | undefined): void {
    if (id !== undefined) { timers.delete(Number(id)); }
  }

  /** The timer due first, among those due at or before `limit`. */
  function earliest(limit: number): VirtualTimer | null {
    var first: VirtualTimer | null = null;

    timers.forEach(function (timer) {
      if (timer.callAt > limit) { return; }

      if (
        first === null
        || timer.callAt < first.callAt
        || (timer.callAt === first.callAt && timer.sequence < first.sequence)
      ) {
        first = timer;
      }
    });

    return first;
  }

  /** Fire the earliest timer due by `limit`; false when there is none. */
  function fireNext(limit: number): boolean {
    var timer = earliest(limit);

    if (timer === null) { return false; }

    if (timer.callAt > now) { now = timer.callAt; }

    if (timer.period > 0) {
      timer.callAt += timer.period;
      timer.sequence = nextSequence++;
    } else {
      timers.delete(timer.id);
    }

    try {
      timer.callback.apply(window, timer.args);
    } catch (error) {
      /* What the browser does with a throwing timer callback. */
      reportError(error);
    }

    return true;
  }

  /**
   * The background loop: fire timers one at a time, each once the page has
   * drained.  In `auto` mode that is every timer, in deadline order; in
   * `manual` mode only those already due, so work queued for "now" (a
   * zero-delay timeout, React's scheduler) still runs but time stands still.
   */
  async function runBackground(): Promise<void> {
    backgroundRunning = true;

    try {
      while (driving === 0 && earliest(backgroundLimit()) !== null) {
        await hop();

        if (driving !== 0) { break; }

        fireNext(backgroundLimit());
      }
    } finally {
      backgroundRunning = false;
    }
  }

  function backgroundLimit(): number {
    return mode === 'auto' ? Infinity : now;
  }

  function startBackground(): void {
    if (!backgroundRunning && driving === 0 && earliest(backgroundLimit()) !== null) {
      void runBackground();
    }
  }

  /** Fire every timer due at the current instant, without moving time. */
  async function drainDue(): Promise<void> {
    do {
      await hop();
    } while (fireNext(now));
  }

  /**
   * Fire timers in deadline order until `done()` holds, checking it every time
   * the page has drained; then fire whatever is due at that instant.
   *
   * With no timer pending, time does not move: the clock waits for `wake` or
   * for a timer to be scheduled.
   */
  async function drive(done: () => boolean, wake: Promise<unknown> | null): Promise<void> {
    driving += 1;

    try {
      for (;;) {
        await hop();

        if (done()) { break; }

        if (!fireNext(Infinity)) {
          await (wake === null ? nextSchedule() : Promise.race([wake, nextSchedule()]));
        }
      }

      await drainDue();
    } finally {
      driving -= 1;
      startBackground();
    }
  }

  /** Let `ms` of virtual time pass, firing every timer due in it, in order. */
  async function advance(ms: number): Promise<void> {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new Error('advance() takes a non-negative number of milliseconds');
    }

    var target = now + ms;

    driving += 1;

    try {
      do {
        await hop();
      } while (fireNext(target));

      now = target;
      await drainDue();
    } finally {
      driving -= 1;
      startBackground();
    }
  }

  /** Fire timers, in order, until `promise` settles; resolve to its outcome. */
  async function settle<T>(promise: Promise<T>): Promise<T> {
    var done = false;
    var settled = promise.then(
      function () { done = true; },
      function () { done = true; },
    );

    await drive(function () { return done; }, settled);
    return promise;
  }

  /** Fire timers, in order, until `predicate()` holds. */
  function until(predicate: () => boolean): Promise<void> {
    return drive(predicate, null);
  }

  /* `Date` reads virtual time; every other use of the constructor is real. */
  var VirtualDate = function (this: unknown, ...values: unknown[]): unknown {
    if (!new.target) { return new RealDate(EPOCH + now).toString(); }

    if (values.length === 0) { return new RealDate(EPOCH + now); }

    return Reflect.construct(RealDate, values);
  } as unknown as DateConstructor;

  /* Shared, so `instanceof Date` and every method keep working. */
  (VirtualDate as { prototype: Date }).prototype = RealDate.prototype;
  VirtualDate.now = function (): number { return EPOCH + now; };
  VirtualDate.parse = RealDate.parse;
  VirtualDate.UTC = RealDate.UTC;

  window.Date = VirtualDate;

  Object.defineProperty(performance, 'now', {
    configurable: true,
    value: function (): number { return now; },
  });

  window.setTimeout = function (
    handler: TimerHandler,
    delay?: number,
    ...args: unknown[]
  ): number {
    return schedule(handler, delay, args, false);
  } as typeof window.setTimeout;

  window.setInterval = function (
    handler: TimerHandler,
    delay?: number,
    ...args: unknown[]
  ): number {
    return schedule(handler, delay, args, true);
  } as typeof window.setInterval;

  window.clearTimeout = cancel;
  window.clearInterval = cancel;

  /* React's scheduler prefers `setImmediate` to a MessageChannel when it
   * exists, so with this its renders and effects are timers like any other:
   * ordered with the rest of the page, and run before an advance returns. */
  var immediateWindow = window as unknown as {
    setImmediate(callback: (...values: unknown[]) => void, ...args: unknown[]): number;
    clearImmediate(id: number): void;
  };

  immediateWindow.setImmediate = function (callback, ...args): number {
    return schedule(callback, 0, args, false);
  };
  immediateWindow.clearImmediate = cancel;

  window.__virtualClock = {
    now: function (): number { return now; },
    get mode(): VirtualClockMode { return mode; },
    set mode(value: VirtualClockMode) {
      mode = value;
      startBackground();
    },
    pendingTimers: function (): number { return timers.size; },
    advance: advance,
    settle: settle,
    until: until,
  };
})();
