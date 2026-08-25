import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { detectClientMode } from "../src/app-server/detect.js";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("child_process", async () => {
  const actual = await vi.importActual<typeof import("child_process")>("child_process");
  return { ...actual, spawn: spawnMock };
});

interface FakeProc extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  killed: boolean;
  exitCode: number | null;
  kill: (signal?: NodeJS.Signals) => boolean;
}

const killed: NodeJS.Signals[] = [];

function fakeProc(): FakeProc {
  const proc = new EventEmitter() as FakeProc;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.killed = false;
  proc.exitCode = null;
  proc.kill = (signal?: NodeJS.Signals) => {
    killed.push(signal ?? "SIGTERM");
    proc.killed = true;
    return true;
  };
  return proc;
}

/** Queue a process whose streams emit `out`/`err` and which then exits with `code`. */
function procThatExits(code: number | null, out = "", err = ""): FakeProc {
  const proc = fakeProc();
  spawnMock.mockImplementation(() => {
    queueMicrotask(() => {
      if (out) proc.stdout.emit("data", Buffer.from(out));
      if (err) proc.stderr.emit("data", Buffer.from(err));
      proc.emit("exit", code);
    });
    return proc;
  });
  return proc;
}

afterEach(() => {
  spawnMock.mockReset();
  killed.length = 0;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("detectClientMode", () => {
  it("honours the CODEX_MCP_MODE override without probing", async () => {
    await expect(detectClientMode("codex", false, { CODEX_MCP_MODE: "app-server" })).resolves.toBe(
      "app-server"
    );
    await expect(detectClientMode("codex", false, { CODEX_MCP_MODE: "exec" })).resolves.toBe(
      "exec"
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("probes `app-server --help` when the override is absent or unrecognized", async () => {
    procThatExits(0);
    await expect(
      detectClientMode("/opt/bin/codex", true, { CODEX_MCP_MODE: "nonsense" })
    ).resolves.toBe("app-server");

    const [cmd, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(cmd).toBe("/opt/bin/codex");
    expect(args).toEqual(["app-server", "--help"]);
  });

  it("reports app-server when the probe exits cleanly", async () => {
    procThatExits(0);
    await expect(detectClientMode("codex", false, {})).resolves.toBe("app-server");
  });

  it("reports exec when the binary calls the subcommand unknown", async () => {
    procThatExits(2, "", "error: unrecognized subcommand 'app-server'");
    await expect(detectClientMode("codex", false, {})).resolves.toBe("exec");
  });

  it("reports app-server when a non-zero exit still documents the subcommand", async () => {
    procThatExits(1, "Usage: codex app-server [OPTIONS]");
    await expect(detectClientMode("codex", false, {})).resolves.toBe("app-server");
  });

  it("reports exec when a non-zero exit says nothing about app-server", async () => {
    procThatExits(1, "", "permission denied");
    await expect(detectClientMode("codex", false, {})).resolves.toBe("exec");
  });

  it("reports exec when the binary cannot be spawned", async () => {
    const proc = fakeProc();
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => proc.emit("error", new Error("ENOENT")));
      return proc;
    });

    await expect(detectClientMode("missing-codex", false, {})).resolves.toBe("exec");
  });

  it("kills the probe and reports exec when it hangs", async () => {
    vi.useFakeTimers();
    const proc = fakeProc();
    spawnMock.mockReturnValue(proc);

    const pending = detectClientMode("codex", false, {});
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(pending).resolves.toBe("exec");
    expect(killed).toEqual(["SIGTERM"]);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(killed).toEqual(["SIGTERM"]);
  });

  it("force kills a probe that survives the graceful signal", async () => {
    vi.useFakeTimers();
    const proc = fakeProc();
    proc.kill = (signal?: NodeJS.Signals) => {
      killed.push(signal ?? "SIGTERM");
      return true;
    };
    spawnMock.mockReturnValue(proc);

    const pending = detectClientMode("codex", false, {});
    await vi.advanceTimersByTimeAsync(7_000);
    await expect(pending).resolves.toBe("exec");
    expect(killed).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("ignores a late exit after the probe already settled", async () => {
    vi.useFakeTimers();
    const proc = fakeProc();
    spawnMock.mockReturnValue(proc);

    const pending = detectClientMode("codex", false, {});
    await vi.advanceTimersByTimeAsync(5_000);
    proc.emit("exit", 0);

    await expect(pending).resolves.toBe("exec");
  });
});
