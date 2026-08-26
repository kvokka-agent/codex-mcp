import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ExecClient } from "../src/app-server/exec-client.js";
import { Methods } from "../src/app-server/protocol.js";
import { _resetForTesting } from "../src/utils/codex-executable.js";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("child_process", async () => {
  const actual = await vi.importActual<typeof import("child_process")>("child_process");
  return { ...actual, spawn: spawnMock };
});

interface FakeProc extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { end: () => void };
  pid: number;
  killed: boolean;
  exitCode: number | null;
  kill: (signal?: NodeJS.Signals) => boolean;
  /** Signals sent straight to the child, as opposed to the process group. */
  killSignals: Array<NodeJS.Signals | undefined>;
}

const envBackup = { ...process.env };
const realPlatform = process.platform;
const killCalls: Array<[number, string | number | undefined]> = [];
let procs: FakeProc[] = [];

function setPlatform(platform: string): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

function newProc(pid: number): FakeProc {
  const proc = new EventEmitter() as FakeProc;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { end: vi.fn() };
  proc.pid = pid;
  proc.killed = false;
  proc.exitCode = null;
  proc.killSignals = [];
  proc.kill = (signal?: NodeJS.Signals) => {
    proc.killSignals.push(signal);
    proc.killed = true;
    return true;
  };
  return proc;
}

function lastProc(): FakeProc {
  return procs[procs.length - 1]!;
}

function spawnArgs(index = 0): string[] {
  return spawnMock.mock.calls[index]![1] as string[];
}

/** Feed one JSONL line (plus newline) through the client's stdout pipe. */
function emitLine(proc: FakeProc, obj: unknown): void {
  proc.stdout.emit("data", Buffer.from(JSON.stringify(obj) + "\n"));
}

async function startedClient(): Promise<{
  client: ExecClient;
  notifications: Array<[string, unknown]>;
}> {
  const client = new ExecClient();
  const notifications: Array<[string, unknown]> = [];
  client.onNotification((method, params) => notifications.push([method, params]));
  await client.start({ approvalPolicy: "on-request", sandbox: "workspace-write" });
  await client.threadStart({ cwd: "/work/repo" });
  return { client, notifications };
}

beforeEach(() => {
  // The client reads process.platform when it spawns and when it terminates a turn. Pinning it
  // keeps the POSIX branch under test on every host; the win32 branch has its own tests below.
  setPlatform("linux");
  procs = [];
  killCalls.length = 0;
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => {
    const proc = newProc(1000 + procs.length);
    procs.push(proc);
    return proc;
  });
  vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
    killCalls.push([pid, signal]);
    return true;
  }) as typeof process.kill);
  vi.spyOn(console, "error").mockImplementation(() => {});
  process.env.PATH = "";
  delete process.env.CODEX_MCP_PATH;
  delete process.env.CODEX_MCP_COMMAND;
  _resetForTesting();
});

afterEach(() => {
  setPlatform(realPlatform);
  for (const key of Object.keys(process.env)) {
    if (!(key in envBackup)) delete process.env[key];
  }
  Object.assign(process.env, envBackup);
  _resetForTesting();
  vi.restoreAllMocks();
});

describe("ExecClient lifecycle", () => {
  it("starts without spawning anything and reports the exec user agent", async () => {
    const client = new ExecClient();
    expect(await client.start({})).toEqual({ userAgent: "codex-exec" });
    expect(spawnMock).not.toHaveBeenCalled();
    expect(client.destroyed).toBe(false);
    expect(client.childPid).toBeUndefined();
  });

  it("reports every process it spawns, one per turn", async () => {
    const client = new ExecClient();
    const spawns: Array<{ pid: number; spawnedAt: string }> = [];
    client.on("spawn", (pid: number, spawnedAt: string) => spawns.push({ pid, spawnedAt }));

    await client.start({});
    await client.threadStart({ cwd: "/work/repo" });
    // No process exists yet: exec runs one per turn.
    expect(spawns).toEqual([]);

    await client.turnStart({ threadId: "t", input: [{ type: "text", text: "one" }] });
    const first = lastProc();
    expect(spawns.map((s) => s.pid)).toEqual([first.pid]);
    expect(Number.isNaN(Date.parse(spawns[0]!.spawnedAt))).toBe(false);

    emitLine(first, { type: "thread.started", thread_id: "thread_real" });
    await client.turnStart({ threadId: "t", input: [{ type: "text", text: "two" }] });
    expect(spawns.map((s) => s.pid)).toEqual([first.pid, lastProc().pid]);
    expect(client.childPid).toBe(lastProc().pid);
  });

  it("mints a distinct synthetic thread id per thread", async () => {
    const client = new ExecClient();
    await client.start({});
    const first = await client.threadStart({ cwd: "/work/repo" });
    const second = await client.threadStart({ cwd: "/work/other" });

    expect(first.thread.id).toMatch(/^exec_thread_[0-9a-f-]{12}$/);
    expect(second.thread.id).not.toBe(first.thread.id);
  });

  it("rejects fork and resume as unsupported in exec mode", async () => {
    const { client } = await startedClient();
    await expect(client.threadFork({ threadId: "t" })).rejects.toThrow(
      /Error \[EXEC_NOT_SUPPORTED\]: threadFork is not supported/
    );
    await expect(client.threadResume({ threadId: "t" })).rejects.toThrow(
      /Error \[EXEC_NOT_SUPPORTED\]: threadResume is not supported/
    );
    await expect(client.threadBackgroundTerminalsClean({ threadId: "t" })).rejects.toThrow(
      /Error \[EXEC_NOT_SUPPORTED\]: threadBackgroundTerminalsClean is not supported/
    );
  });

  it("refuses every operation after destroy", async () => {
    const { client } = await startedClient();
    await client.destroy();

    expect(client.destroyed).toBe(true);
    await expect(client.start({})).rejects.toThrow("Client destroyed");
    await expect(client.threadStart({ cwd: "/x" })).rejects.toThrow("Client destroyed");
    await expect(client.turnStart({ threadId: "t", input: [] })).rejects.toThrow(
      "Client destroyed"
    );
    await client.destroy();
  });

  it("refuses a turn before a thread exists", async () => {
    const client = new ExecClient();
    await client.start({});
    await expect(client.turnStart({ threadId: "t", input: [] })).rejects.toThrow(
      "No thread started"
    );
  });

  it("refuses to answer a server request it can never have raised", async () => {
    const { client } = await startedClient();
    client.onServerRequest(() => {});
    expect(() => client.respondToServer(1, {})).toThrow(
      /Error \[EXEC_NOT_SUPPORTED\]: cannot respond to server request id=1/
    );
    expect(() => client.respondErrorToServer(1, -32000, "nope")).toThrow(
      /Error \[EXEC_NOT_SUPPORTED\]: cannot respond to server request id=1/
    );
  });
});

describe("ExecClient argument building", () => {
  it("builds the first-turn command line from the turn and thread options", async () => {
    const client = new ExecClient();
    await client.start({ profile: "work", approvalPolicy: "never", config: { "a.b": 1 } });
    await client.threadStart({ cwd: "/thread/cwd", model: "gpt-5", sandbox: "read-only" });

    await client.turnStart({
      threadId: "t",
      input: [
        { type: "text", text: "first" },
        { type: "localImage", path: "/img/a.png" },
        { type: "text", text: "second" },
      ],
      model: "gpt-5-codex",
      sandboxPolicy: { type: "workspaceWrite" },
      cwd: "/turn/cwd",
      approvalPolicy: "on-request",
    });

    expect(spawnMock.mock.calls[0]![0]).toBe("codex");
    expect(spawnArgs()).toEqual([
      "exec",
      "first\nsecond",
      "--json",
      "--skip-git-repo-check",
      "-m",
      "gpt-5-codex",
      "-s",
      "workspace-write",
      "-p",
      "work",
      "-C",
      "/turn/cwd",
      "-i",
      "/img/a.png",
      "-c",
      "approval_policy=on-request",
      "-c",
      "a.b=1",
    ]);
    expect(client.childPid).toBe(lastProc().pid);
  });

  it("maps every sandbox policy to its exec flag", async () => {
    const cases: Array<[string, string]> = [
      ["readOnly", "read-only"],
      ["workspaceWrite", "workspace-write"],
      ["dangerFullAccess", "danger-full-access"],
    ];

    for (const [type, flag] of cases) {
      spawnMock.mockClear();
      const client = new ExecClient();
      await client.start({});
      await client.threadStart({ cwd: "/x" });
      await client.turnStart({
        threadId: "t",
        input: [{ type: "text", text: "p" }],
        sandboxPolicy: { type } as never,
      });
      expect(spawnArgs()).toContain(flag);
    }
  });

  it("falls back to the thread sandbox when the policy has no exec equivalent", async () => {
    const client = new ExecClient();
    await client.start({});
    await client.threadStart({ cwd: "/x", sandbox: "read-only" });
    await client.turnStart({
      threadId: "t",
      input: [{ type: "text", text: "p" }],
      sandboxPolicy: { type: "externalSandbox" } as never,
    });

    const args = spawnArgs();
    expect(args[args.indexOf("-s") + 1]).toBe("read-only");
  });

  it("serializes object config values as JSON", async () => {
    const client = new ExecClient();
    await client.start({});
    await client.threadStart({ cwd: "/x", config: { mcp: { enabled: true } } });
    await client.turnStart({ threadId: "t", input: [{ type: "text", text: "p" }] });

    expect(spawnArgs()).toContain('mcp={"enabled":true}');
  });

  it("writes the output schema to a temp file and removes it on destroy", async () => {
    const client = new ExecClient();
    await client.start({});
    await client.threadStart({ cwd: "/x" });
    await client.turnStart({
      threadId: "t",
      input: [{ type: "text", text: "p" }],
      outputSchema: { type: "object" },
    });

    const args = spawnArgs();
    const schemaPath = args[args.indexOf("--output-schema") + 1]!;
    expect(existsSync(schemaPath)).toBe(true);

    lastProc().exitCode = 0;
    await client.destroy();
    expect(existsSync(schemaPath)).toBe(false);
  });

  it("omits an empty output schema", async () => {
    const client = new ExecClient();
    await client.start({});
    await client.threadStart({ cwd: "/x" });
    await client.turnStart({
      threadId: "t",
      input: [{ type: "text", text: "p" }],
      outputSchema: {},
    });
    expect(spawnArgs()).not.toContain("--output-schema");
  });

  it("resumes the CLI thread on later turns and drops the unsupported overrides", async () => {
    const { client } = await startedClient();
    await client.turnStart({ threadId: "t", input: [{ type: "text", text: "one" }] });
    emitLine(lastProc(), { type: "thread.started", thread_id: "cli_thread_7" });

    expect(client.supportsTurnOverrides).toBe(true);

    await client.turnStart({
      threadId: "t",
      input: [
        { type: "text", text: "two" },
        { type: "localImage", path: "/img/b.png" },
      ],
      model: "gpt-5-codex",
      sandboxPolicy: { type: "readOnly" },
      cwd: "/ignored",
      outputSchema: { type: "object" },
      approvalPolicy: "never",
    });

    expect(spawnArgs(1)).toEqual([
      "exec",
      "resume",
      "cli_thread_7",
      "two",
      "--json",
      "--skip-git-repo-check",
      "-m",
      "gpt-5-codex",
      "-i",
      "/img/b.png",
      "-c",
      "approval_policy=never",
    ]);
    expect(client.supportsTurnOverrides).toBe(false);
  });

  it("warns and starts a fresh exec when the CLI never reported a thread id", async () => {
    const { client, notifications } = await startedClient();
    await client.turnStart({ threadId: "t", input: [{ type: "text", text: "one" }] });
    await client.turnStart({ threadId: "t", input: [{ type: "text", text: "two" }] });

    expect(spawnArgs(1)[0]).toBe("exec");
    expect(spawnArgs(1)[1]).toBe("two");
    expect(client.supportsTurnOverrides).toBe(true);

    const [method, params] = notifications.find(([m]) => m === Methods.ERROR)!;
    expect(method).toBe(Methods.ERROR);
    expect(params).toMatchObject({ willRetry: true });
    expect((params as { error: { message: string } }).error.message).toContain(
      "multi-turn context unavailable"
    );
  });

  it("refuses the turn when the output schema cannot be written to disk", async () => {
    // Every platform's os.tmpdir() reads one of these, so the temp dir the
    // client writes into does not exist and mkdtempSync fails.
    for (const key of ["TMPDIR", "TMP", "TEMP"]) {
      process.env[key] = join("/", "no-such-dir-for-codex-mcp-tests");
    }

    const client = new ExecClient();
    await client.start({});
    await client.threadStart({ cwd: "/x" });

    await expect(
      client.turnStart({
        threadId: "t",
        input: [{ type: "text", text: "p" }],
        outputSchema: { type: "object" },
      })
    ).rejects.toThrow(/Error \[INTERNAL\]: Failed to write the output schema/);
    // The turn the caller asked to be schema-constrained never ran.
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("names the overrides the resume command line could not carry", async () => {
    const { client } = await startedClient();
    await client.turnStart({
      threadId: "t",
      input: [{ type: "text", text: "one" }],
      sandboxPolicy: { type: "workspaceWrite" },
      cwd: "/work/repo",
    });
    emitLine(lastProc(), { type: "thread.started", thread_id: "cli_thread_7" });
    // The first turn carries every override on its command line.
    expect(client.unappliedTurnOverrides).toEqual([]);

    await client.turnStart({
      threadId: "t",
      input: [{ type: "text", text: "two" }],
      sandboxPolicy: { type: "readOnly" },
      cwd: "/other",
      outputSchema: { type: "object" },
      model: "gpt-5-codex",
    });

    expect(spawnArgs(1)).not.toContain("-s");
    expect(client.unappliedTurnOverrides).toEqual(["sandbox", "cwd", "outputSchema"]);
  });

  it("clears the unapplied overrides of the previous turn", async () => {
    const { client } = await startedClient();
    await client.turnStart({ threadId: "t", input: [{ type: "text", text: "one" }] });
    emitLine(lastProc(), { type: "thread.started", thread_id: "cli_thread_7" });
    await client.turnStart({
      threadId: "t",
      input: [{ type: "text", text: "two" }],
      sandboxPolicy: { type: "readOnly" },
    });
    expect(client.unappliedTurnOverrides).toEqual(["sandbox"]);

    await client.turnStart({ threadId: "t", input: [{ type: "text", text: "three" }] });
    expect(client.unappliedTurnOverrides).toEqual([]);
  });

  it("kills the previous turn process before starting the next", async () => {
    const { client } = await startedClient();
    await client.turnStart({ threadId: "t", input: [{ type: "text", text: "one" }] });
    const first = lastProc();

    await client.turnStart({ threadId: "t", input: [{ type: "text", text: "two" }] });
    expect(killCalls).toContainEqual([-first.pid, "SIGTERM"]);
  });

  it("kills the running process on interrupt", async () => {
    const { client } = await startedClient();
    await client.turnStart({ threadId: "t", input: [{ type: "text", text: "one" }] });

    await client.turnInterrupt({ threadId: "t", turnId: "x" });
    expect(killCalls).toContainEqual([-lastProc().pid, "SIGTERM"]);
  });
});

describe("ExecClient on Windows", () => {
  async function windowsTurn(): Promise<ExecClient> {
    setPlatform("win32");
    process.env.ComSpec = "C:\\Windows\\System32\\cmd.exe";
    const client = new ExecClient();
    await client.start({});
    await client.threadStart({ cwd: "D:\\work\\repo" });
    await client.turnStart({ threadId: "t", input: [{ type: "text", text: "go" }] });
    return client;
  }

  it("hands the command line to cmd.exe as separate tokens", async () => {
    await windowsTurn();

    const [cmd, args, opts] = spawnMock.mock.calls[0]! as [
      string,
      string[],
      Record<string, unknown>,
    ];
    expect(cmd).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(args).toEqual([
      "/d",
      "/s",
      "/c",
      "codex",
      "exec",
      "go",
      "--json",
      "--skip-git-repo-check",
      "-C",
      "D:\\work\\repo",
    ]);
    expect(opts.detached).toBe(false);
    expect(opts.windowsHide).toBe(true);
  });

  it("signals the child directly, since Windows has no POSIX process group", async () => {
    const client = await windowsTurn();

    await client.turnInterrupt({ threadId: "t", turnId: "x" });

    expect(lastProc().killSignals).toEqual(["SIGTERM"]);
    expect(killCalls).toEqual([]);
  });
});

describe("ExecClient event translation", () => {
  async function runningTurn() {
    const { client, notifications } = await startedClient();
    const turn = await client.turnStart({ threadId: "t", input: [{ type: "text", text: "go" }] });
    return { client, notifications, proc: lastProc(), turnId: turn.turn.id };
  }

  it("adopts the CLI thread id and republishes thread.started", async () => {
    const { notifications, proc } = await runningTurn();
    emitLine(proc, { type: "thread.started", threadId: "cli_thread_1" });

    expect(notifications).toContainEqual([
      Methods.THREAD_STARTED,
      { thread: { id: "cli_thread_1" } },
    ]);
  });

  it("reports turn.started with the synthetic turn id", async () => {
    const { notifications, proc, turnId } = await runningTurn();
    emitLine(proc, { type: "turn.started" });

    expect(notifications).toContainEqual([
      Methods.TURN_STARTED,
      { turn: { id: turnId, status: "inProgress" } },
    ]);
  });

  it("camel-cases item types and carries the agent message into the turn output", async () => {
    const { notifications, proc, turnId } = await runningTurn();
    emitLine(proc, { type: "item.started", item: { id: "i1", type: "command_execution" } });
    emitLine(proc, {
      type: "item.completed",
      item: { id: "i2", type: "agent_message", text: "hello" },
    });
    emitLine(proc, { type: "turn.completed", usage: { input_tokens: 5 } });

    expect(notifications).toContainEqual([
      Methods.ITEM_STARTED,
      { threadId: expect.any(String), turnId, item: { id: "i1", type: "commandExecution" } },
    ]);
    expect(notifications).toContainEqual([
      Methods.ITEM_COMPLETED,
      {
        threadId: expect.any(String),
        turnId,
        item: { id: "i2", type: "agentMessage", text: "hello" },
      },
    ]);
    expect(notifications).toContainEqual([
      Methods.TURN_COMPLETED,
      {
        threadId: expect.any(String),
        turn: { id: turnId, status: "completed", output: "hello", usage: { input_tokens: 5 } },
      },
    ]);
  });

  it("ignores item events without an item payload", async () => {
    const { notifications, proc } = await runningTurn();
    emitLine(proc, { type: "item.started" });
    emitLine(proc, { type: "item.completed" });

    expect(notifications.some(([m]) => m === Methods.ITEM_STARTED)).toBe(false);
    expect(notifications.some(([m]) => m === Methods.ITEM_COMPLETED)).toBe(false);
  });

  it("reports a failed turn with its error", async () => {
    const { notifications, proc, turnId } = await runningTurn();
    emitLine(proc, { type: "turn.failed", error: { message: "model exploded" } });

    expect(notifications).toContainEqual([
      Methods.TURN_COMPLETED,
      {
        threadId: expect.any(String),
        turn: { id: turnId, status: "failed", error: { message: "model exploded" } },
      },
    ]);
  });

  it("supplies a default message for a failed turn without one", async () => {
    const { notifications, proc } = await runningTurn();
    emitLine(proc, { type: "turn.failed" });

    const [, params] = notifications.find(([m]) => m === Methods.TURN_COMPLETED)!;
    expect(params).toMatchObject({ turn: { error: { message: "Turn failed" } } });
  });

  it("marks reconnect errors retryable and others terminal", async () => {
    const { notifications, proc } = await runningTurn();
    emitLine(proc, { type: "error", message: "Reconnecting... 1/5" });
    emitLine(proc, { type: "error", message: "auth token rejected" });

    const errors = notifications.filter(([m]) => m === Methods.ERROR).map(([, p]) => p);
    expect(errors[0]).toMatchObject({
      error: { message: "Reconnecting... 1/5" },
      willRetry: true,
    });
    expect(errors[1]).toMatchObject({
      error: { message: "auth token rejected" },
      willRetry: false,
    });
  });

  it("maps snake_case stream events onto app-server notifications", async () => {
    const { notifications, proc, turnId } = await runningTurn();
    emitLine(proc, { type: "agent_message_delta", delta: "he" });

    expect(notifications).toContainEqual([
      Methods.AGENT_MESSAGE_DELTA,
      { threadId: expect.any(String), turnId, type: "agent_message_delta", delta: "he" },
    ]);
  });

  it("applies retryable detection to stream_error", async () => {
    const { notifications, proc } = await runningTurn();
    emitLine(proc, { type: "stream_error", message: "reconnect in progress" });

    const [, params] = notifications.find(([m]) => m === Methods.ERROR)!;
    expect(params).toMatchObject({ error: { message: "reconnect in progress" }, willRetry: true });
  });

  it("falls back to the event type when stream_error carries no message", async () => {
    const { notifications, proc } = await runningTurn();
    emitLine(proc, { type: "stream_error" });

    const [, params] = notifications.find(([m]) => m === Methods.ERROR)!;
    expect(params).toMatchObject({ error: { message: "stream_error" }, willRetry: false });
  });

  it("translates the legacy task lifecycle events", async () => {
    const { notifications, proc } = await runningTurn();
    emitLine(proc, { type: "task_started", turn_id: "legacy_turn" });
    emitLine(proc, {
      type: "item.completed",
      item: { type: "agent_message", text: "legacy output" },
    });
    emitLine(proc, { type: "task_complete" });

    expect(notifications).toContainEqual([
      Methods.TURN_STARTED,
      { turn: { id: "legacy_turn", status: "inProgress" } },
    ]);
    expect(notifications).toContainEqual([
      Methods.TURN_COMPLETED,
      {
        threadId: expect.any(String),
        turn: { id: "legacy_turn", status: "completed", output: "legacy output" },
      },
    ]);
  });

  it("translates an aborted turn into a cancelled completion", async () => {
    const { notifications, proc, turnId } = await runningTurn();
    emitLine(proc, { type: "turn_aborted", reason: { message: "user interrupted" } });

    expect(notifications).toContainEqual([
      Methods.TURN_COMPLETED,
      {
        threadId: expect.any(String),
        turn: { id: turnId, status: "cancelled", error: { message: "user interrupted" } },
      },
    ]);
  });

  it("buffers a JSONL line split across chunks and skips noise", async () => {
    const { notifications, proc } = await runningTurn();
    proc.stdout.emit("data", Buffer.from('not json\n{"type":"turn.'));
    expect(notifications.some(([m]) => m === Methods.TURN_STARTED)).toBe(false);

    proc.stdout.emit("data", Buffer.from('started"}\n'));
    expect(notifications.some(([m]) => m === Methods.TURN_STARTED)).toBe(true);
  });

  it("logs unparsable and unmapped events without emitting", async () => {
    const errorSpy = vi.mocked(console.error);
    const { notifications, proc } = await runningTurn();
    const before = notifications.length;

    proc.stdout.emit("data", Buffer.from('{"type":"broken"\n'));
    emitLine(proc, { type: "totally_unknown_event" });

    expect(notifications).toHaveLength(before);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to parse JSONL"));
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Unmapped exec event type: totally_unknown_event")
    );
  });

  it("logs child stderr", async () => {
    const errorSpy = vi.mocked(console.error);
    const { proc } = await runningTurn();
    proc.stderr.emit("data", Buffer.from("boom\n"));

    expect(errorSpy).toHaveBeenCalledWith("[exec-client stderr] boom");
  });

  it("re-emits a spawn error", async () => {
    const { client, proc } = await runningTurn();
    const errors: Error[] = [];
    client.on("error", (err: Error) => errors.push(err));

    proc.emit("error", new Error("spawn failed"));
    expect(errors.map((e) => e.message)).toEqual(["spawn failed"]);
  });
});

describe("ExecClient process exit", () => {
  async function runningTurn() {
    const { client, notifications } = await startedClient();
    const turn = await client.turnStart({ threadId: "t", input: [{ type: "text", text: "go" }] });
    return { client, notifications, proc: lastProc(), turnId: turn.turn.id };
  }

  it("synthesizes a completed turn when the process exits cleanly", async () => {
    const { client, notifications, proc, turnId } = await runningTurn();
    emitLine(proc, { type: "item.completed", item: { type: "agent_message", text: "answer" } });

    const exits: Array<[number | null, NodeJS.Signals | null]> = [];
    client.on("exit", (code, signal) => exits.push([code, signal]));
    proc.emit("exit", 0, null);

    expect(notifications).toContainEqual([
      Methods.TURN_COMPLETED,
      {
        threadId: expect.any(String),
        turn: { id: turnId, status: "completed", output: "answer" },
      },
    ]);
    expect(exits).toEqual([[0, null]]);
    expect(client.childPid).toBeUndefined();
  });

  it("fails the turn when a clean exit follows a stream it could not read", async () => {
    const { notifications, proc, turnId } = await runningTurn();
    emitLine(proc, { type: "some_future_event_type" });
    proc.emit("exit", 0, null);

    const completion = notifications.find(([m]) => m === Methods.TURN_COMPLETED)!;
    const turn = (completion[1] as { turn: Record<string, unknown> }).turn;
    expect(turn.id).toBe(turnId);
    expect(turn.status).toBe("failed");
    expect(turn.output).toBeUndefined();
    expect(String((turn.error as { message: string }).message)).toContain(
      "without emitting any event this client understands (1 unmapped event(s), 0 unparseable record(s))"
    );
    expect(notifications).toContainEqual([
      Methods.ERROR,
      {
        threadId: expect.any(String),
        turnId,
        error: { message: expect.stringContaining("the turn outcome is unknown") },
        willRetry: false,
      },
    ]);
  });

  it("reports an error and a failed turn when the process exits non-zero", async () => {
    const { notifications, proc, turnId } = await runningTurn();
    proc.emit("exit", 3, null);

    expect(notifications).toContainEqual([
      Methods.ERROR,
      {
        threadId: expect.any(String),
        turnId,
        error: { message: "exec process exited with code 3" },
        willRetry: false,
      },
    ]);
    expect(notifications).toContainEqual([
      Methods.TURN_COMPLETED,
      {
        threadId: expect.any(String),
        turn: {
          id: turnId,
          status: "failed",
          output: undefined,
          error: { message: "exec process exited with code 3" },
        },
      },
    ]);
  });

  it("records the signal when the process is killed", async () => {
    const { notifications, proc, turnId } = await runningTurn();
    proc.emit("exit", null, "SIGKILL");

    expect(notifications).toContainEqual([
      Methods.TURN_COMPLETED,
      {
        threadId: expect.any(String),
        turn: {
          id: turnId,
          status: "failed",
          output: undefined,
          error: { message: "exec process killed by signal SIGKILL" },
        },
      },
    ]);
  });

  it("fails a completed turn whose stream lost a record instead of reporting an older message", async () => {
    const { notifications, proc, turnId } = await runningTurn();
    emitLine(proc, { type: "item.completed", item: { type: "agent_message", text: "draft" } });
    // The final message of the turn arrives truncated and is lost.
    proc.stdout.emit("data", Buffer.from('{"type":"item.completed","item":{"type":"agent_\n'));
    emitLine(proc, { type: "turn.completed" });

    const completion = notifications.find(([m]) => m === Methods.TURN_COMPLETED)!;
    const turn = (completion[1] as { turn: Record<string, unknown> }).turn;
    expect(turn.id).toBe(turnId);
    expect(turn.status).toBe("failed");
    expect(turn).not.toHaveProperty("output");
    expect(String((turn.error as { message: string }).message)).toContain(
      "lost 1 unparseable record(s)"
    );
  });

  it("keeps the CLI's own failure when the stream also lost a record", async () => {
    const { notifications, proc } = await runningTurn();
    proc.stdout.emit("data", Buffer.from('{"type":"item.compl\n'));
    emitLine(proc, { type: "turn.failed", error: { message: "model exploded" } });

    const completion = notifications.find(([m]) => m === Methods.TURN_COMPLETED)!;
    expect((completion[1] as { turn: Record<string, unknown> }).turn).toMatchObject({
      status: "failed",
      error: { message: "model exploded" },
    });
  });

  it("counts the lost records of one turn only", async () => {
    const { client, notifications, proc } = await runningTurn();
    proc.stdout.emit("data", Buffer.from('{"type":"item.compl\n'));
    emitLine(proc, { type: "thread.started", thread_id: "cli_thread_7" });
    emitLine(proc, { type: "turn.completed" });

    await client.turnStart({ threadId: "t", input: [{ type: "text", text: "next" }] });
    const second = lastProc();
    emitLine(second, { type: "item.completed", item: { type: "agent_message", text: "clean" } });
    emitLine(second, { type: "turn.completed" });

    const completions = notifications.filter(([m]) => m === Methods.TURN_COMPLETED);
    expect((completions[1]![1] as { turn: Record<string, unknown> }).turn).toMatchObject({
      status: "completed",
      output: "clean",
    });
  });

  it("does not synthesize a second completion after turn.completed", async () => {
    const { notifications, proc } = await runningTurn();
    emitLine(proc, { type: "turn.completed" });
    proc.emit("exit", 0, null);

    expect(notifications.filter(([m]) => m === Methods.TURN_COMPLETED)).toHaveLength(1);
  });

  it("stays silent when the process exits after destroy", async () => {
    const { client, notifications, proc } = await runningTurn();
    proc.exitCode = 0;
    await client.destroy();
    const before = notifications.length;

    proc.emit("exit", 1, null);
    expect(notifications).toHaveLength(before);
  });

  it("waits for the child to exit during destroy", async () => {
    const { client, proc } = await runningTurn();
    const pending = client.destroy();
    proc.emit("exit", 0, null);

    await expect(pending).resolves.toBeUndefined();
    expect(killCalls).toContainEqual([-proc.pid, "SIGTERM"]);
  });
});

describe("ExecClient error shape", () => {
  /** Every `error` notification the client emits, newest last. */
  function errorParams(
    notifications: Array<[string, unknown]>
  ): Array<{ error: unknown; willRetry: boolean }> {
    return notifications
      .filter(([m]) => m === Methods.ERROR)
      .map(([, p]) => p as { error: unknown; willRetry: boolean });
  }

  it("emits the protocol TurnError object from every branch that reports an error", async () => {
    const { client, notifications } = await startedClient();

    await client.turnStart({ threadId: "t", input: [{ type: "text", text: "one" }] });
    emitLine(lastProc(), { type: "error", message: "auth token rejected" });

    // Second turn without a CLI thread id: the client reports the lost context.
    await client.turnStart({ threadId: "t", input: [{ type: "text", text: "two" }] });
    lastProc().emit("exit", 7, null);

    const errors = errorParams(notifications);
    expect(errors).toHaveLength(3);
    for (const { error } of errors) {
      expect(typeof error).toBe("object");
      expect(error).not.toBeNull();
      expect(typeof (error as { message: unknown }).message).toBe("string");
    }
    expect(errors.map(({ error }) => (error as { message: string }).message)).toEqual([
      "auth token rejected",
      expect.stringContaining("multi-turn context unavailable"),
      "exec process exited with code 7",
    ]);
  });

  it("carries the fields the CLI put on an error object and adds none", async () => {
    const { client, notifications } = await startedClient();
    await client.turnStart({ threadId: "t", input: [{ type: "text", text: "go" }] });

    emitLine(lastProc(), {
      type: "error",
      error: {
        message: "usage limit reached",
        additionalDetails: "resets at 10:00",
        codexErrorInfo: { type: "usageLimitReached" },
      },
    });

    expect(errorParams(notifications)[0]!.error).toEqual({
      message: "usage limit reached",
      additionalDetails: "resets at 10:00",
      codexErrorInfo: { type: "usageLimitReached" },
    });
  });

  it("names the event type when the CLI error object carries no message", async () => {
    const { client, notifications } = await startedClient();
    await client.turnStart({ threadId: "t", input: [{ type: "text", text: "go" }] });

    emitLine(lastProc(), { type: "stream_error", error: { code: "ECONNRESET" } });

    expect(errorParams(notifications)[0]).toEqual({
      threadId: expect.any(String),
      turnId: expect.any(String),
      error: { code: "ECONNRESET", message: "stream_error" },
      willRetry: false,
    });
  });

  it("reads retryability from the message the CLI object carries", async () => {
    const { client, notifications } = await startedClient();
    await client.turnStart({ threadId: "t", input: [{ type: "text", text: "go" }] });

    emitLine(lastProc(), { type: "error", error: { message: "Reconnecting... 2/5" } });

    expect(errorParams(notifications)[0]).toMatchObject({
      error: { message: "Reconnecting... 2/5" },
      willRetry: true,
    });
  });

  it("reports no error notification when the process dies from a signal", async () => {
    const { client, notifications } = await startedClient();
    const turn = await client.turnStart({ threadId: "t", input: [{ type: "text", text: "go" }] });

    lastProc().emit("exit", null, "SIGTERM");

    expect(errorParams(notifications)).toEqual([]);
    const [, params] = notifications.find(([m]) => m === Methods.TURN_COMPLETED)!;
    expect(params).toMatchObject({
      turn: { id: turn.turn.id, error: { message: "exec process killed by signal SIGTERM" } },
    });
  });

  it("shapes a string turn error from the legacy abort event as a TurnError", async () => {
    const { client, notifications } = await startedClient();
    await client.turnStart({ threadId: "t", input: [{ type: "text", text: "go" }] });

    emitLine(lastProc(), { type: "turn_aborted", reason: "interrupted by user" });

    const [, params] = notifications.find(([m]) => m === Methods.TURN_COMPLETED)!;
    expect(params).toMatchObject({
      turn: { status: "cancelled", error: { message: "interrupted by user" } },
    });
  });
});
