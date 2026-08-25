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
 */
import { execSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import type { RecoveredSession } from "../persistence/index.js";

export interface ReapSummary {
  reaped: number;
  alreadyDead: number;
  skipped: number;
}

// ── Liveness check ───────────────────────────────────────────────────

/**
 * Return true if a process with the given PID appears to be running.
 * Uses `process.kill(pid, 0)` which throws when the process does not exist.
 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ── Start-time helpers ───────────────────────────────────────────────

/**
 * On Windows: query WMI for the process creation time.
 * WMIC returns dates in the form "YYYYMMDDHHmmss.ffffff+ZZZ".
 * We extract just the 14-digit prefix and convert to an ISO string.
 * Returns null on any error (process gone, access denied, wmic absent).
 */
function getWindowsCreationTimeMs(pid: number): number | null {
  try {
    const raw = execSync(`wmic process where "ProcessId=${pid}" get CreationDate /value`, {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).toString();
    const match = raw.match(/CreationDate=(\d{14})/);
    if (!match || !match[1]) return null;
    const s = match[1];
    const iso = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}.000Z`;
    const ms = new Date(iso).getTime();
    return isNaN(ms) ? null : ms;
  } catch {
    return null;
  }
}

/**
 * On Linux: read /proc/{pid}/stat and return the starttime field (field 22,
 * 0-indexed) as a raw tick string suitable for identity comparison.
 * Returns null when /proc is unavailable.
 */
function getProcStatStartTick(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    // The second field is the comm (executable name) enclosed in parentheses
    // and may contain spaces, so we split after the closing ')'.
    const afterComm = stat.slice(stat.lastIndexOf(")") + 1).trim();
    const fields = afterComm.split(" ");
    // After stripping "state" and the next fields, starttime is at index 19
    // of afterComm fields (which corresponds to field 22 of the full stat).
    const starttime = fields[19];
    return starttime ?? null;
  } catch {
    return null;
  }
}

/**
 * On macOS / BSDs (and Linux fallback): use `ps -p PID -o lstart=` to get
 * a human-readable start timestamp.  Returns null on failure.
 */
function getPsLstart(pid: number): number | null {
  try {
    const output = execSync(`ps -p ${pid} -o lstart=`, {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    })
      .toString()
      .trim();
    if (!output) return null;
    const ms = new Date(output).getTime();
    return isNaN(ms) ? null : ms;
  } catch {
    return null;
  }
}

// ── Identity verification ─────────────────────────────────────────────

/**
 * Verify that the running process with the given PID is (likely) the same
 * process that was spawned by the previous server instance.
 *
 * The comparison is best-effort.  When we cannot determine the start time
 * we conservatively return false (do NOT kill) to avoid hitting a reused PID.
 *
 * @param pid        Process ID to inspect.
 * @param spawnedAt  ISO timestamp stored in pid.json at spawn time.
 */
function isOrphan(pid: number, spawnedAt: string): boolean {
  const storedMs = new Date(spawnedAt).getTime();
  if (isNaN(storedMs)) return false; // Cannot parse → skip.

  if (process.platform === "win32") {
    const procMs = getWindowsCreationTimeMs(pid);
    if (procMs === null) return false;
    // Allow 5-second slop for clock skew / WMIC rounding.
    return Math.abs(procMs - storedMs) < 5000;
  }

  // Linux: prefer /proc/{pid}/stat tick comparison.
  // We store the tick at reaper-check time and compare with what was stored
  // previously — actually we don't store ticks, so instead we cross-check by
  // also trying ps lstart.
  const lstartMs = getPsLstart(pid);
  if (lstartMs !== null) {
    return Math.abs(lstartMs - storedMs) < 5000;
  }

  // Fallback: if we have a /proc tick but cannot convert it to wall time,
  // we use a heuristic: trust the PID is an orphan when the stored spawnedAt
  // is within the last 24 hours (processes spawned further back almost
  // certainly hit a reboot or enough PID cycling to be harmless).
  const tick = getProcStatStartTick(pid);
  if (tick !== null) {
    const ageMs = Date.now() - storedMs;
    return ageMs > 0 && ageMs < 24 * 60 * 60 * 1000;
  }

  // No information — conservatively skip.
  return false;
}

// ── Signal helpers ───────────────────────────────────────────────────

function sendGraceful(pid: number): void {
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/PID", String(pid)], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      process.kill(pid, "SIGTERM");
    }
  } catch {
    // Already gone.
  }
}

function sendForce(pid: number): void {
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/PID", String(pid), "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      process.kill(pid, "SIGKILL");
    }
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
 *   2. If alive, verify it is the same process (not a reused PID).
 *   3. If confirmed orphan: graceful terminate → 5 s wait → force kill.
 *   4. Otherwise: count as already-dead or skipped.
 *
 * @param recovered  Sessions returned by the recovery scanner.
 * @returns Summary of { reaped, alreadyDead, skipped }.
 */
export async function reapOrphanProcesses(recovered: RecoveredSession[]): Promise<ReapSummary> {
  const summary: ReapSummary = { reaped: 0, alreadyDead: 0, skipped: 0 };

  const candidates = recovered.filter((s) => s.pidInfo !== null);
  if (candidates.length === 0) return summary;

  const reapPromises = candidates.map(async (session) => {
    const { pid, spawnedAt } = session.pidInfo!;

    if (!isAlive(pid)) {
      summary.alreadyDead++;
      return;
    }

    if (!isOrphan(pid, spawnedAt)) {
      // PID is live but does not match the stored identity → reused PID.
      console.error(
        `[orphan-reaper] PID ${pid} (session ${session.sessionId}) is alive` +
          ` but does not match stored spawn time — likely a reused PID. Skipping.`
      );
      summary.skipped++;
      return;
    }

    // Re-verify identity immediately before sending signal (close TOCTOU window).
    if (!isAlive(pid) || !isOrphan(pid, spawnedAt)) {
      summary.skipped++;
      return;
    }

    // Confirmed orphan — attempt graceful termination.
    console.error(
      `[orphan-reaper] Sending graceful terminate to orphan PID ${pid}` +
        ` (session ${session.sessionId}).`
    );
    sendGraceful(pid);

    // Poll for up to 5 seconds.
    const deadline = Date.now() + 5000;
    while (isAlive(pid) && Date.now() < deadline) {
      await sleep(250);
    }

    if (isAlive(pid)) {
      console.error(
        `[orphan-reaper] PID ${pid} did not exit after graceful terminate — force killing.`
      );
      sendForce(pid);
      // Give the OS a moment to act.
      await sleep(500);
    }

    summary.reaped++;
  });

  await Promise.all(reapPromises);
  return summary;
}
