/**
 * orphan-reaper — reaps orphaned codex child processes left over from a
 * previous server run.
 *
 * The startup sweep hands it the sessions it adopted: those whose owner is
 * gone. A session another server still holds never reaches here, so its live
 * codex process is never signalled.
 *
 * For each adopted session that still has a pid.json this module verifies
 * whether the process runs and whether it is the one the record names (a pid is
 * handed on as soon as its process exits). Confirmed orphans are terminated
 * gracefully with a five-second window, then forcefully killed if still alive.
 *
 * Both clients spawn codex with `detached: true` on POSIX, so the orphan leads
 * a process group holding whatever it started itself. The signal goes to that
 * group, as the clients' own cleanup does, and on Windows `taskkill /T` takes
 * the child tree.
 */
import { spawn } from "node:child_process";
import type { RecoveredSession } from "../persistence/index.js";
import {
  UNKNOWN_PROCESS,
  identifyProcess,
  probePid,
  type ProcessCheck,
} from "../persistence/process-identity.js";

export interface ReapSummary {
  /** Orphans whose exit this run confirmed: the pid is gone, or it now names another process. */
  reaped: number;
  /** Sessions whose recorded pid was already gone before any signal was sent. */
  alreadyDead: number;
  /** Orphans that were signalled and whose exit no source confirmed — they may still run. */
  unconfirmed: number;
  /** Sessions no signal was sent for: the identity of the live pid was unmatched or unverifiable. */
  skipped: number;
}

// ── Signal helpers ───────────────────────────────────────────────────

/**
 * Signal the whole process group when the orphan leads one, as the clients'
 * own cleanup does; the codex children sit in that group and survive a signal
 * addressed to the leader alone.  Falls back to the leader when the group is
 * unconfirmed or has gone away.
 */
function sendPosix(pid: number, leadsGroup: boolean, signal: NodeJS.Signals): void {
  if (leadsGroup) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // The group went away between the check and the signal; try the leader.
    }
  }
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone.
  }
}

function sendGraceful(pid: number, leadsGroup: boolean): void {
  if (process.platform !== "win32") {
    sendPosix(pid, leadsGroup, "SIGTERM");
    return;
  }
  try {
    // /T takes the child tree, which the parent links of the verified PID name.
    spawn("taskkill", ["/PID", String(pid), "/T"], {
      stdio: "ignore",
      windowsHide: true,
    });
  } catch {
    // Already gone.
  }
}

function sendForce(pid: number, leadsGroup: boolean): void {
  if (process.platform !== "win32") {
    sendPosix(pid, leadsGroup, "SIGKILL");
    return;
  }
  try {
    spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
  } catch {
    // Already gone.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (t.unref) t.unref();
  });
}

// ── One session ──────────────────────────────────────────────────────

/** What one session's recorded pid ended up counting as. */
type ReapOutcome = keyof ReapSummary;

/**
 * What the probes made before any signal establish about the recorded pid:
 * gone already, unverifiable, or an orphan of ours.
 */
function identifyOrphan(
  session: RecoveredSession,
  pid: number,
  spawnedAt: string
): "alreadyDead" | "skipped" | "confirmed" {
  const atStart = probePid(pid);
  if (atStart === "dead") return "alreadyDead";
  if (atStart === "unknown") {
    console.error(
      `[orphan-reaper] Liveness of PID ${pid} (session ${session.sessionId}) could not be` +
        ` determined — sending no signal. Skipping.`
    );
    return "skipped";
  }

  const atCheck = identifyProcess(pid, spawnedAt);
  if (atCheck.identity !== "match") {
    console.error(
      `[orphan-reaper] PID ${pid} (session ${session.sessionId}) is alive but` +
        (atCheck.identity === "mismatch"
          ? ` does not match stored spawn time — likely a reused PID. Skipping.`
          : ` no source reported its start time — cannot confirm its identity. Skipping.`)
    );
    return "skipped";
  }
  return "confirmed";
}

/**
 * Re-verify identity immediately before sending a signal (close TOCTOU window).
 *
 * "dead" says it exited on its own between the two probes, so no signal was sent.
 */
function reconfirmBeforeSignal(pid: number, spawnedAt: string): ProcessCheck | "dead" {
  const beforeGraceful = probePid(pid);
  if (beforeGraceful === "dead") return "dead";
  return beforeGraceful === "alive" ? identifyProcess(pid, spawnedAt) : UNKNOWN_PROCESS;
}

/** Poll for up to 5 seconds, the window a confirmed orphan is given to exit on its own. */
async function awaitGracefulExit(pid: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (probePid(pid) === "alive" && Date.now() < deadline) {
    await sleep(250);
  }
}

/**
 * Force kill the pid still alive after the graceful window, when it is still ours.
 *
 * The window is long enough for the leader to exit and its PID to be handed to
 * something else, so the identity is checked again before the force signal —
 * which on POSIX reaches a whole process group. Returns the outcome when the
 * identity check settled the session, and undefined when a signal went out.
 */
async function forceKillIfStillOurs(
  pid: number,
  spawnedAt: string
): Promise<ReapOutcome | undefined> {
  const atForce = identifyProcess(pid, spawnedAt);
  if (atForce.identity === "mismatch") {
    // A source read a start time and it is another process's: the orphan
    // exited during the graceful window and its pid was handed on.
    console.error(
      `[orphan-reaper] PID ${pid} now reports another start time than the stored one —` +
        ` the orphan exited and its pid was reused. Not force killing.`
    );
    return "reaped";
  }
  if (atForce.identity === "unknown") {
    // No source answered, so nothing separates an exited orphan from one
    // that is still running. Both leave the outcome unconfirmed.
    console.error(
      `[orphan-reaper] PID ${pid} is alive after the graceful terminate and no source` +
        ` reported its start time — cannot confirm it is the orphan. Not force killing;` +
        ` the process may still be running.`
    );
    return "unconfirmed";
  }
  console.error(
    `[orphan-reaper] PID ${pid} did not exit after graceful terminate — force killing.`
  );
  sendForce(pid, atForce.leadsGroup);
  // Give the OS a moment to act.
  await sleep(500);
  return undefined;
}

/** What the last probe says the termination attempt achieved. */
function confirmExit(session: RecoveredSession, pid: number): ReapOutcome {
  const atEnd = probePid(pid);
  if (atEnd === "dead") return "reaped";
  console.error(
    `[orphan-reaper] PID ${pid} (session ${session.sessionId}) is still ${atEnd === "alive" ? "running" : "of undetermined liveness"}` +
      ` after the termination attempt — its exit is unconfirmed.`
  );
  return "unconfirmed";
}

/** Reap the process one recovered session recorded, and say what became of it. */
async function reapSession(session: RecoveredSession): Promise<ReapOutcome> {
  const { pid, spawnedAt } = session.pidInfo!;

  const identified = identifyOrphan(session, pid, spawnedAt);
  if (identified !== "confirmed") return identified;

  const atGraceful = reconfirmBeforeSignal(pid, spawnedAt);
  if (atGraceful === "dead") return "alreadyDead";
  if (atGraceful.identity !== "match") return "skipped";

  // Confirmed orphan — attempt graceful termination.
  console.error(
    `[orphan-reaper] Sending graceful terminate to orphan ${atGraceful.leadsGroup ? `process group ${pid}` : `PID ${pid}`}` +
      ` (session ${session.sessionId}).`
  );
  sendGraceful(pid, atGraceful.leadsGroup);

  await awaitGracefulExit(pid);

  if (probePid(pid) === "alive") {
    const forced = await forceKillIfStillOurs(pid, spawnedAt);
    if (forced !== undefined) return forced;
  }

  return confirmExit(session, pid);
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Reap any orphaned processes referenced by the recovered sessions.
 *
 * For each session that has a `pidInfo` field:
 *   1. Check if the PID is alive.
 *   2. If alive, verify it is the same process (not a reused PID) and whether
 *      it leads its own process group.
 *   3. If confirmed orphan: graceful terminate → 5 s wait → force kill, each
 *      addressed to the group when the orphan leads one.
 *   4. Count what the probes established, not what was attempted: `reaped`
 *      only where the pid is gone or now names another process, `unconfirmed`
 *      where a signalled orphan may still run, `skipped` where nothing was sent.
 *
 * @param recovered  Sessions returned by the recovery scanner.
 * @returns Summary of { reaped, alreadyDead, unconfirmed, skipped }.
 */
export async function reapOrphanProcesses(recovered: RecoveredSession[]): Promise<ReapSummary> {
  const summary: ReapSummary = { reaped: 0, alreadyDead: 0, unconfirmed: 0, skipped: 0 };

  const candidates = recovered.filter((s) => s.pidInfo !== null);
  if (candidates.length === 0) return summary;

  await Promise.all(
    candidates.map(async (session) => {
      summary[await reapSession(session)]++;
    })
  );
  return summary;
}
