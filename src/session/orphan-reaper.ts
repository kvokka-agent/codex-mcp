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
import { uptime } from "node:os";
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

/**
 * On Linux: turn field 22 of /proc/{pid}/stat (start time in clock ticks since
 * boot) into an epoch timestamp.
 * Returns null when the file, the field or the boot time is unavailable.
 */
function getProcStartTimeMs(pid: number): number | null {
  let ticks: number;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    // Field 2 is the executable name in parentheses and may itself hold spaces
    // and ')', so the remaining fields are split after the last ')'.
    const fields = stat
      .slice(stat.lastIndexOf(")") + 1)
      .trim()
      .split(/\s+/);
    // fields[0] is field 3 (state), so field 22 (starttime) sits at index 19.
    ticks = Number(fields[19]);
  } catch {
    return null;
  }
  if (!Number.isFinite(ticks) || ticks < 0) return null;

  const bootMs = getBootTimeMs();
  if (bootMs === null) return null;
  return bootMs + (ticks / USER_HZ) * 1000;
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

  // `ps` first: it is the only start-time source on macOS and the BSDs.
  // Both sources are compared with the same 5-second slop, which covers the
  // 1-second resolution of `ps -o lstart`, the whole-second /proc boot time and
  // the delay between the spawn and the write of pid.json.
  const lstartMs = getPsLstart(pid);
  if (lstartMs !== null) {
    return Math.abs(lstartMs - storedMs) < 5000;
  }

  const procStartMs = getProcStartTimeMs(pid);
  if (procStartMs !== null) {
    return Math.abs(procStartMs - storedMs) < 5000;
  }

  // No start time from any source — skip rather than risk a reused PID.
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
