import { afterEach, describe, expect, it, jest } from "bun:test";
import { EventEmitter } from "node:events";
import { detectClientMode } from "../src/app-server/detect.js";
import { advanceAsync } from "./helpers/clock.js";
import { mockModule } from "./helpers/mock.js";

const { spawnMock } = { spawnMock: jest.fn() };

const realModule1 = { ...(await import("node:child_process")) };
mockModule("child_process", realModule1, () => {
  const actual = realModule1;
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
  jest.useRealTimers();
  jest.restoreAllMocks();
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

  it("retries a probe that timed out instead of reading the timeout as an answer", async () => {
    jest.useFakeTimers();
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const hanging = fakeProc();
    const answering = fakeProc();
    spawnMock
      .mockImplementationOnce(() => hanging)
      .mockImplementationOnce(() => {
        queueMicrotask(() => answering.emit("exit", 0));
        return answering;
      });

    const pending = detectClientMode("codex", false, {});
    await advanceAsync(5_000);
    expect(killed).toEqual(["SIGTERM"]);

    await expect(pending).resolves.toBe("app-server");
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(errorSpy.mock.calls.flat().join(" ")).toContain("retrying once with 10000ms");
  });

  it("kills both probes and falls back to exec when the binary never answers", async () => {
    jest.useFakeTimers();
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    spawnMock.mockImplementation(() => fakeProc());

    const pending = detectClientMode("codex", false, {});
    await advanceAsync(5_000);
    await advanceAsync(10_000);

    await expect(pending).resolves.toBe("exec");
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(killed).toEqual(["SIGTERM", "SIGTERM"]);

    // The fallback is reported as a fallback, not as a reading of the binary.
    const logged = errorSpy.mock.calls.flat().join(" ");
    expect(logged).toContain("no answer");
    expect(logged).toContain("probe still running after 10000ms");
    expect(logged).toContain("CODEX_MCP_MODE");
    expect(logged).not.toContain("not supported");
  });

  it("names an unsupported binary differently from a probe that gave no answer", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    procThatExits(2, "", "error: unrecognized subcommand 'app-server'");
    await expect(detectClientMode("codex", false, {})).resolves.toBe("exec");
    expect(errorSpy.mock.calls.flat().join(" ")).toContain("not supported");

    errorSpy.mockClear();
    procThatExits(1, "", "permission denied");
    await expect(detectClientMode("codex", false, {})).resolves.toBe("exec");
    const logged = errorSpy.mock.calls.flat().join(" ");
    expect(logged).toContain("no answer");
    expect(logged).toContain("permission denied");
  });

  it("reports the spawn failure rather than calling the subcommand unknown", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const proc = fakeProc();
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => proc.emit("error", new Error("ENOENT")));
      return proc;
    });

    await expect(detectClientMode("missing-codex", false, {})).resolves.toBe("exec");
    // A binary that cannot run says nothing about app-server, so no retry either.
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const logged = errorSpy.mock.calls.flat().join(" ");
    expect(logged).toContain("probe process failed to run: ENOENT");
    expect(logged).not.toContain("not supported");
  });

  it("force kills a probe that survives the graceful signal", async () => {
    jest.useFakeTimers();
    spawnMock.mockImplementation(() => {
      const proc = fakeProc();
      proc.kill = (signal?: NodeJS.Signals) => {
        killed.push(signal ?? "SIGTERM");
        return true;
      };
      return proc;
    });

    const pending = detectClientMode("codex", false, {});
    await advanceAsync(7_000);
    expect(killed).toEqual(["SIGTERM", "SIGKILL"]);

    await advanceAsync(12_000);
    await expect(pending).resolves.toBe("exec");
    expect(killed).toEqual(["SIGTERM", "SIGKILL", "SIGTERM", "SIGKILL"]);
  });

  it("ignores a late exit after the probe already settled", async () => {
    jest.useFakeTimers();
    const first = fakeProc();
    const second = fakeProc();
    spawnMock.mockImplementationOnce(() => first).mockImplementationOnce(() => second);

    const pending = detectClientMode("codex", false, {});
    await advanceAsync(5_000);
    // The timed-out probe exits cleanly after the retry already started; its
    // answer belongs to a settled probe and must not decide the mode.
    first.emit("exit", 0);
    await advanceAsync(10_000);

    await expect(pending).resolves.toBe("exec");
  });
});
