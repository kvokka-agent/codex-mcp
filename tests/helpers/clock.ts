/**
 * The clock a test measures on, and the readings of the real one a fixture is
 * still allowed to take.
 *
 * A real `setTimeout(f, 40)` runs on libuv's millisecond loop clock, which is
 * not the one `Date.now()` reads: measured over 10000 waits under a 12-way CPU
 * load, 19 of them fired with a `Date.now()` delta under 40ms, the shortest 31.
 * A test that asserts on a real duration therefore fails on the runner's luck
 * rather than on a defect, so a test file reads no clock of its own — `eslint`
 * holds it to that — and drives the fake one from here instead, where a wait of
 * 40ms is 40ms exactly.
 */
import { jest } from "bun:test";

export interface FakeClock {
  /** Move the clock on, and let every timer and promise it wakes run. */
  advance(ms: number): Promise<void>;
  /** How far the clock has moved since this one was installed. */
  elapsedMs(): number;
}

/**
 * How many pieces `advanceAsync` cuts a window into.
 *
 * `jest.advanceTimersByTime` runs the callbacks it wakes synchronously, so a
 * timer that a promise continuation schedules is not on the queue while that
 * advance is still running: the continuation cannot run until the microtask
 * queue drains, and by then the window is over. Advancing in pieces and
 * draining between them puts such a timer back inside the window it belongs
 * to. The count is fixed rather than the step, so a window of a minute costs
 * the same sixteen rounds as a window of ten milliseconds.
 */
const ADVANCE_PIECES = 16;

/** Let everything already queued as a microtask run. */
async function drainMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

/**
 * Move the fake clock on by `ms`, letting the timers and the promises they
 * wake run.
 *
 * `bun:test` carries the synchronous `advanceTimersByTime` alone, so the wait
 * for what it wakes is assembled here.
 */
export async function advanceAsync(ms: number): Promise<void> {
  const piece = Math.max(1, Math.ceil(ms / ADVANCE_PIECES));
  let left = ms;
  await drainMicrotasks();
  while (left > 0) {
    const step = Math.min(piece, left);
    jest.advanceTimersByTime(step);
    left -= step;
    await drainMicrotasks();
  }
}

/**
 * Install the fake timers and hand back the clock they run on.
 *
 * The caller puts `jest.useRealTimers()` in its `afterEach`, as the rest of
 * this suite already does.
 */
export function useFakeClock(): FakeClock {
  jest.useFakeTimers();
  const startedAt = Date.now();
  return {
    advance: advanceAsync,
    elapsedMs: () => Date.now() - startedAt,
  };
}

/** Epoch milliseconds `ms` before now, for a fixture dated relative to this run. */
export function msAgo(ms: number): number {
  return Date.now() - ms;
}

/** The same instant as an ISO timestamp, for a fixture that has to read as stale. */
export function isoMsAgo(ms: number): string {
  return new Date(msAgo(ms)).toISOString();
}

/** How long ago an ISO timestamp is, by the wall clock that wrote it. */
export function msSince(iso: string): number {
  return Date.now() - Date.parse(iso);
}

/**
 * Read until the value is one `accept` takes, and throw when it never is.
 *
 * The deadline is wall-clock because what it waits for is a real child process
 * reaching a real state; nothing is asserted about how long that took.
 */
export async function pollUntil<T>(
  read: () => Promise<T> | T,
  accept: (value: T) => boolean,
  timeoutMs = 10_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T = await read();
  while (Date.now() < deadline) {
    if (accept(last)) return last;
    await new Promise((r) => setTimeout(r, 100));
    last = await read();
  }
  throw new Error(`condition never held; last value: ${JSON.stringify(last)}`);
}
