import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
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
}

const envBackup = { ...process.env };
const killCalls: Array<[number, string | number | undefined]> = [];
let procs: FakeProc[] = [];

function newProc(pid: number): FakeProc {
  const proc = new EventEmitter() as FakeProc;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { end: vi.fn() };
  proc.pid = pid;
  proc.killed = false;
  proc.exitCode = null;
  proc.kill = () => {
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
    await expect(client.threadBackgroundTerminalsClean({ threadId: "t" })).resolves.toEqual({});
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

  it("accepts server responses as no-ops", async () => {
    const { client } = await startedClient();
    client.onServerRequest(() => {});
    expect(() => client.respondToServer(1, {})).not.toThrow();
    expect(() => client.respondErrorToServer(1, -32000, "nope")).not.toThrow();
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
    expect((params as { error: string }).error).toContain("multi-turn context unavailable");
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
    expect(errors[0]).toMatchObject({ error: "Reconnecting... 1/5", willRetry: true });
    expect(errors[1]).toMatchObject({ error: "auth token rejected", willRetry: false });
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
    expect(params).toMatchObject({ error: "reconnect in progress", willRetry: true });
  });

  it("falls back to the event type when stream_error carries no message", async () => {
    const { notifications, proc } = await runningTurn();
    emitLine(proc, { type: "stream_error" });

    const [, params] = notifications.find(([m]) => m === Methods.ERROR)!;
    expect(params).toMatchObject({ error: "stream_error", willRetry: false });
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
