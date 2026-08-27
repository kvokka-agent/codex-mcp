import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reapOrphanProcesses } from "../src/session/orphan-reaper.js";
import type { RecoveredSession } from "../src/persistence/index.js";
import { msAgo } from "./helpers/clock.js";

const { execSyncMock, spawnMock, readFileSyncMock, uptimeMock } = vi.hoisted(() => ({
  execSyncMock: vi.fn(),
  spawnMock: vi.fn(),
  readFileSyncMock: vi.fn(),
  uptimeMock: vi.fn(),
}));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, execSync: execSyncMock, spawn: spawnMock };
});

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, default: actual, readFileSync: readFileSyncMock };
});

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, default: actual, uptime: uptimeMock };
});

const realPlatform = process.platform;
const dead = new Set<number>();
const killCalls: Array<[number, string | number | undefined]> = [];

const BTIME_SECONDS = 1_700_000_000;

/**
 * A /proc/{pid}/stat line whose field 5 (pgrp) holds `pgrp` and whose field 22
 * (starttime) holds `startTicks`.
 */
function procStat(pid: number, startTicks: number, pgrp = pid): string {
  const betweenFlagsAndStarttime = Array.from({ length: 12 }, () => "0").join(" ");
  return `${pid} (codex exec) S 1 ${pgrp} ${pid} 0 -1 4194304 ${betweenFlagsAndStarttime} ${startTicks} 0 0\n`;
}

/** Serves /proc/stat with a fixed btime and /proc/{pid}/stat for the listed pids. */
function procFiles(
  startTicksByPid: Record<number, number>,
  btime = `btime ${BTIME_SECONDS}\n`,
  pgrpByPid: Record<number, number> = {}
) {
  return (path: string) => {
    if (path === "/proc/stat") {
      if (btime === "") throw new Error("EACCES");
      return `cpu 1 2 3\n${btime}processes 42\n`;
    }
    const match = /^\/proc\/(\d+)\/stat$/.exec(path);
    const ticks = match ? startTicksByPid[Number(match[1])] : undefined;
    if (ticks === undefined) throw new Error("ENOENT");
    const pid = Number(match![1]);
    return procStat(pid, ticks, pgrpByPid[pid] ?? pid);
  };
}

/** One line of `ps -p PID -o pgid=,lstart=`: the group id, then the start time. */
function psLine(pgid: number, startedAt: Date): string {
  return `${pgid} ${startedAt.toString()}\n`;
}

function setPlatform(platform: string): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

function session(pid: number, spawnedAt: string, sessionId = `sess_${pid}`): RecoveredSession {
  return {
    sessionId,
    meta: { schemaVersion: 1, sessionId, status: "running", createdAt: "", lastActiveAt: "" },
    events: [],
    lastSeq: -1,
    result: null,
    pidInfo: { pid, spawnedAt },
    sessionDir: `/tmp/${sessionId}`,
  };
}

function sessionWithoutPid(sessionId = "sess_nopid"): RecoveredSession {
  return { ...session(1, "", sessionId), pidInfo: null };
}

/** The error `process.kill(pid, 0)` raises for a pid no process holds. */
function esrch(): NodeJS.ErrnoException {
  const err = new Error("kill ESRCH") as NodeJS.ErrnoException;
  err.code = "ESRCH";
  return err;
}

/**
 * Kills the process on SIGTERM/SIGKILL so the reaper's liveness probe sees it
 * exit.  A signal to a negative pid reaches the group, the leader included.
 */
function killsOnSignal(): void {
  vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
    killCalls.push([pid, signal]);
    if (signal === 0 || signal === undefined) {
      if (dead.has(pid)) throw esrch();
      return true;
    }
    dead.add(Math.abs(pid));
    return true;
  }) as typeof process.kill);
}

/** Survives SIGTERM and dies on SIGKILL, so the reaper has to escalate. */
function diesOnForce(): void {
  vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
    killCalls.push([pid, signal]);
    if (signal === 0 || signal === undefined) {
      if (dead.has(pid)) throw esrch();
      return true;
    }
    if (signal === "SIGKILL") dead.add(Math.abs(pid));
    return true;
  }) as typeof process.kill);
}

/** Ignores termination signals so the reaper has to escalate to a force kill. */
function ignoresSignals(): void {
  vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
    killCalls.push([pid, signal]);
    if ((signal === 0 || signal === undefined) && dead.has(pid)) throw esrch();
    return true;
  }) as typeof process.kill);
}

beforeEach(() => {
  dead.clear();
  killCalls.length = 0;
  execSyncMock.mockReset();
  spawnMock.mockReset();
  readFileSyncMock.mockReset();
  readFileSyncMock.mockImplementation(() => {
    throw new Error("ENOENT");
  });
  uptimeMock.mockReset();
  uptimeMock.mockImplementation(() => {
    throw new Error("uptime unavailable");
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  setPlatform(realPlatform);
});

describe("reapOrphanProcesses", () => {
  it("does nothing when no recovered session carries pid info", async () => {
    const summary = await reapOrphanProcesses([sessionWithoutPid(), sessionWithoutPid("b")]);
    expect(summary).toEqual({ reaped: 0, alreadyDead: 0, unconfirmed: 0, skipped: 0 });
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  it("counts a pid that is already gone as already dead", async () => {
    setPlatform("linux");
    dead.add(900);
    killsOnSignal();

    const summary = await reapOrphanProcesses([session(900, new Date().toISOString())]);
    expect(summary).toEqual({ reaped: 0, alreadyDead: 1, unconfirmed: 0, skipped: 0 });
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  it("terminates the process group of a live process whose start time matches", async () => {
    setPlatform("linux");
    const spawnedAt = new Date("2024-05-05T10:00:00.000Z");
    execSyncMock.mockReturnValue(psLine(901, new Date(spawnedAt.getTime() + 2_000)));
    killsOnSignal();

    const summary = await reapOrphanProcesses([session(901, spawnedAt.toISOString())]);

    expect(summary).toEqual({ reaped: 1, alreadyDead: 0, unconfirmed: 0, skipped: 0 });
    expect(execSyncMock.mock.calls[0]![0]).toBe("ps -p 901 -o pgid=,lstart=");
    // The clients spawn codex detached, so its children live in the group.
    expect(killCalls).toContainEqual([-901, "SIGTERM"]);
    expect(killCalls).not.toContainEqual([901, "SIGTERM"]);
    expect(killCalls).not.toContainEqual([-901, "SIGKILL"]);
  });

  it("signals the leader alone when the process does not lead its own group", async () => {
    setPlatform("linux");
    const spawnedAt = new Date("2024-05-05T10:00:00.000Z");
    // pgid 42 is somebody else's group: the pid that was recorded is only a
    // member of it, so the group with id 930 is not this process's group.
    execSyncMock.mockReturnValue(psLine(42, new Date(spawnedAt.getTime() + 2_000)));
    killsOnSignal();

    const summary = await reapOrphanProcesses([session(930, spawnedAt.toISOString())]);

    expect(summary).toEqual({ reaped: 1, alreadyDead: 0, unconfirmed: 0, skipped: 0 });
    expect(killCalls).toContainEqual([930, "SIGTERM"]);
    expect(killCalls.every(([pid]) => pid >= 0)).toBe(true);
  });

  it("signals the leader alone when ps reports no group", async () => {
    setPlatform("linux");
    const spawnedAt = new Date("2024-05-05T10:00:00.000Z");
    execSyncMock.mockImplementation((cmd: string) => {
      // A ps that rejects the pgid keyword still answers for lstart alone.
      if (cmd.includes("pgid=")) throw new Error("ps: pgid: keyword not found");
      return `${new Date(spawnedAt.getTime() + 2_000).toString()}\n`;
    });
    killsOnSignal();

    const summary = await reapOrphanProcesses([session(931, spawnedAt.toISOString())]);

    expect(summary).toEqual({ reaped: 1, alreadyDead: 0, unconfirmed: 0, skipped: 0 });
    expect(execSyncMock.mock.calls[1]![0]).toBe("ps -p 931 -o lstart=");
    expect(killCalls).toContainEqual([931, "SIGTERM"]);
    expect(killCalls.every(([pid]) => pid >= 0)).toBe(true);
  });

  it("falls back to the leader when the group signal is rejected", async () => {
    setPlatform("linux");
    const spawnedAt = new Date("2024-05-05T10:00:00.000Z");
    execSyncMock.mockReturnValue(psLine(932, new Date(spawnedAt.getTime() + 2_000)));
    vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
      killCalls.push([pid, signal]);
      if (signal === 0 || signal === undefined) {
        if (dead.has(pid)) throw esrch();
        return true;
      }
      if (pid < 0) throw esrch();
      dead.add(pid);
      return true;
    }) as typeof process.kill);

    const summary = await reapOrphanProcesses([session(932, spawnedAt.toISOString())]);

    expect(summary).toEqual({ reaped: 1, alreadyDead: 0, unconfirmed: 0, skipped: 0 });
    expect(killCalls).toContainEqual([-932, "SIGTERM"]);
    expect(killCalls).toContainEqual([932, "SIGTERM"]);
  });

  it("skips a live process whose start time does not match — a reused pid", async () => {
    setPlatform("linux");
    execSyncMock.mockReturnValue(psLine(902, new Date("2024-05-05T18:00:00.000Z")));
    killsOnSignal();

    const summary = await reapOrphanProcesses([
      session(902, new Date("2024-05-05T10:00:00.000Z").toISOString()),
    ]);

    expect(summary).toEqual({ reaped: 0, alreadyDead: 0, unconfirmed: 0, skipped: 1 });
    expect(killCalls.every(([, signal]) => signal === 0)).toBe(true);
  });

  it("skips a session whose recorded spawn time cannot be parsed", async () => {
    setPlatform("linux");
    killsOnSignal();

    const summary = await reapOrphanProcesses([session(903, "not-a-date")]);
    expect(summary).toEqual({ reaped: 0, alreadyDead: 0, unconfirmed: 0, skipped: 1 });
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  it("skips when neither ps nor /proc can report a start time", async () => {
    setPlatform("linux");
    execSyncMock.mockImplementation(() => {
      throw new Error("ps unavailable");
    });
    killsOnSignal();

    const summary = await reapOrphanProcesses([session(904, new Date().toISOString())]);
    expect(summary).toEqual({ reaped: 0, alreadyDead: 0, unconfirmed: 0, skipped: 1 });
  });

  it("terminates a process whose /proc start tick matches when ps is unavailable", async () => {
    setPlatform("linux");
    execSyncMock.mockImplementation(() => {
      throw new Error("ps unavailable");
    });
    readFileSyncMock.mockImplementation(procFiles({ 905: 12_345 }));
    killsOnSignal();

    const startMs = BTIME_SECONDS * 1000 + 123_450;
    const summary = await reapOrphanProcesses([session(905, new Date(startMs).toISOString())]);

    expect(summary).toEqual({ reaped: 1, alreadyDead: 0, unconfirmed: 0, skipped: 0 });
    expect(readFileSyncMock).toHaveBeenCalledWith("/proc/905/stat", "utf-8");
    expect(killCalls).toContainEqual([-905, "SIGTERM"]);
  });

  it("signals the leader alone when /proc reports a group led by another process", async () => {
    setPlatform("linux");
    execSyncMock.mockImplementation(() => {
      throw new Error("ps unavailable");
    });
    readFileSyncMock.mockImplementation(
      procFiles({ 933: 12_345 }, `btime ${BTIME_SECONDS}\n`, { 933: 42 })
    );
    killsOnSignal();

    const startMs = BTIME_SECONDS * 1000 + 123_450;
    const summary = await reapOrphanProcesses([session(933, new Date(startMs).toISOString())]);

    expect(summary).toEqual({ reaped: 1, alreadyDead: 0, unconfirmed: 0, skipped: 0 });
    expect(killCalls).toContainEqual([933, "SIGTERM"]);
    expect(killCalls.every(([pid]) => pid >= 0)).toBe(true);
  });

  it("skips when the /proc start tick disagrees with the recorded spawn time", async () => {
    setPlatform("linux");
    execSyncMock.mockImplementation(() => {
      throw new Error("ps unavailable");
    });
    readFileSyncMock.mockImplementation(procFiles({ 906: 12_345 }));
    killsOnSignal();

    // The recorded spawn is a minute past the tick the kernel reports.
    const startMs = BTIME_SECONDS * 1000 + 123_450 + 60_000;
    const summary = await reapOrphanProcesses([session(906, new Date(startMs).toISOString())]);

    expect(summary).toEqual({ reaped: 0, alreadyDead: 0, unconfirmed: 0, skipped: 1 });
    expect(killCalls.every(([, signal]) => signal === 0)).toBe(true);
  });

  it("derives the boot time from the kernel uptime when /proc/stat is unreadable", async () => {
    setPlatform("linux");
    execSyncMock.mockImplementation(() => {
      throw new Error("ps unavailable");
    });
    readFileSyncMock.mockImplementation(procFiles({ 913: 12_345 }, ""));
    uptimeMock.mockReturnValue(3_600);
    killsOnSignal();

    const startMs = msAgo(3_600_000 - 123_450);
    const summary = await reapOrphanProcesses([session(913, new Date(startMs).toISOString())]);

    expect(summary).toEqual({ reaped: 1, alreadyDead: 0, unconfirmed: 0, skipped: 0 });
    expect(killCalls).toContainEqual([-913, "SIGTERM"]);
  });

  it("skips when the boot time is available from neither /proc/stat nor the uptime", async () => {
    setPlatform("linux");
    execSyncMock.mockImplementation(() => {
      throw new Error("ps unavailable");
    });
    readFileSyncMock.mockImplementation(procFiles({ 914: 12_345 }, ""));
    killsOnSignal();

    const summary = await reapOrphanProcesses([
      session(914, new Date(BTIME_SECONDS * 1000 + 123_450).toISOString()),
    ]);

    expect(summary).toEqual({ reaped: 0, alreadyDead: 0, unconfirmed: 0, skipped: 1 });
    expect(killCalls.every(([, signal]) => signal === 0)).toBe(true);
  });

  it("skips when /proc/{pid}/stat carries no start tick", async () => {
    setPlatform("linux");
    execSyncMock.mockImplementation(() => {
      throw new Error("ps unavailable");
    });
    readFileSyncMock.mockImplementation((path: string) =>
      path === "/proc/stat" ? `btime ${BTIME_SECONDS}\n` : "915 (codex exec) S 1 915 915\n"
    );
    killsOnSignal();

    const summary = await reapOrphanProcesses([session(915, new Date().toISOString())]);

    expect(summary).toEqual({ reaped: 0, alreadyDead: 0, unconfirmed: 0, skipped: 1 });
    expect(killCalls.every(([, signal]) => signal === 0)).toBe(true);
  });

  it("force kills the group of a process that ignores the graceful signal", async () => {
    setPlatform("linux");
    vi.useFakeTimers();
    const spawnedAt = new Date().toISOString();
    execSyncMock.mockReturnValue(psLine(907, new Date(Date.parse(spawnedAt) + 1_000)));
    diesOnForce();

    const pending = reapOrphanProcesses([session(907, spawnedAt)]);
    await vi.advanceTimersByTimeAsync(6_000);
    const summary = await pending;

    expect(summary).toEqual({ reaped: 1, alreadyDead: 0, unconfirmed: 0, skipped: 0 });
    expect(killCalls).toContainEqual([-907, "SIGTERM"]);
    expect(killCalls).toContainEqual([-907, "SIGKILL"]);
    expect(killCalls).not.toContainEqual([907, "SIGKILL"]);
  });

  it("counts a process that survives the force kill as unconfirmed, not reaped", async () => {
    setPlatform("linux");
    vi.useFakeTimers();
    const spawnedAt = new Date().toISOString();
    execSyncMock.mockReturnValue(psLine(908, new Date(Date.parse(spawnedAt) + 1_000)));
    ignoresSignals();

    const pending = reapOrphanProcesses([session(908, spawnedAt)]);
    await vi.advanceTimersByTimeAsync(6_000);
    const summary = await pending;

    expect(summary).toEqual({ reaped: 0, alreadyDead: 0, unconfirmed: 1, skipped: 0 });
    expect(killCalls).toContainEqual([-908, "SIGKILL"]);
  });

  it("counts an orphan as unconfirmed when no source answers after the graceful signal", async () => {
    setPlatform("linux");
    vi.useFakeTimers();
    const spawnedAt = new Date().toISOString();
    let psCalls = 0;
    execSyncMock.mockImplementation(() => {
      psCalls++;
      // The two checks before the signal confirm the orphan; then ps stops
      // answering, as it does in a container that carries neither ps nor /proc.
      if (psCalls > 2) throw new Error("ps unavailable");
      return psLine(909, new Date(Date.parse(spawnedAt) + 1_000));
    });
    ignoresSignals();

    const pending = reapOrphanProcesses([session(909, spawnedAt)]);
    await vi.advanceTimersByTimeAsync(6_000);
    const summary = await pending;

    // The process took SIGTERM and stayed alive: nothing confirms it is gone.
    expect(summary).toEqual({ reaped: 0, alreadyDead: 0, unconfirmed: 1, skipped: 0 });
    expect(killCalls).toContainEqual([-909, "SIGTERM"]);
    expect(killCalls.every(([, signal]) => signal !== "SIGKILL")).toBe(true);
  });

  it("signals a live process owned by another user and reports it unconfirmed", async () => {
    setPlatform("linux");
    vi.useFakeTimers();
    const spawnedAt = new Date().toISOString();
    execSyncMock.mockReturnValue(psLine(916, new Date(Date.parse(spawnedAt) + 1_000)));
    // EPERM is a running process this user may not signal — it never becomes
    // "already dead", and no signal of ours confirms its exit.
    vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
      killCalls.push([pid, signal]);
      const err = new Error("kill EPERM") as NodeJS.ErrnoException;
      err.code = "EPERM";
      throw err;
    }) as typeof process.kill);

    const pending = reapOrphanProcesses([session(916, spawnedAt)]);
    await vi.advanceTimersByTimeAsync(6_000);
    const summary = await pending;

    expect(summary).toEqual({ reaped: 0, alreadyDead: 0, unconfirmed: 1, skipped: 0 });
  });

  it("counts a pid that exits between the two liveness probes as already dead", async () => {
    setPlatform("linux");
    const spawnedAt = new Date().toISOString();
    execSyncMock.mockReturnValue(psLine(918, new Date(Date.parse(spawnedAt) + 1_000)));
    let probes = 0;
    vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
      killCalls.push([pid, signal]);
      if (signal === 0 || signal === undefined) {
        // The second probe, the one right before the signal, finds it gone.
        if (++probes >= 2) throw esrch();
        return true;
      }
      return true;
    }) as typeof process.kill);

    const summary = await reapOrphanProcesses([session(918, spawnedAt)]);

    expect(summary).toEqual({ reaped: 0, alreadyDead: 1, unconfirmed: 0, skipped: 0 });
    expect(killCalls.every(([, signal]) => signal === 0)).toBe(true);
  });

  it("skips a pid whose liveness stops being answerable before the signal", async () => {
    setPlatform("linux");
    const spawnedAt = new Date().toISOString();
    execSyncMock.mockReturnValue(psLine(919, new Date(Date.parse(spawnedAt) + 1_000)));
    let probes = 0;
    vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
      killCalls.push([pid, signal]);
      if ((signal === 0 || signal === undefined) && ++probes >= 2) {
        const err = new Error("kill EINVAL") as NodeJS.ErrnoException;
        err.code = "EINVAL";
        throw err;
      }
      return true;
    }) as typeof process.kill);

    const summary = await reapOrphanProcesses([session(919, spawnedAt)]);

    expect(summary).toEqual({ reaped: 0, alreadyDead: 0, unconfirmed: 0, skipped: 1 });
    expect(killCalls.every(([, signal]) => signal === 0)).toBe(true);
  });

  it("skips a pid whose liveness the kernel does not answer for", async () => {
    setPlatform("linux");
    vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
      killCalls.push([pid, signal]);
      const err = new Error("kill EINVAL") as NodeJS.ErrnoException;
      err.code = "EINVAL";
      throw err;
    }) as typeof process.kill);

    const summary = await reapOrphanProcesses([session(917, new Date().toISOString())]);

    expect(summary).toEqual({ reaped: 0, alreadyDead: 0, unconfirmed: 0, skipped: 1 });
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  it("sends no force signal when the pid stops matching during the graceful window", async () => {
    setPlatform("linux");
    vi.useFakeTimers();
    const spawnedAt = new Date().toISOString();
    let psCalls = 0;
    execSyncMock.mockImplementation(() => {
      psCalls++;
      // The first two reads confirm the orphan; by the force check the pid has
      // been handed to a process that started an hour later.
      const offset = psCalls <= 2 ? 1_000 : 3_600_000;
      return psLine(934, new Date(Date.parse(spawnedAt) + offset));
    });
    ignoresSignals();

    const pending = reapOrphanProcesses([session(934, spawnedAt)]);
    await vi.advanceTimersByTimeAsync(6_000);
    const summary = await pending;

    expect(summary).toEqual({ reaped: 1, alreadyDead: 0, unconfirmed: 0, skipped: 0 });
    expect(killCalls).toContainEqual([-934, "SIGTERM"]);
    expect(killCalls.every(([, signal]) => signal !== "SIGKILL")).toBe(true);
  });

  it("reaps several sessions in one pass", async () => {
    setPlatform("linux");
    const spawnedAt = new Date("2024-05-05T10:00:00.000Z").toISOString();
    execSyncMock.mockImplementation((cmd: string) =>
      cmd.includes("910")
        ? psLine(910, new Date("2024-05-05T10:00:00.000Z"))
        : psLine(911, new Date("2024-05-05T22:00:00.000Z"))
    );
    dead.add(912);
    killsOnSignal();

    const summary = await reapOrphanProcesses([
      session(910, spawnedAt),
      session(911, spawnedAt),
      session(912, spawnedAt),
      sessionWithoutPid(),
    ]);

    expect(summary).toEqual({ reaped: 1, alreadyDead: 1, unconfirmed: 0, skipped: 1 });
    expect(killCalls).toContainEqual([-910, "SIGTERM"]);
  });

  it("uses taskkill /T and the PowerShell creation time on Windows", async () => {
    setPlatform("win32");
    execSyncMock.mockReturnValue("2024-05-05T10:00:01.1234567Z\r\n");
    killsOnSignal();
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      dead.add(Number(args[1]));
      return {};
    });

    const summary = await reapOrphanProcesses([
      session(920, new Date("2024-05-05T10:00:00.000Z").toISOString()),
    ]);

    expect(summary).toEqual({ reaped: 1, alreadyDead: 0, unconfirmed: 0, skipped: 0 });
    const command = execSyncMock.mock.calls[0]![0] as string;
    expect(command).toContain("powershell.exe");
    expect(command).toContain("Get-CimInstance Win32_Process -Filter 'ProcessId=920'");
    expect(execSyncMock.mock.calls.every(([cmd]) => !String(cmd).startsWith("wmic"))).toBe(true);
    expect(spawnMock).toHaveBeenCalledWith(
      "taskkill",
      ["/PID", "920", "/T"],
      expect.objectContaining({ windowsHide: true })
    );
  });

  it("falls back to wmic when powershell.exe is unavailable", async () => {
    setPlatform("win32");
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.startsWith("powershell.exe")) throw new Error("not recognized as a command");
      return "\r\r\nCreationDate=20240505120001.123456+120\r\r\n";
    });
    killsOnSignal();
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      dead.add(Number(args[1]));
      return {};
    });

    // "+120" puts the stamp 2 hours ahead of UTC, so 12:00:01 local is 10:00:01Z.
    const summary = await reapOrphanProcesses([
      session(921, new Date("2024-05-05T10:00:00.000Z").toISOString()),
    ]);

    expect(summary).toEqual({ reaped: 1, alreadyDead: 0, unconfirmed: 0, skipped: 0 });
    expect(execSyncMock.mock.calls[1]![0]).toBe(
      'wmic process where "ProcessId=921" get CreationDate /value'
    );
    expect(spawnMock).toHaveBeenCalledWith(
      "taskkill",
      ["/PID", "921", "/T"],
      expect.objectContaining({ windowsHide: true })
    );
  });

  it("skips on Windows when neither powershell nor wmic reports a creation date", async () => {
    setPlatform("win32");
    execSyncMock.mockImplementation((cmd: string) =>
      cmd.startsWith("powershell.exe") ? "\r\n" : "No Instance(s) Available."
    );
    killsOnSignal();

    const summary = await reapOrphanProcesses([
      session(922, new Date("2024-05-05T10:00:00.000Z").toISOString()),
    ]);

    expect(summary).toEqual({ reaped: 0, alreadyDead: 0, unconfirmed: 0, skipped: 1 });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("skips on Windows when wmic omits the UTC offset", async () => {
    setPlatform("win32");
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.startsWith("powershell.exe")) throw new Error("not recognized as a command");
      return "\r\r\nCreationDate=20240505100001\r\r\n";
    });
    killsOnSignal();

    const summary = await reapOrphanProcesses([
      session(923, new Date("2024-05-05T10:00:00.000Z").toISOString()),
    ]);

    expect(summary).toEqual({ reaped: 0, alreadyDead: 0, unconfirmed: 0, skipped: 1 });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("force kills the child tree on Windows when taskkill is ignored", async () => {
    setPlatform("win32");
    vi.useFakeTimers();
    const spawnedAt = new Date();
    execSyncMock.mockReturnValue(`${new Date(spawnedAt.getTime() + 1_000).toISOString()}\r\n`);
    ignoresSignals();
    // The tree survives taskkill /T and goes down on taskkill /T /F.
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes("/F")) dead.add(Number(args[1]));
      return {};
    });

    const pending = reapOrphanProcesses([session(924, spawnedAt.toISOString())]);
    await vi.advanceTimersByTimeAsync(6_000);
    const summary = await pending;

    expect(summary).toEqual({ reaped: 1, alreadyDead: 0, unconfirmed: 0, skipped: 0 });
    expect(spawnMock.mock.calls[0]![1]).toEqual(["/PID", "924", "/T"]);
    expect(spawnMock.mock.calls[1]![1]).toEqual(["/PID", "924", "/T", "/F"]);
    // No POSIX group signal reaches a platform that has no process groups.
    expect(killCalls.every(([pid]) => pid >= 0)).toBe(true);
  });

  it("counts a Windows tree that survives taskkill /F as unconfirmed", async () => {
    setPlatform("win32");
    vi.useFakeTimers();
    const spawnedAt = new Date();
    execSyncMock.mockReturnValue(`${new Date(spawnedAt.getTime() + 1_000).toISOString()}\r\n`);
    ignoresSignals();
    spawnMock.mockReturnValue({});

    const pending = reapOrphanProcesses([session(925, spawnedAt.toISOString())]);
    await vi.advanceTimersByTimeAsync(6_000);
    const summary = await pending;

    expect(summary).toEqual({ reaped: 0, alreadyDead: 0, unconfirmed: 1, skipped: 0 });
    expect(spawnMock.mock.calls[1]![1]).toEqual(["/PID", "925", "/T", "/F"]);
  });
});
