import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reapOrphanProcesses } from "../src/session/orphan-reaper.js";
import type { RecoveredSession } from "../src/persistence/index.js";

const { execSyncMock, spawnMock, readFileSyncMock } = vi.hoisted(() => ({
  execSyncMock: vi.fn(),
  spawnMock: vi.fn(),
  readFileSyncMock: vi.fn(),
}));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, execSync: execSyncMock, spawn: spawnMock };
});

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, default: actual, readFileSync: readFileSyncMock };
});

const realPlatform = process.platform;
const dead = new Set<number>();
const killCalls: Array<[number, string | number | undefined]> = [];

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

  it("falls back to the /proc start tick when ps is unavailable", async () => {
    setPlatform("linux");
    execSyncMock.mockImplementation(() => {
      throw new Error("ps unavailable");
    });
    readFileSyncMock.mockReturnValue(
      `905 (codex exec) S 1 905 905 0 -1 4194304 ${Array.from({ length: 16 }, () => "0").join(" ")} 1234567 0 0`
    );
    killsOnSignal();

    const summary = await reapOrphanProcesses([
      session(905, new Date(Date.now() - 60_000).toISOString()),
    ]);

    expect(summary).toEqual({ reaped: 1, alreadyDead: 0, skipped: 0 });
    expect(readFileSyncMock).toHaveBeenCalledWith("/proc/905/stat", "utf-8");
  });

  it("skips the /proc fallback when the recorded spawn time is older than a day", async () => {
    setPlatform("linux");
    execSyncMock.mockImplementation(() => {
      throw new Error("ps unavailable");
    });
    readFileSyncMock.mockReturnValue(
      `906 (codex) S 1 906 906 0 -1 4194304 ${Array.from({ length: 16 }, () => "0").join(" ")} 999 0 0`
    );
    killsOnSignal();

    const summary = await reapOrphanProcesses([
      session(906, new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()),
    ]);

    expect(summary).toEqual({ reaped: 0, alreadyDead: 0, skipped: 1 });
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

  it("uses taskkill and the WMI creation date on Windows", async () => {
    setPlatform("win32");
    execSyncMock.mockReturnValue("\r\r\nCreationDate=20240505100001.123456+000\r\r\n");
    killsOnSignal();
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      dead.add(Number(args[1]));
      return {};
    });

    const summary = await reapOrphanProcesses([
      session(920, new Date("2024-05-05T10:00:00.000Z").toISOString()),
    ]);

    expect(summary).toEqual({ reaped: 1, alreadyDead: 0, skipped: 0 });
    expect(execSyncMock.mock.calls[0]![0]).toBe(
      'wmic process where "ProcessId=920" get CreationDate /value'
    );
    expect(spawnMock).toHaveBeenCalledWith(
      "taskkill",
      ["/PID", "920"],
      expect.objectContaining({ windowsHide: true })
    );
  });

  it("skips on Windows when WMI reports no creation date", async () => {
    setPlatform("win32");
    execSyncMock.mockReturnValue("No Instance(s) Available.");
    killsOnSignal();

    const summary = await reapOrphanProcesses([
      session(921, new Date("2024-05-05T10:00:00.000Z").toISOString()),
    ]);

    expect(summary).toEqual({ reaped: 0, alreadyDead: 0, skipped: 1 });
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
