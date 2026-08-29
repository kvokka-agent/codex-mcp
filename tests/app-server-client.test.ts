import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from "bun:test";
import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { Methods } from "../src/app-server/protocol.js";
import { _resetForTesting } from "../src/utils/codex-executable.js";
import { mockModule } from "./helpers/mock.js";

const spawnMock = jest.fn();

const realModule1 = { ...(await import("node:child_process")) };
mockModule("child_process", realModule1, () => {
  const actual = realModule1;
  return { ...actual, spawn: spawnMock };
});

function createMockProcess() {
  const proc = new EventEmitter() as unknown as {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: PassThrough & { write: PassThrough["write"] };
    killed: boolean;
    exitCode: number | null;
    pid: number;
    kill: (signal?: NodeJS.Signals | number) => boolean;
    on: EventEmitter["on"];
    emit: EventEmitter["emit"];
  };

  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.stdin = new PassThrough() as typeof proc.stdin;
  proc.killed = false;
  proc.exitCode = null;
  proc.pid = 4242;
  proc.kill = () => {
    proc.killed = true;
    proc.exitCode = 0;
    proc.emit("exit", 0, null);
    return true;
  };

  let buffered = "";
  const origWrite = proc.stdin.write.bind(proc.stdin);
  proc.stdin.write = ((chunk: unknown, encoding?: unknown, cb?: unknown) => {
    const str = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    buffered += str;

    let nl = buffered.indexOf("\n");
    while (nl !== -1) {
      const line = buffered.slice(0, nl).trim();
      buffered = buffered.slice(nl + 1);
      nl = buffered.indexOf("\n");

      if (!line) continue;
      const msg = JSON.parse(line) as { id?: number; method?: string };
      if (msg.id && msg.method === "initialize") {
        const resp = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { userAgent: "mock" } });
        proc.stdout.write(Buffer.from(`${resp}\n`, "utf8"));
      }
    }

    return origWrite(chunk as never, encoding as never, cb as never);
  }) as typeof proc.stdin.write;

  return proc;
}

/**
 * PATH-sensitive env names differ by platform, and getPathEntries() reads whichever is set,
 * so all of them are pinned while a spawn is measured.
 */
const PINNED_ENV_KEYS = ["PATH", "Path", "path", "CODEX_MCP_PATH", "CODEX_MCP_COMMAND"] as const;

let binDir: string;
let fakeCodex: string;
let envBackup: Record<string, string | undefined>;

function pinEnv(overrides: Record<string, string | undefined>): void {
  for (const key of PINNED_ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  _resetForTesting();
}

async function spawnAppServer(): Promise<[string, string[], Record<string, unknown>]> {
  const proc = createMockProcess();
  spawnMock.mockReturnValue(proc);

  const mod = await import("../src/app-server/client.js");
  const client = new mod.AppServerClient();
  const out = await client.start({ approvalPolicy: "never", sandbox: "read-only" });
  expect(out.userAgent).toBe("mock");

  expect(spawnMock).toHaveBeenCalledTimes(1);
  return spawnMock.mock.calls[0] as [string, string[], Record<string, unknown>];
}

describe("AppServerClient spawn behavior", () => {
  beforeAll(() => {
    binDir = mkdtempSync(path.join(os.tmpdir(), "codex-mcp-spawn-"));
    // Auto-detection accepts the first PATH hit; on Windows a bare name only matches with a
    // PATHEXT suffix, so the stub carries .exe there.
    fakeCodex = path.join(binDir, process.platform === "win32" ? "codex.exe" : "codex");
    writeFileSync(fakeCodex, "#!/bin/sh\nexit 0\n");
    chmodSync(fakeCodex, 0o755);
  });

  afterAll(() => {
    rmSync(binDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    envBackup = Object.fromEntries(PINNED_ENV_KEYS.map((key) => [key, process.env[key]]));
  });

  afterEach(() => {
    for (const key of PINNED_ENV_KEYS) {
      const value = envBackup[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    _resetForTesting();
    spawnMock.mockReset();
  });

  it("spawns the codex found on PATH with the app-server arguments", async () => {
    pinEnv({ PATH: binDir });

    const [cmd, args, spawnOpts] = await spawnAppServer();

    expect(cmd).toBe(fakeCodex);
    expect(args).toEqual([
      "app-server",
      "-c",
      "approval_policy=never",
      "-c",
      "sandbox_mode=read-only",
    ]);

    if (process.platform === "win32") {
      expect(spawnOpts.detached).toBe(false);
      expect(spawnOpts.windowsHide).toBe(true);
    } else {
      expect(spawnOpts.detached).toBe(true);
      expect(spawnOpts.windowsHide).toBe(false);
    }
    expect(spawnOpts.stdio).toEqual(["pipe", "pipe", "pipe"]);
  });

  it("spawns the executable named by CODEX_MCP_PATH instead of searching PATH", async () => {
    pinEnv({ PATH: binDir, CODEX_MCP_PATH: fakeCodex });

    const [cmd] = await spawnAppServer();

    expect(cmd).toBe(fakeCodex);
  });

  it("falls back to the bare command when PATH holds no codex", async () => {
    pinEnv({ PATH: path.join(binDir, "empty") });

    const [cmd, args] = await spawnAppServer();

    if (process.platform === "win32") {
      // Windows cannot spawn a bare name: resolution ends at the ComSpec fallback, which passes
      // the command to cmd.exe as its own argument token.
      expect(cmd.toLowerCase()).toMatch(/cmd\.exe$/);
      expect(args.slice(0, 5)).toEqual(["/d", "/s", "/c", "codex", "app-server"]);
    } else {
      expect(cmd).toBe("codex");
      expect(args[0]).toBe("app-server");
    }
  });

  it("uses extended timeout for startup RPCs", async () => {
    const mod = await import("../src/app-server/client.js");
    const client = new mod.AppServerClient();

    const requestSpy = jest.fn(async () => ({}));
    (
      client as unknown as {
        request: (method: string, params?: unknown, timeout?: number) => Promise<unknown>;
      }
    ).request = requestSpy;

    await client.threadStart({ cwd: "D:\\Lab\\repo" });
    await client.turnStart({ threadId: "thread_1", input: [{ type: "text", text: "hi" }] });
    await client.threadStart({ cwd: "D:\\Lab\\repo" }, 45_000);

    expect(requestSpy).toHaveBeenNthCalledWith(
      1,
      Methods.THREAD_START,
      { cwd: "D:\\Lab\\repo" },
      90000
    );
    expect(requestSpy).toHaveBeenNthCalledWith(
      2,
      Methods.TURN_START,
      { threadId: "thread_1", input: [{ type: "text", text: "hi" }] },
      90000
    );
    expect(requestSpy).toHaveBeenNthCalledWith(
      3,
      Methods.THREAD_START,
      { cwd: "D:\\Lab\\repo" },
      45000
    );
  });

  it("terminates process when queued writes are dropped because stdin is not writable", async () => {
    const mod = await import("../src/app-server/client.js");
    const client = new mod.AppServerClient();

    const internal = client as unknown as {
      process: {
        stdin: { writable: boolean };
        pid: number;
        kill: (signal?: NodeJS.Signals | number) => boolean;
      } | null;
      writeQueue: string[];
      queuedBytes: number;
      flushWriteQueue: () => void;
      terminate: (signal: NodeJS.Signals) => void;
    };

    internal.process = {
      stdin: { writable: false },
      pid: 4242,
      kill: () => true,
    };
    internal.writeQueue = ['{"jsonrpc":"2.0","id":1}\n'];
    internal.queuedBytes = internal.writeQueue[0].length;

    const terminateSpy = jest
      .spyOn(internal as unknown as { terminate: (signal: NodeJS.Signals) => void }, "terminate")
      .mockImplementation(() => {});

    internal.flushWriteQueue();

    expect(terminateSpy).toHaveBeenCalledWith("SIGTERM");
    expect(internal.writeQueue).toHaveLength(0);
    expect(internal.queuedBytes).toBe(0);
  });
});
