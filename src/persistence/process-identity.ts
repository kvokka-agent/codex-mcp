/**
 * What the operating system says about a process id.
 *
 * A pid alone identifies nothing: the number is handed on as soon as its
 * process exits, so both the session owner and the orphan reaper compare the
 * recorded start instant against the one the OS reports before they act on a
 * pid they found in a file.
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { uptime } from "node:os";

/** What `process.kill(pid, 0)` could establish about a pid. */
export type Liveness = "alive" | "dead" | "unknown";

/**
 * Probe whether a process with the given pid runs.
 *
 * `process.kill(pid, 0)` raises ESRCH for a pid no process holds and EPERM when
 * the process runs under a user this one may not signal — EPERM is a live
 * process, and a state directory shared across accounts is exactly where it
 * appears. Any other errno leaves liveness unknown.
 */
export function probePid(pid: number): Liveness {
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

/** What a source reported about a live pid. */
interface LiveProcess {
  /** Epoch milliseconds at which the process started. */
  startMs: number;
  /** Process group id, or null when the source did not report one. */
  pgid: number | null;
}

/**
 * Whether the live process behind a pid is the one that was recorded.
 *
 * "mismatch" is a positive answer — a source read a start time, and it is not
 * the recorded one, so the pid was reused. "unknown" is the absence of an
 * answer: no source could read a start time at all.
 */
export type Identity = "match" | "mismatch" | "unknown";

/** What a caller knows about a live pid it found in a file. */
export interface ProcessCheck {
  identity: Identity;
  /**
   * The process leads its own process group (pgid === pid), so `kill(-pid)`
   * reaches that group and nothing else. False whenever no source reported the
   * group, and on Windows, which has no process groups.
   */
  leadsGroup: boolean;
}

export const UNKNOWN_PROCESS: ProcessCheck = { identity: "unknown", leadsGroup: false };
const MISMATCHED_PROCESS: ProcessCheck = { identity: "mismatch", leadsGroup: false };

/**
 * The slop allowed between a recorded spawn instant and the start time the OS
 * reports: `ps -o lstart` has one-second resolution, /proc dates the boot in
 * whole seconds, and the record is written after the spawn returns.
 */
export const START_TIME_SLOP_MS = 5000;

/**
 * The instant this process started, as the value to record for it.
 *
 * `process.uptime()` counts from the same moment the OS dates the process by,
 * so a later reader compares like with like. `os.uptime()` counts from the boot
 * of the machine and would date every process to that.
 */
export function ownStartedAt(): string {
  return new Date(Date.now() - process.uptime() * 1000).toISOString();
}

// ── Windows ──────────────────────────────────────────────────────────

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

// ── POSIX ────────────────────────────────────────────────────────────

// Every mainstream Linux build compiles USER_HZ as 100; on a kernel built with
// another value the computed start time misses and the pid is left alone.
const USER_HZ = 100;

/**
 * Epoch milliseconds of the last boot, from the `btime` line of /proc/stat
 * (whole seconds) or, where that is unreadable, from the uptime the kernel
 * reports now. Returns null when neither answers.
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
 * Run `ps -p PID -o FORMAT` at UTC and return its trimmed output, or null on
 * failure.
 *
 * `ps` prints `lstart` as the wall clock of the zone its own process runs in,
 * so the zone is named here rather than inherited: it is the other half of
 * `parseLstartMs`, which reads those fields as UTC.
 */
function runPs(pid: number, format: string): string | null {
  try {
    const output = execSync(`ps -p ${pid} -o ${format}`, {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
      env: { ...process.env, TZ: "UTC" },
    })
      .toString()
      .trim();
    return output === "" ? null : output;
  } catch {
    return null;
  }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `ps -o lstart=`: "Fri Aug 28 14:53:13 2026", the day space-padded. */
const LSTART = /^\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/;

/**
 * Epoch milliseconds of one `ps -o lstart=` reading, whose fields `runPs` put
 * at UTC.
 *
 * Handing the string to `new Date` reads it in the zone of whichever runtime
 * parses it, and that zone is not always the one the reading was printed in:
 * under `bun test` the runtime stands at UTC while the child `ps` prints
 * +07:00, which dated every process seven hours late and made this server's own
 * sessions read as another server's. Returns null for a reading in any other
 * shape, which leaves the identity unknown rather than wrong.
 */
export function parseLstartMs(lstart: string): number | null {
  const match = LSTART.exec(lstart.trim());
  if (!match) return null;
  const month = MONTHS.indexOf(match[1]!);
  if (month < 0) return null;
  return Date.UTC(
    Number(match[6]),
    month,
    Number(match[2]),
    Number(match[3]),
    Number(match[4]),
    Number(match[5])
  );
}

/**
 * Read the start time and the process group of a live pid.
 *
 * `ps` answers first — it is the only source of either on macOS and the BSDs —
 * and both fields come from one call, so they describe the same instant of the
 * same process. A `ps` that rejects the `pgid` keyword is asked for the start
 * time alone, which leaves the group unknown; Linux then falls back to /proc,
 * which carries both. Returns null when no source answers.
 */
function readPosixProcess(pid: number): LiveProcess | null {
  // pgid is printed first: lstart holds spaces, so a trailing column would not
  // separate cleanly from it.
  const combined = runPs(pid, "pgid=,lstart=");
  if (combined !== null) {
    const match = /^(\d+)\s+(\S.*)$/.exec(combined);
    if (match) {
      const startMs = parseLstartMs(match[2]!);
      if (startMs !== null) return { startMs, pgid: Number(match[1]) };
    }
  }

  const lstart = runPs(pid, "lstart=");
  if (lstart !== null) {
    const startMs = parseLstartMs(lstart);
    if (startMs !== null) return { startMs, pgid: null };
  }

  return readProcStat(pid);
}

/**
 * Whether the live process behind `pid` started at `startedAt`, and whether it
 * leads its own process group.
 *
 * A start time no source reports leaves the identity unknown, which every
 * caller treats as "not proven mine".
 */
export function identifyProcess(pid: number, startedAt: string): ProcessCheck {
  const recordedMs = new Date(startedAt).getTime();
  if (isNaN(recordedMs)) return UNKNOWN_PROCESS;

  if (process.platform === "win32") {
    const procMs = getWindowsCreationTimeMs(pid);
    if (procMs === null) return UNKNOWN_PROCESS;
    return Math.abs(procMs - recordedMs) < START_TIME_SLOP_MS
      ? { identity: "match", leadsGroup: false }
      : MISMATCHED_PROCESS;
  }

  const live = readPosixProcess(pid);
  if (live === null) return UNKNOWN_PROCESS;
  if (Math.abs(live.startMs - recordedMs) >= START_TIME_SLOP_MS) return MISMATCHED_PROCESS;

  // pgid === pid means the recorded process is itself the leader of the group,
  // so the group is the one it was given at spawn. A pgid pointing elsewhere
  // leaves the group with id `pid` — if one exists at all — led by some process
  // that is not this one.
  return { identity: "match", leadsGroup: live.pgid === pid };
}
