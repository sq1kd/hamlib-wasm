/**
 * Virtual time for the Node checks that exercise a timeout.
 *
 * The browser suite's page clock (tests/browser/fixtures/virtual-clock.ts) has
 * a Node counterpart in vitest's fake timers: with them installed, Hamlib's
 * sleeps and read timeouts (Emscripten's `setTimeout`), the library's call
 * watchdog and every clock the module reads (`Date`, `performance.now()`) are
 * virtual, so a timeout costs exactly its budget of virtual time and never
 * races the machine's load.  `setImmediate` and `process.nextTick` stay real:
 * they carry the `serialport` stream's I/O, which takes no time at all.
 */
import { vi } from 'vitest';

/** Put timers and clocks on virtual time until {@link useRealTime}. */
export function useVirtualTime(): void {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'],
  });
}

export function useRealTime(): void {
  vi.useRealTimers();
}

/**
 * Fire timers in deadline order until `promise` settles; return its outcome.
 *
 * Each step first lets pending I/O run, so a timer never fires while a reply
 * it could have raced is still on its way.  With no timer pending, time does
 * not move: the step just yields to that I/O.
 */
export async function settle<T>(promise: Promise<T>): Promise<T> {
  let done = false;
  const observed = promise.then(
    () => { done = true; },
    () => { done = true; },
  );

  while (!done) {
    if (vi.getTimerCount() > 0) {
      await vi.advanceTimersToNextTimerAsync();
    } else {
      await Promise.race([observed, new Promise<void>((resolve) => { setImmediate(resolve); })]);
    }
  }

  return promise;
}
