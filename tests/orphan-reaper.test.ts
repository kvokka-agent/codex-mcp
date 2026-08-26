import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reapOrphanProcesses } from "../src/session/orphan-reaper.js";
import type { RecoveredSession } from "../src/persistence/index.js";

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

/** A /proc/{pid}/stat line whose field 22 (starttime) holds `startTicks`. */
function procStat(pid: number, startTicks: number): string {
  const betweenFlagsAndStarttime = Array.from({ length: 12 }, () => "0").join(" ");
  return `${pid} (codex exec) S 1 ${pid} ${pid} 0 -1 4194304 ${betweenFlagsAndStarttime} ${startTicks} 0 0\n`;
}

/** Serves /proc/stat with a fixed btime and /proc/{pid}/stat for the listed pids. */
function procFiles(startTicksByPid: Record<number, number>, btime = `btime ${BTIME_SECONDS}\n`) {
  return (path: string) => {
    if (path === "/proc/stat") {
      if (btime === "") throw new Error("EACCES");
      return `cpu 1 2 3\n${btime}processes 42\n`;
    }
    const match = /^\/proc\/(\d+)\/stat$/.exec(path);
    const ticks = match ? startTicksByPid[Number(match[1])] : undefined;
    if (ticks === undefined) throw new Error("ENOENT");
    return procStat(Number(match![1]), ticks);
  };
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

/** Kills the process on SIGTERM/SIGKILL so the reaper's liveness probe sees it exit. */
function killsOnSignal(): void {
  vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
    killCalls.push([pid, signal]);
    if (signal === 0 || signal === undefined) {
      if (dead.has(pid)) throw new Error("ESRCH");
      return true;
    }
    dead.add(pid);
    return true;
  }) as typeof process.kill);
}

/** Ignores termination signals so the reaper has to escalate to a force kill. */
function ignoresSignals(): void {
  vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
    killCalls.push([pid, signal]);
    if ((signal === 0 || signal === undefined) && dead.has(pid)) throw new Error("ESRCH");
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
    expect(summary).toEqual({ reaped: 0, alreadyDead: 0, skipped: 0 });
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  it("counts a pid that is already gone as already dead", async () => {
    setPlatform("linux");
    dead.add(900);
    killsOnSignal();

    const summary = await reapOrphanProcesses([session(900, new Date().toISOString())]);
    expect(summary).toEqual({ reaped: 0, alreadyDead: 1, skipped: 0 });
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  it("terminates a live process whose start time matches the recorded spawn time", async () => {
    setPlatform("linux");
    const spawnedAt = new Date("2024-05-05T10:00:00.000Z");
    execSyncMock.mockReturnValue(`${new Date(spawnedAt.getTime() + 2_000).toString()}\n`);
    killsOnSignal();

    const summary = await reapOrphanProcesses([session(901, spawnedAt.toISOString())]);

    expect(summary).toEqual({ reaped: 1, alreadyDead: 0, skipped: 0 });
    expect(execSyncMock.mock.calls[0]![0]).toBe("ps -p 901 -o lstart=");
    expect(killCalls).toContainEqual([901, "SIGTERM"]);
    expect(killCalls).not.toContainEqual([901, "SIGKILL"]);
  });

  it("skips a live process whose start time does not match — a reused pid", async () => {
    setPlatform("linux");
    execSyncMock.mockReturnValue(`${new Date("2024-05-05T18:00:00.000Z").toString()}\n`);
    killsOnSignal();

    const summary = await reapOrphanProcesses([
      session(902, new Date("2024-05-05T10:00:00.000Z").toISOString()),
    ]);

    expect(summary).toEqual({ reaped: 0, alreadyDead: 0, skipped: 1 });
    expect(killCalls.every(([, signal]) => signal === 0)).toBe(true);
  });

  it("skips a session whose recorded spawn time cannot be parsed", async () => {
    setPlatform("linux");
    killsOnSignal();

    const summary = await reapOrphanProcesses([session(903, "not-a-date")]);
    expect(summary).toEqual({ reaped: 0, alreadyDead: 0, skipped: 1 });
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  it("skips when neither ps nor /proc can report a start time", async () => {
    setPlatform("linux");
    execSyncMock.mockImplementation(() => {
      throw new Error("ps unavailable");
    });
    killsOnSignal();

    const summary = await reapOrphanProcesses([session(904, new Date().toISOString())]);
    expect(summary).toEqual({ reaped: 0, alreadyDead: 0, skipped: 1 });
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

    expect(summary).toEqual({ reaped: 1, alreadyDead: 0, skipped: 0 });
    expect(readFileSyncMock).toHaveBeenCalledWith("/proc/905/stat", "utf-8");
    expect(killCalls).toContainEqual([905, "SIGTERM"]);
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

    expect(summary).toEqual({ reaped: 0, alreadyDead: 0, skipped: 1 });
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

    const startMs = Date.now() - 3_600_000 + 123_450;
    const summary = await reapOrphanProcesses([session(913, new Date(startMs).toISOString())]);

    expect(summary).toEqual({ reaped: 1, alreadyDead: 0, skipped: 0 });
    expect(killCalls).toContainEqual([913, "SIGTERM"]);
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

    expect(summary).toEqual({ reaped: 0, alreadyDead: 0, skipped: 1 });
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

    expect(summary).toEqual({ reaped: 0, alreadyDead: 0, skipped: 1 });
    expect(killCalls.every(([, signal]) => signal === 0)).toBe(true);
  });

  it("force kills a process that ignores the graceful signal", async () => {
    setPlatform("linux");
    vi.useFakeTimers();
    const spawnedAt = new Date().toISOString();
    execSyncMock.mockReturnValue(new Date(Date.parse(spawnedAt) + 1_000).toString());
    ignoresSignals();

    const pending = reapOrphanProcesses([session(907, spawnedAt)]);
    await vi.advanceTimersByTimeAsync(6_000);
    const summary = await pending;

    expect(summary).toEqual({ reaped: 1, alreadyDead: 0, skipped: 0 });
    expect(killCalls).toContainEqual([907, "SIGTERM"]);
    expect(killCalls).toContainEqual([907, "SIGKILL"]);
  });

  it("reaps several sessions in one pass", async () => {
    setPlatform("linux");
    const spawnedAt = new Date("2024-05-05T10:00:00.000Z").toISOString();
    execSyncMock.mockImplementation((cmd: string) =>
      cmd.includes("910")
        ? `${new Date("2024-05-05T10:00:00.000Z").toString()}\n`
        : `${new Date("2024-05-05T22:00:00.000Z").toString()}\n`
    );
    dead.add(912);
    killsOnSignal();

    const summary = await reapOrphanProcesses([
      session(910, spawnedAt),
      session(911, spawnedAt),
      session(912, spawnedAt),
      sessionWithoutPid(),
    ]);

    expect(summary).toEqual({ reaped: 1, alreadyDead: 1, skipped: 1 });
    expect(killCalls).toContainEqual([910, "SIGTERM"]);
  });

  it("uses taskkill and the PowerShell creation time on Windows", async () => {
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

    expect(summary).toEqual({ reaped: 1, alreadyDead: 0, skipped: 0 });
    const command = execSyncMock.mock.calls[0]![0] as string;
    expect(command).toContain("powershell.exe");
    expect(command).toContain("Get-CimInstance Win32_Process -Filter 'ProcessId=920'");
    expect(execSyncMock.mock.calls.every(([cmd]) => !String(cmd).startsWith("wmic"))).toBe(true);
    expect(spawnMock).toHaveBeenCalledWith(
      "taskkill",
      ["/PID", "920"],
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

    expect(summary).toEqual({ reaped: 1, alreadyDead: 0, skipped: 0 });
    expect(execSyncMock.mock.calls[1]![0]).toBe(
      'wmic process where "ProcessId=921" get CreationDate /value'
    );
    expect(spawnMock).toHaveBeenCalledWith(
      "taskkill",
      ["/PID", "921"],
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

    expect(summary).toEqual({ reaped: 0, alreadyDead: 0, skipped: 1 });
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

    expect(summary).toEqual({ reaped: 0, alreadyDead: 0, skipped: 1 });
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
