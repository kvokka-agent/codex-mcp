/**
 * orphan-reaper — reaps orphaned codex child processes left over from a
 * previous server run.
 *
 * On startup the recovery scanner surfaces sessions that still have a
 * pid.json file.  This module verifies whether each such process is still
 * running and, if so, whether it genuinely belongs to the previous server
 * invocation (guards against PID reuse).  Confirmed orphans are terminated
 * gracefully (SIGTERM / taskkill) with a 5-second window, then forcefully
 * killed if still alive.
 *
 * Both clients spawn codex with `detached: true` on POSIX, so the orphan leads
 * a process group holding whatever it started itself.  The signal goes to that
 * group, as the clients' own cleanup does, and on Windows `taskkill /T` takes
 * the child tree.
 */
import { execSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { uptime } from "node:os";
import type { RecoveredSession } from "../persistence/index.js";

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

// ── Liveness check ───────────────────────────────────────────────────

/** What `process.kill(pid, 0)` could establish about a pid. */
type Liveness = "alive" | "dead" | "unknown";

/**
 * Probe whether a process with the given PID runs.
 *
 * `process.kill(pid, 0)` raises ESRCH for a pid no process holds and EPERM when
 * the process runs under a user this one may not signal — EPERM is a live
 * process. Any other errno leaves liveness unknown, and an unknown pid is never
 * counted as reaped.
 */
function probePid(pid: number): Liveness {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "dead";
    if (code === "EPERM") return "alive";
    return "unknown";
  }
}

// ── Start-time helpers ───────────────────────────────────────────────

/**
 * On Windows: read the process creation time from WMI.
 * Returns null when the process is gone or no query tool answers.
 */
function getWindowsCreationTimeMs(pid: number): number | null {
  // PowerShell first: wmic is disabled by default from Windows 11 24H2 and absent from Server 2025.
  const viaPowerShell = getPowerShellCreationTimeMs(pid);
  if (viaPowerShell !== null) return viaPowerShell;
  return getWmicCreationTimeMs(pid);
}

/**
 * Ask CIM for Win32_Process.CreationDate, printed as an ISO 8601 round-trip
 * string ("o") so the offset travels with it.
 * Returns null when powershell.exe is absent, the process is gone (the query
 * then prints nothing) or the output does not parse.
 */
function getPowerShellCreationTimeMs(pid: number): number | null {
  try {
    const raw = execSync(
      `powershell.exe -NoProfile -NonInteractive -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CreationDate.ToUniversalTime().ToString('o')"`,
      { stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }
    )
      .toString()
      .trim();
    if (!raw) return null;
    const ms = new Date(raw).getTime();
    return Number.isNaN(ms) ? null : ms;
  } catch {
    return null;
  }
}

/**
 * Ask wmic for the process creation time, formatted as
 * "YYYYMMDDHHmmss.ffffff+ZZZ" where ZZZ is the offset from UTC in minutes.
 * Returns null on any error (process gone, access denied, wmic absent) and
 * when the offset is missing, which leaves the zone of the digits unknown.
 */
function getWmicCreationTimeMs(pid: number): number | null {
  try {
    const raw = execSync(`wmic process where "ProcessId=${pid}" get CreationDate /value`, {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).toString();
    const match = raw.match(/CreationDate=(\d{14})\.\d+([+-]\d{1,4})/);
    if (!match || !match[1] || !match[2]) return null;
    const s = match[1];
    const iso = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}.000Z`;
    const ms = new Date(iso).getTime();
    if (Number.isNaN(ms)) return null;
    return ms - Number(match[2]) * 60_000;
  } catch {
    return null;
  }
}

// Every mainstream Linux build compiles USER_HZ as 100; on a kernel built with
// another value the computed start time misses and the PID is skipped, never killed.
const USER_HZ = 100;

/** What a POSIX source reports about a live PID. */
interface LiveProcess {
  /** Epoch milliseconds at which the process started. */
  startMs: number;
  /** Process group id, or null when the source did not report one. */
  pgid: number | null;
}

/**
 * On Linux: read /proc/{pid}/stat for field 5 (pgrp) and field 22 (start time
 * in clock ticks since boot, turned into an epoch timestamp).
 * Returns null when the file, the start tick or the boot time is unavailable.
 */
function readProcStat(pid: number): LiveProcess | null {
  let pgrp: number;
  let ticks: number;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    // Field 2 is the executable name in parentheses and may itself hold spaces
    // and ')', so the remaining fields are split after the last ')'.
    const fields = stat
      .slice(stat.lastIndexOf(")") + 1)
      .trim()
      .split(/\s+/);
    // fields[0] is field 3 (state), so field 5 (pgrp) sits at index 2 and
    // field 22 (starttime) at index 19.
    pgrp = Number(fields[2]);
    ticks = Number(fields[19]);
  } catch {
    return null;
  }
  if (!Number.isFinite(ticks) || ticks < 0) return null;

  const bootMs = getBootTimeMs();
  if (bootMs === null) return null;
  return {
    startMs: bootMs + (ticks / USER_HZ) * 1000,
    pgid: Number.isInteger(pgrp) && pgrp > 0 ? pgrp : null,
  };
}

/**
 * Epoch milliseconds of the last boot, from the `btime` line of /proc/stat
 * (whole seconds) or, where that is unreadable, from the uptime the kernel
 * reports now.  Returns null when neither answers.
 */
function getBootTimeMs(): number | null {
  try {
    const match = readFileSync("/proc/stat", "utf-8").match(/^btime\s+(\d+)$/m);
    if (match?.[1]) {
      const seconds = Number(match[1]);
      if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
    }
  } catch {
    // Fall through to the uptime reading.
  }
  try {
    const seconds = uptime();
    if (Number.isFinite(seconds) && seconds > 0) return Date.now() - seconds * 1000;
  } catch {
    // Neither source answered.
  }
  return null;
}

/** Run `ps -p PID -o FORMAT` and return its trimmed output, or null on failure. */
function runPs(pid: number, format: string): string | null {
  try {
    const output = execSync(`ps -p ${pid} -o ${format}`, {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    })
      .toString()
      .trim();
    return output === "" ? null : output;
  } catch {
    return null;
  }
}

/**
 * Read the start time and the process group of a live PID.
 *
 * `ps` answers first — it is the only source of either on macOS and the BSDs —
 * and both fields come from one call, so they describe the same instant of the
 * same process.  A `ps` that rejects the `pgid` keyword is asked for the start
 * time alone, which leaves the group unknown; Linux then falls back to /proc,
 * which carries both.  Returns null when no source answers.
 */
function readPosixProcess(pid: number): LiveProcess | null {
  // pgid is printed first: lstart holds spaces, so a trailing column would not
  // separate cleanly from it.
  const combined = runPs(pid, "pgid=,lstart=");
  if (combined !== null) {
    const match = /^(\d+)\s+(\S.*)$/.exec(combined);
    if (match) {
      const startMs = new Date(match[2]!).getTime();
      if (!isNaN(startMs)) return { startMs, pgid: Number(match[1]) };
    }
  }

  const lstart = runPs(pid, "lstart=");
  if (lstart !== null) {
    const startMs = new Date(lstart).getTime();
    if (!isNaN(startMs)) return { startMs, pgid: null };
  }

  return readProcStat(pid);
}

// ── Identity verification ─────────────────────────────────────────────

/**
 * What a source reported about the identity of a live PID.
 *
 * "mismatch" is a positive answer — a source read a start time, and it is not
 * the recorded one, so the pid was reused. "unknown" is the absence of an
 * answer: no source could read a start time at all.
 */
type Identity = "match" | "mismatch" | "unknown";

/** What the reaper knows about a live PID it is about to signal. */
interface OrphanCheck {
  /** Whether the live process is the one the previous server recorded. */
  identity: Identity;
  /**
   * The process leads its own process group (pgid === pid), so `kill(-pid)`
   * reaches that group and nothing else.  False whenever no source reported
   * the group, and on Windows, which has no process groups.
   */
  leadsGroup: boolean;
}

const UNKNOWN: OrphanCheck = { identity: "unknown", leadsGroup: false };
const MISMATCH: OrphanCheck = { identity: "mismatch", leadsGroup: false };

/**
 * Verify that the running process with the given PID is (likely) the same
 * process that was spawned by the previous server instance, and whether it
 * leads its own process group.
 *
 * The comparison is best-effort.  When we cannot determine the start time
 * we conservatively report no match (do NOT kill) to avoid hitting a reused PID.
 *
 * @param pid        Process ID to inspect.
 * @param spawnedAt  ISO timestamp stored in pid.json at spawn time.
 */
function checkOrphan(pid: number, spawnedAt: string): OrphanCheck {
  const storedMs = new Date(spawnedAt).getTime();
  if (isNaN(storedMs)) return UNKNOWN; // Nothing to compare against.

  if (process.platform === "win32") {
    const procMs = getWindowsCreationTimeMs(pid);
    if (procMs === null) return UNKNOWN;
    // Allow 5-second slop for clock skew / WMIC rounding.
    return Math.abs(procMs - storedMs) < 5000 ? { identity: "match", leadsGroup: false } : MISMATCH;
  }

  const live = readPosixProcess(pid);
  // No start time from any source — skip rather than risk a reused PID.
  if (live === null) return UNKNOWN;

  // The 5-second slop covers the 1-second resolution of `ps -o lstart`, the
  // whole-second /proc boot time and the delay between the spawn and the write
  // of pid.json.
  if (Math.abs(live.startMs - storedMs) >= 5000) return MISMATCH;

  // pgid === pid means the recorded process is itself the leader of the group,
  // so the group is the one it was given at spawn.  A pgid pointing elsewhere
  // leaves the group with id `pid` — if one exists at all — led by some process
  // that is not this one.
  return { identity: "match", leadsGroup: live.pgid === pid };
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

  const reapPromises = candidates.map(async (session) => {
    const { pid, spawnedAt } = session.pidInfo!;

    const atStart = probePid(pid);
    if (atStart === "dead") {
      summary.alreadyDead++;
      return;
    }
    if (atStart === "unknown") {
      console.error(
        `[orphan-reaper] Liveness of PID ${pid} (session ${session.sessionId}) could not be` +
          ` determined — sending no signal. Skipping.`
      );
      summary.skipped++;
      return;
    }

    const atCheck = checkOrphan(pid, spawnedAt);
    if (atCheck.identity !== "match") {
      console.error(
        `[orphan-reaper] PID ${pid} (session ${session.sessionId}) is alive but` +
          (atCheck.identity === "mismatch"
            ? ` does not match stored spawn time — likely a reused PID. Skipping.`
            : ` no source reported its start time — cannot confirm its identity. Skipping.`)
      );
      summary.skipped++;
      return;
    }

    // Re-verify identity immediately before sending signal (close TOCTOU window).
    const beforeGraceful = probePid(pid);
    if (beforeGraceful === "dead") {
      // It exited on its own between the two probes; no signal was sent.
      summary.alreadyDead++;
      return;
    }
    const atGraceful = beforeGraceful === "alive" ? checkOrphan(pid, spawnedAt) : UNKNOWN;
    if (atGraceful.identity !== "match") {
      summary.skipped++;
      return;
    }

    // Confirmed orphan — attempt graceful termination.
    console.error(
      `[orphan-reaper] Sending graceful terminate to orphan ${atGraceful.leadsGroup ? `process group ${pid}` : `PID ${pid}`}` +
        ` (session ${session.sessionId}).`
    );
    sendGraceful(pid, atGraceful.leadsGroup);

    // Poll for up to 5 seconds.
    const deadline = Date.now() + 5000;
    while (probePid(pid) === "alive" && Date.now() < deadline) {
      await sleep(250);
    }

    if (probePid(pid) === "alive") {
      // The graceful window is long enough for the leader to exit and its PID
      // to be handed to something else, so the identity is checked again before
      // the force signal — which on POSIX reaches a whole process group.
      const atForce = checkOrphan(pid, spawnedAt);
      if (atForce.identity === "mismatch") {
        // A source read a start time and it is another process's: the orphan
        // exited during the graceful window and its pid was handed on.
        console.error(
          `[orphan-reaper] PID ${pid} now reports another start time than the stored one —` +
            ` the orphan exited and its pid was reused. Not force killing.`
        );
        summary.reaped++;
        return;
      }
      if (atForce.identity === "unknown") {
        // No source answered, so nothing separates an exited orphan from one
        // that is still running. Both leave the outcome unconfirmed.
        console.error(
          `[orphan-reaper] PID ${pid} is alive after the graceful terminate and no source` +
            ` reported its start time — cannot confirm it is the orphan. Not force killing;` +
            ` the process may still be running.`
        );
        summary.unconfirmed++;
        return;
      }
      console.error(
        `[orphan-reaper] PID ${pid} did not exit after graceful terminate — force killing.`
      );
      sendForce(pid, atForce.leadsGroup);
      // Give the OS a moment to act.
      await sleep(500);
    }

    const atEnd = probePid(pid);
    if (atEnd === "dead") {
      summary.reaped++;
      return;
    }
    console.error(
      `[orphan-reaper] PID ${pid} (session ${session.sessionId}) is still ${atEnd === "alive" ? "running" : "of undetermined liveness"}` +
        ` after the termination attempt — its exit is unconfirmed.`
    );
    summary.unconfirmed++;
  });

  await Promise.all(reapPromises);
  return summary;
}
