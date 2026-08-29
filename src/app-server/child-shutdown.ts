/**
 * Stopping a codex child process: the wait both clients do after they have
 * asked it to go away.
 */
import type { ChildProcess } from "node:child_process";

/** How long a child gets to answer the first signal before `forceKill` runs. */
const FORCE_KILL_TIMEOUT_MS = 5_000;

/**
 * Wait for `proc` to exit, running `forceKill` if it has not gone by then.
 *
 * The caller has already signalled the child. A child that never reports `exit`
 * — its pipes are gone, or it is a process group the signal did not reach —
 * must not hold the caller open, so a second timer resolves the wait a second
 * after the force-kill. Both timers are `unref`'d: a pending timer keeps this
 * process alive, and `destroy()` runs on the way out.
 *
 * @param alreadyExited The child had already exited when the caller signalled
 *   it, so no `exit` event is coming and there is nothing to wait for.
 */
export async function awaitChildExit(
  proc: ChildProcess,
  alreadyExited: boolean,
  forceKill: () => void
): Promise<void> {
  const forceKillTimer = setTimeout(forceKill, FORCE_KILL_TIMEOUT_MS);
  forceKillTimer.unref();
  if (alreadyExited) return;

  await new Promise<void>((resolve) => {
    proc.on("exit", () => {
      clearTimeout(forceKillTimer);
      resolve();
    });
    const fallback = setTimeout(resolve, FORCE_KILL_TIMEOUT_MS + 1_000);
    fallback.unref();
  });
}
