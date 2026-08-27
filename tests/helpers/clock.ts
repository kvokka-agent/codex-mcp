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
import { vi } from "vitest";

export interface FakeClock {
  /** Move the clock on, and let every timer and promise it wakes run. */
  advance(ms: number): Promise<void>;
  /** How far the clock has moved since this one was installed. */
  elapsedMs(): number;
}

/**
 * Install vitest's fake timers and hand back the clock they run on.
 *
 * The caller puts `vi.useRealTimers()` in its `afterEach`, as the rest of this
 * suite already does.
 */
export function useFakeClock(): FakeClock {
  vi.useFakeTimers();
  const startedAt = Date.now();
  return {
    advance: (ms: number) => vi.advanceTimersByTimeAsync(ms),
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
