/** The long poll: who sleeps on a session, and what wakes them. */
import { MAX_LONG_POLL_WAIT_MS, type SessionInfo } from "../../types.js";
import type { SessionRuntime } from "./core.js";
import { signalOf } from "./session-view.js";

const MAX_WAITERS_PER_SESSION = 4;

/**
 * Wait until the session state a caller acts on changes, or `timeoutMs`
 * elapses (whichever comes first). `notifyWaiters` decides what counts.
 *
 * Rejects with an error when more than MAX_WAITERS_PER_SESSION concurrent
 * waiters are already queued for the same session.
 */
export function waitForChange(
  runtime: SessionRuntime,
  sessionId: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      resolve();
      return;
    }

    const known = runtime.sessionNotifiers.get(sessionId);
    const notifiers = known ?? new Set<() => void>();
    if (!known) {
      runtime.sessionNotifiers.set(sessionId, notifiers);
    }
    if (notifiers.size >= MAX_WAITERS_PER_SESSION) {
      reject(
        new Error(
          `[codex-mcp] Too many concurrent long-poll waiters for session '${sessionId}' (max ${MAX_WAITERS_PER_SESSION})`
        )
      );
      return;
    }

    const clampedMs = Math.min(Math.max(0, timeoutMs), MAX_LONG_POLL_WAIT_MS);

    const done = (): void => {
      notifiers.delete(notifyFn);
      if (notifiers.size === 0) runtime.sessionNotifiers.delete(sessionId);
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    };

    const notifyFn = done;
    const timer = setTimeout(done, clampedMs);
    if (timer.unref) timer.unref();

    const onAbort = (): void => done();
    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    notifiers.add(notifyFn);
  });
}

/**
 * Take a session into the store with the signal it starts on, so the first
 * change of it is what wakes a waiter rather than the first notification.
 */
export function registerSession(runtime: SessionRuntime, session: SessionInfo): void {
  runtime.sessions.set(session.sessionId, session);
  runtime.lastNotifiedSignal.set(session.sessionId, signalOf(session));
}

/**
 * Wake the long-poll waiters of a session, for what they act on and for what
 * they report: the status, the set of open actions, the result of a finished
 * turn, and each new line the turn says it is working on.
 *
 * Nothing else wakes them. A measured run of ten parallel sessions delivered
 * 20.2% agent-message deltas and 25.7% token-counter updates; waking on those
 * turned a 120s long poll into a 4.8s median round trip and put the whole
 * transcript through the caller's context. Those move `signalOf` not at all,
 * so a waiter sleeps through them, while the handful of activity lines a turn
 * writes each move it once.
 */
export function notifyWaiters(runtime: SessionRuntime, sessionId: string): void {
  const session = runtime.sessions.get(sessionId);
  const signal = session ? signalOf(session) : `gone:${sessionId}`;
  if (runtime.lastNotifiedSignal.get(sessionId) === signal) return;
  runtime.lastNotifiedSignal.set(sessionId, signal);

  const notifiers = runtime.sessionNotifiers.get(sessionId);
  if (!notifiers || notifiers.size === 0) return;
  // Snapshot to avoid mutation issues during iteration
  for (const fn of Array.from(notifiers)) {
    fn();
  }
}

// ── Status ───────────────────────────────────────────────────────
