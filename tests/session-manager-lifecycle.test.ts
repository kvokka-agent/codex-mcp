import { EventEmitter } from "events";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AppServerClient } from "../src/app-server/client.js";
import { Methods } from "../src/app-server/protocol.js";
import { SessionManager } from "../src/session/manager.js";
import { SessionPersistence } from "../src/session/persistence.js";
import type { RecoveredSession } from "../src/persistence/recovery-scanner.js";

class MockClient extends EventEmitter {
  notificationHandler: ((method: string, params: unknown) => void) | null = null;
  serverRequestHandler: ((id: number, method: string, params: unknown) => void) | null = null;

  threadStartResult: unknown = { thread: { id: "thread_mock" } };
  turnStartResult: unknown = { turn: { id: "turn_mock" } };

  supportsTurnOverrides = true;
  childPid: number | undefined = undefined;

  start = vi.fn(async () => ({ userAgent: "mock" }));
  threadStart = vi.fn(async () => this.threadStartResult);
  threadFork = vi.fn(async () => ({ thread: { id: "thread_forked" } }));
  threadResume = vi.fn(async () => ({ thread: { id: "thread_forked" } }));
  threadBackgroundTerminalsClean = vi.fn(async (_params: { threadId: string }) => ({}));
  turnStart = vi.fn(async (_params: unknown) => this.turnStartResult);
  turnInterrupt = vi.fn(async () => {});
  respondToServer = vi.fn((_id: number, _result: unknown) => {});
  respondErrorToServer = vi.fn((_id: number, _code: number, _message: string) => {});
  destroy = vi.fn(async () => {});

  onNotification(handler: (method: string, params: unknown) => void): void {
    this.notificationHandler = handler;
  }
  onServerRequest(handler: (id: number, method: string, params: unknown) => void): void {
    this.serverRequestHandler = handler;
  }
  emitNotification(method: string, params: unknown): void {
    this.notificationHandler?.(method, params);
  }
  emitServerRequest(id: number, method: string, params: unknown): void {
    this.serverRequestHandler?.(id, method, params);
  }
}

const workspace = path.resolve(os.tmpdir(), "codex-mcp-tests");

function internalSession(
  manager: SessionManager,
  sessionId: string
): { threadId?: string; status: string } {
  const sessions = (
    manager as unknown as { sessions: Map<string, { threadId?: string; status: string }> }
  ).sessions;
  return sessions.get(sessionId)!;
}

function recovered(overrides: Partial<RecoveredSession> = {}): RecoveredSession {
  const sessionId = (overrides.sessionId as string) ?? "sess_recovered";
  return {
    sessionId,
    meta: {
      schemaVersion: 1,
      sessionId,
      status: "idle",
      createdAt: "2024-01-01T00:00:00.000Z",
      lastActiveAt: "2024-01-01T00:01:00.000Z",
      threadId: "thread_recovered",
      cwd: workspace,
      ...(overrides.meta ?? {}),
    },
    events: overrides.events ?? [],
    lastSeq: overrides.lastSeq ?? -1,
    result: overrides.result ?? null,
    pidInfo: null,
    sessionDir: path.join(os.tmpdir(), sessionId),
  };
}

describe("SessionManager long-poll waiters", () => {
  let client: MockClient;
  let manager: SessionManager;

  beforeEach(() => {
    client = new MockClient();
    manager = new SessionManager({
      disableCleanup: true,
      createClient: () => client as unknown as AppServerClient,
    });
  });

  afterEach(() => {
    manager.destroy();
    vi.restoreAllMocks();
  });

  it("wakes every waiter when a notification arrives", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium");
    const settled: number[] = [];
    const waits = [0, 1, 2].map((i) =>
      manager.waitForChange(started.sessionId, 60_000).then(() => settled.push(i))
    );

    client.emitNotification(Methods.THREAD_ARCHIVED, { threadId: started.threadId });
    await Promise.all(waits);

    expect(settled.sort()).toEqual([0, 1, 2]);
  });

  it("resolves on its own deadline when nothing happens", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium");
    await expect(manager.waitForChange(started.sessionId, 5)).resolves.toBeUndefined();
  });

  it("refuses a fifth concurrent waiter and takes it again once the queue drains", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium");
    const waits = [0, 1, 2, 3].map(() => manager.waitForChange(started.sessionId, 60_000));

    await expect(manager.waitForChange(started.sessionId, 60_000)).rejects.toThrow(
      "Too many concurrent long-poll waiters"
    );

    client.emitNotification(Methods.THREAD_ARCHIVED, { threadId: started.threadId });
    await Promise.all(waits);

    // The drained queue accepts a full set again — no waiter was left behind.
    const second = [0, 1, 2, 3].map(() => manager.waitForChange(started.sessionId, 60_000));
    client.emitNotification(Methods.THREAD_ARCHIVED, { threadId: started.threadId });
    await Promise.all(second);
  });

  it("returns at once for an already aborted signal", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium");
    const controller = new AbortController();
    controller.abort();

    await expect(
      manager.waitForChange(started.sessionId, 60_000, controller.signal)
    ).resolves.toBeUndefined();
  });

  it("returns when the caller aborts mid-wait and frees the slot", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium");
    const controller = new AbortController();
    const wait = manager.waitForChange(started.sessionId, 60_000, controller.signal);

    controller.abort();
    await wait;

    const refill = [0, 1, 2, 3].map(() => manager.waitForChange(started.sessionId, 60_000));
    client.emitNotification(Methods.THREAD_ARCHIVED, { threadId: started.threadId });
    await Promise.all(refill);
  });
});

describe("SessionManager recovered sessions", () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager({ disableCleanup: true });
  });

  afterEach(() => {
    manager.destroy();
    vi.restoreAllMocks();
  });

  it("marks a session that was running at shutdown as failed", () => {
    manager.ingestRecovered([
      recovered({ sessionId: "sess_was_running", meta: { status: "running" } as never }),
    ]);

    const info = manager.getSession("sess_was_running");
    expect(info.status).toBe("error");
    expect(info.cancelledReason).toBe("Server restarted while session was active");
  });

  it("falls back to error for a status it does not know", () => {
    manager.ingestRecovered([
      recovered({ sessionId: "sess_weird", meta: { status: "banana" } as never }),
    ]);

    expect(manager.getSession("sess_weird").status).toBe("error");
  });

  it("keeps the first ingest of a session id and ignores a later duplicate", () => {
    manager.ingestRecovered([
      recovered({ sessionId: "sess_dup", meta: { status: "cancelled" } as never }),
    ]);
    manager.ingestRecovered([
      recovered({ sessionId: "sess_dup", meta: { status: "running" } as never }),
    ]);

    expect(manager.listSessions()).toHaveLength(1);
    expect(manager.getSession("sess_dup").status).toBe("cancelled");
  });

  it("keeps the completed result and its text", () => {
    manager.ingestRecovered([
      recovered({
        sessionId: "sess_done",
        result: { turnId: "turn_1", status: "completed", output: "final answer" },
      }),
    ]);

    expect(manager.getLastResult("sess_done")).toEqual({
      turnId: "turn_1",
      status: "completed",
      output: "final answer",
    });
  });

  it("restores only known event types and continues the id numbering", () => {
    manager.ingestRecovered([
      recovered({
        sessionId: "sess_events",
        lastSeq: 4,
        events: [
          { seq: 2, type: "output", data: { delta: "hello" }, timestamp: "2024-01-01T00:00:02Z" },
          { seq: 3, type: "telemetry", data: { ignored: true } },
          { seq: 4, type: "progress", data: { note: "kept" } },
        ],
      }),
    ]);

    const poll = manager.pollEvents("sess_events", 0, 50);
    expect(poll.events.map((event) => event.id)).toEqual([2, 4]);
    expect(poll.cursorResetTo).toBe(2);
    expect(poll.nextCursor).toBe(5);
  });

  it("summarizes a restored event whose payload has no known fields", () => {
    manager.ingestRecovered([
      recovered({
        sessionId: "sess_opaque",
        lastSeq: 0,
        events: [{ seq: 0, type: "progress", data: { unknownField: "x" } }],
      }),
    ]);

    const minimal = manager.pollEvents("sess_opaque", 0, 50, { responseMode: "minimal" });
    expect(minimal.events[0].data).toEqual({ summary: "omitted for minimal response mode" });

    const compact = manager.pollEvents("sess_opaque", 0, 50, { responseMode: "delta_compact" });
    expect(compact.events[0].data).toEqual({ unknownField: "x" });
  });

  it("passes a restored event whose payload is not an object straight through", () => {
    manager.ingestRecovered([
      recovered({
        sessionId: "sess_scalar",
        lastSeq: 0,
        events: [{ seq: 0, type: "progress", data: "plain text" }],
      }),
    ]);

    const poll = manager.pollEvents("sess_scalar", 0, 50, {
      responseMode: "minimal",
      pollOptions: { skipDeltas: true },
    });
    expect(poll.events[0].data).toBe("plain text");
  });

  it("resumes the event log sequence for a recovered session", () => {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), "codex-mcp-recover-"));
    const persistence = new SessionPersistence(stateDir);
    const recoverManager = new SessionManager({ disableCleanup: true, persistence });
    const setNextSeq = vi.spyOn(persistence, "setEventLogNextSeq");
    try {
      recoverManager.ingestRecovered([recovered({ sessionId: "sess_seq", lastSeq: 7 })]);
      expect(setNextSeq).toHaveBeenCalledWith("sess_seq", 8);
    } finally {
      recoverManager.destroy();
      persistence.destroy();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

describe("SessionManager session operations", () => {
  let client: MockClient;
  let manager: SessionManager;

  beforeEach(() => {
    client = new MockClient();
    manager = new SessionManager({
      disableCleanup: true,
      createClient: () => client as unknown as AppServerClient,
    });
  });

  afterEach(() => {
    manager.destroy();
    vi.restoreAllMocks();
  });

  it("cleans background terminals and records the request as an event", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium");

    await manager.cleanBackgroundTerminals(started.sessionId);

    expect(client.threadBackgroundTerminalsClean).toHaveBeenCalledWith({
      threadId: started.threadId,
    });
    const poll = manager.pollEvents(started.sessionId, 0, 50);
    const cleaned = poll.events.find(
      (event) =>
        (event.data as Record<string, unknown>)?.method ===
        Methods.THREAD_BACKGROUND_TERMINALS_CLEAN
    );
    expect(cleaned).toBeDefined();
    expect((cleaned!.data as Record<string, unknown>).status).toBe("requested");
  });

  it("refuses to clean background terminals of a cancelled session", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium");
    await manager.cancelSession(started.sessionId, "by test");

    // The session exists and was cancelled — CANCELLED, never SESSION_NOT_FOUND.
    await expect(manager.cleanBackgroundTerminals(started.sessionId)).rejects.toThrow(
      `Error [CANCELLED]: Session '${started.sessionId}' has been cancelled and cannot be cleaned`
    );
    expect(client.threadBackgroundTerminalsClean).not.toHaveBeenCalled();
  });

  it("refuses to interrupt a cancelled session", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium");
    await manager.cancelSession(started.sessionId, "by test");

    await expect(manager.interruptSession(started.sessionId)).rejects.toThrow(
      `Error [CANCELLED]: Session '${started.sessionId}' has been cancelled and cannot be interrupted`
    );
    expect(client.turnInterrupt).not.toHaveBeenCalled();
  });

  it("refuses to fork a cancelled session", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium");
    await manager.cancelSession(started.sessionId, "by test");

    await expect(manager.forkSession(started.sessionId)).rejects.toThrow(
      `Error [CANCELLED]: Session '${started.sessionId}' has been cancelled and cannot be forked`
    );
    expect(client.threadFork).not.toHaveBeenCalled();
  });

  it("reports an unknown session as not found on every session operation", async () => {
    await expect(manager.replyToSession("sess_missing", "hi")).rejects.toThrow(
      "Error [SESSION_NOT_FOUND]: Session 'sess_missing' not found"
    );
    await expect(manager.interruptSession("sess_missing")).rejects.toThrow(
      "Error [SESSION_NOT_FOUND]: Session 'sess_missing' not found"
    );
    await expect(manager.cleanBackgroundTerminals("sess_missing")).rejects.toThrow(
      "Error [SESSION_NOT_FOUND]: Session 'sess_missing' not found"
    );
    await expect(manager.forkSession("sess_missing")).rejects.toThrow(
      "Error [SESSION_NOT_FOUND]: Session 'sess_missing' not found"
    );
  });

  it("refuses to clean background terminals without a threadId", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium");
    internalSession(manager, started.sessionId).threadId = undefined;

    await expect(manager.cleanBackgroundTerminals(started.sessionId)).rejects.toThrow(
      "has no threadId, cannot clean background terminals"
    );
  });

  it("refuses to interrupt a running turn it has no turn id for", async () => {
    client.turnStartResult = {};
    const started = await manager.createSession("hi", workspace, {}, "medium");
    expect(started.status).toBe("running");
    expect(started.progress.phase).toBe("starting");

    await expect(manager.interruptSession(started.sessionId)).rejects.toThrow(
      "Missing threadId or activeTurnId for interrupt"
    );
    expect(client.turnInterrupt).not.toHaveBeenCalled();
  });

  it("starts no new turn on a cancelled session", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium");
    const turnsBefore = client.turnStart.mock.calls.length;
    await manager.cancelSession(started.sessionId, "by test");

    await expect(manager.replyToSession(started.sessionId, "again")).rejects.toThrow(
      `Error [CANCELLED]: Session '${started.sessionId}' has been cancelled and cannot be resumed`
    );
    expect(client.turnStart.mock.calls.length).toBe(turnsBefore);
    expect(manager.getSession(started.sessionId).status).toBe("cancelled");
  });

  it("takes the turn id from a legacy turn/start response", async () => {
    client.turnStartResult = { turnId: "turn_v1" };
    const started = await manager.createSession("hi", workspace, {}, "medium");

    expect(started.progress.activeTurnId).toBe("turn_v1");
  });

  it("keeps no active turn when turn/start answers with a non-object", async () => {
    client.turnStartResult = null;
    const started = await manager.createSession("hi", workspace, {}, "medium");

    expect(started.progress.activeTurnId).toBeUndefined();
  });

  it("stays cancelled when cancelled a second time", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium");
    await manager.cancelSession(started.sessionId, "first reason");
    await manager.cancelSession(started.sessionId, "second reason");

    const info = manager.getSession(started.sessionId);
    expect(info.cancelledReason).toBe("first reason");
    expect(client.destroy).toHaveBeenCalledTimes(1);
  });

  it("records the pid of the forked app-server process", async () => {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), "codex-mcp-fork-"));
    const persistence = new SessionPersistence(stateDir);
    const forkClient = new MockClient();
    forkClient.childPid = 4242;
    const queue: MockClient[] = [client, forkClient];
    const forkManager = new SessionManager({
      disableCleanup: true,
      persistence,
      createClient: () => queue.shift()! as unknown as AppServerClient,
    });
    const writePid = vi.spyOn(persistence, "writePidInfo");
    try {
      const started = await forkManager.createSession(
        "hi",
        workspace,
        { model: "gpt-a" },
        "medium"
      );
      const forked = await forkManager.forkSession(started.sessionId);

      expect(forked.status).toBe("idle");
      expect(writePid).toHaveBeenCalledWith(forked.sessionId, 4242, { model: "gpt-a" });
    } finally {
      forkManager.destroy();
      persistence.destroy();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("refuses to reply to a session without a threadId", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium");
    client.emitNotification(Methods.TURN_COMPLETED, {
      threadId: started.threadId,
      turn: { id: "turn_1", status: "completed", output: "done" },
    });
    internalSession(manager, started.sessionId).threadId = undefined;

    await expect(manager.replyToSession(started.sessionId, "again")).rejects.toThrow(
      "has no threadId, cannot reply"
    );
  });

  it("refuses to fork a session without a threadId", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium");
    internalSession(manager, started.sessionId).threadId = undefined;

    await expect(manager.forkSession(started.sessionId)).rejects.toThrow("No threadId to fork");
    expect(client.threadFork).not.toHaveBeenCalled();
  });

  it("fails session start when thread/start answers with something that is not an object", async () => {
    client.threadStartResult = "nope";

    await expect(manager.createSession("hi", workspace, {}, "medium")).rejects.toThrow(
      "Invalid thread response: expected object"
    );
    expect(manager.listSessions()).toHaveLength(0);
  });

  it("fails session start when thread/start answers without a thread id", async () => {
    client.threadStartResult = { thread: {} };

    await expect(manager.createSession("hi", workspace, {}, "medium")).rejects.toThrow(
      "Invalid thread response: missing thread id"
    );
  });

  it("sends validated local images alongside the prompt", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "codex-mcp-images-"));
    const image = path.join(dir, "shot.png");
    writeFileSync(image, "png");
    try {
      await manager.createSession("look", dir, {}, "medium", { images: ["shot.png"] });

      const input = (client.turnStart.mock.calls[0][0] as { input: unknown[] }).input;
      expect(input).toEqual([
        { type: "text", text: "look" },
        { type: "localImage", path: image },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("surfaces a friendly error when the effort fallback retry also fails", async () => {
    client.turnStart = vi.fn(async () => {
      throw new Error("minimal reasoning effort is incompatible with web_search");
    });

    await expect(manager.createSession("hi", workspace, {}, "minimal" as never)).rejects.toThrow(
      "effort=minimal is incompatible with the Codex web_search tool"
    );
    expect(client.turnStart).toHaveBeenCalledTimes(2);
  });

  it("reports the pending action kinds and forgets them once answered", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium");
    client.emitServerRequest(1, Methods.COMMAND_APPROVAL, {
      itemId: "item_1",
      threadId: started.threadId,
      turnId: "turn_1",
      command: "echo hi",
      cwd: workspace,
    });
    client.emitServerRequest(2, Methods.USER_INPUT_REQUEST, {
      itemId: "item_2",
      threadId: started.threadId,
      turnId: "turn_1",
      questions: [{ id: "q1", question: "which?" }],
    });

    expect(manager.getPendingActionTypes(started.sessionId).sort()).toEqual([
      "approval",
      "user_input",
    ]);

    const poll = manager.pollEvents(started.sessionId, 0, 50);
    for (const action of poll.actions!) {
      if (action.kind === "user_input") {
        manager.resolveUserInput(started.sessionId, action.requestId, { q1: { answers: ["a"] } });
      } else {
        manager.resolveApproval(started.sessionId, action.requestId, "accept");
      }
    }
    expect(manager.getPendingActionTypes(started.sessionId)).toEqual([]);
  });

  it("ignores cancelled and model-less sessions when guessing the default model", async () => {
    const first = await manager.createSession("hi", workspace, { model: "gpt-a" }, "medium");
    await manager.cancelSession(first.sessionId, "by test");
    await manager.createSession("hi", workspace, {}, "medium");

    expect(manager.getObservedDefaultModel()).toBeNull();
  });

  it("writes session metadata once per status change", async () => {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), "codex-mcp-meta-"));
    const persistence = new SessionPersistence(stateDir);
    const persistManager = new SessionManager({
      disableCleanup: true,
      persistence,
      createClient: () => client as unknown as AppServerClient,
    });
    const writeMeta = vi.spyOn(persistence, "writeSessionMeta");
    try {
      const started = await persistManager.createSession("hi", workspace, {}, "medium");
      const afterStart = writeMeta.mock.calls.length;

      client.emitNotification(Methods.TURN_COMPLETED, {
        threadId: started.threadId,
        turn: { id: "turn_1", status: "completed", output: "done" },
      });
      const afterIdle = writeMeta.mock.calls.length;
      expect(afterIdle).toBe(afterStart + 1);

      client.emitNotification(Methods.TURN_COMPLETED, {
        threadId: started.threadId,
        turn: { id: "turn_2", status: "completed", output: "done again" },
      });
      expect(writeMeta.mock.calls.length).toBe(afterIdle);
    } finally {
      persistManager.destroy();
      persistence.destroy();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

describe("SessionManager notification handling", () => {
  let client: MockClient;
  let manager: SessionManager;

  beforeEach(() => {
    client = new MockClient();
    manager = new SessionManager({
      disableCleanup: true,
      createClient: () => client as unknown as AppServerClient,
    });
  });

  afterEach(() => {
    manager.destroy();
    vi.restoreAllMocks();
  });

  it("adopts the thread id the thread/started notification carries", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium");

    client.emitNotification(Methods.THREAD_STARTED, {
      thread: { id: "thread_real", status: "active" },
    });

    const info = manager.getSession(started.sessionId, true) as { threadId?: string };
    expect(info.threadId).toBe("thread_real");
    const poll = manager.pollEvents(started.sessionId, 0, 50);
    const event = poll.events.find(
      (e) => (e.data as Record<string, unknown>)?.method === Methods.THREAD_STARTED
    );
    expect((event!.data as Record<string, unknown>).threadId).toBe("thread_real");
    expect((event!.data as Record<string, unknown>).status).toBe("active");
  });

  it("drops a command output delta that is nothing but shell profile noise", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium");

    client.emitNotification(Methods.COMMAND_OUTPUT_DELTA, {
      itemId: "item_1",
      turnId: "turn_1",
      delta: "WARNING: oh-my-posh update available",
    });

    expect(manager.pollEvents(started.sessionId, 0, 50).events).toHaveLength(0);
  });

  it("keeps a command output delta that is not a string", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium");

    client.emitNotification(Methods.COMMAND_OUTPUT_DELTA, {
      itemId: "item_1",
      turnId: "turn_1",
      delta: { chunks: ["a"] },
    });

    const poll = manager.pollEvents(started.sessionId, 0, 50);
    expect(poll.events).toHaveLength(1);
    expect((poll.events[0].data as { delta: unknown }).delta).toEqual({ chunks: ["a"] });
  });

  it("ignores a notification method it has no case for", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium");

    client.emitNotification("account/somethingNew", { whatever: true });

    expect(manager.pollEvents(started.sessionId, 0, 50).events).toHaveLength(0);
  });

  it("uses the last completed agent message when the turn carries no output", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium");

    client.emitNotification(Methods.ITEM_COMPLETED, {
      threadId: started.threadId,
      item: { id: "item_1", type: "agentMessage", status: "completed", text: "the answer" },
    });
    client.emitNotification(Methods.TURN_COMPLETED, {
      threadId: started.threadId,
      turn: { id: "turn_1", status: "completed" },
    });

    const result = manager.getLastResult(started.sessionId);
    expect(result?.text).toBe("the answer");
    expect(result?.output).toBeUndefined();
  });

  it("reads a fractional progress value as a percentage", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium");

    client.emitNotification(Methods.MCP_TOOL_PROGRESS, {
      itemId: "item_1",
      turnId: "turn_1",
      progress: 0.25,
    });

    expect(manager.getProgress(started.sessionId).percent).toBe(25);
  });

  it("reads a whole progress value as a percentage", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium");

    client.emitNotification(Methods.MCP_TOOL_PROGRESS, {
      itemId: "item_1",
      turnId: "turn_1",
      percent: 42,
    });

    expect(manager.getProgress(started.sessionId).percent).toBe(42);
  });

  it("merges reported token usage without letting it become the last method", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium");

    client.emitNotification(Methods.REASONING_TEXT_DELTA, { turnId: "turn_mock", delta: "a" });
    client.emitNotification(Methods.THREAD_TOKEN_USAGE_UPDATED, {
      usage: { inputTokens: 10, outputTokens: 4 },
    });
    client.emitNotification(Methods.THREAD_TOKEN_USAGE_UPDATED, {
      usage: { outputTokens: 9, totalTokens: 19 },
    });

    const progress = manager.getProgress(started.sessionId);
    expect(progress.tokens).toEqual({ input: 10, output: 9, total: 19 });
    expect(progress.lastMethod).toBe(Methods.REASONING_TEXT_DELTA);
    expect(progress.phase).toBe("reasoning");
  });

  it("ignores a turn start and an error that arrive after cancellation", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium");
    await manager.cancelSession(started.sessionId, "by test");
    const before = manager.pollEvents(started.sessionId, 0, 50).events.length;

    client.emitNotification(Methods.TURN_STARTED, { turn: { id: "turn_late", status: "active" } });
    client.emitNotification(Methods.ERROR, { message: "late boom", willRetry: false });

    const after = manager.pollEvents(started.sessionId, 0, 50);
    expect(after.events.length).toBe(before);
    expect(manager.getSession(started.sessionId).status).toBe("cancelled");
  });

  it("redacts an error notification that carries a bare string error", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium");

    client.emitNotification(Methods.ERROR, {
      error: "failed reading /home/someone/secret/file.txt",
      willRetry: false,
    });

    const poll = manager.pollEvents(started.sessionId, 0, 50);
    const errorEvent = poll.events.find((event) => event.type === "error")!;
    const data = errorEvent.data as Record<string, unknown>;
    expect(data.error).toContain("<path>");
    expect(data.error).not.toContain("/home/someone/secret");
  });

  it("survives a notification that carries no params", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium");

    client.emitNotification(Methods.MCP_TOOL_PROGRESS, null);

    const progress = manager.getProgress(started.sessionId);
    expect(progress.lastMethod).toBe(Methods.MCP_TOOL_PROGRESS);
    expect(progress.percent).toBeUndefined();
  });

  it("turns a subprocess error into a terminal session error", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium");

    client.emit("error", new Error("spawn /usr/local/bin/codex failed"));

    const info = manager.getSession(started.sessionId);
    expect(info.status).toBe("error");
    const result = manager.getLastResult(started.sessionId);
    expect(result?.status).toBe("error");
    expect(result?.error).toContain("app-server error:");
    expect(result?.error).not.toContain("/usr/local/bin/codex");
    const poll = manager.pollEvents(started.sessionId, 0, 50);
    expect(poll.events.some((event) => event.type === "error")).toBe(true);
  });
});

describe("SessionManager server-initiated requests", () => {
  let client: MockClient;
  let manager: SessionManager;
  let errors: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    client = new MockClient();
    manager = new SessionManager({
      disableCleanup: true,
      createClient: () => client as unknown as AppServerClient,
    });
    errors = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    manager.destroy();
    vi.restoreAllMocks();
  });

  it("rejects a dynamic tool call it cannot serve", async () => {
    await manager.createSession("hi", workspace, {}, "medium");

    client.emitServerRequest(10, Methods.DYNAMIC_TOOL_CALL, { name: "whatever" });

    expect(client.respondToServer).toHaveBeenCalledWith(10, {
      success: false,
      contentItems: [{ type: "inputText", text: "Not supported by codex-mcp" }],
    });
  });

  it("denies a legacy approval request and reports it", async () => {
    await manager.createSession("hi", workspace, {}, "medium");

    client.emitServerRequest(11, Methods.LEGACY_PATCH_APPROVAL, { patch: "x" });

    expect(client.respondToServer).toHaveBeenCalledWith(11, { decision: "denied" });
    expect(
      errors.mock.calls.some((call) => String(call[0]).includes("Legacy approval request received"))
    ).toBe(true);
  });

  it("answers an unknown server request with method-not-found", async () => {
    await manager.createSession("hi", workspace, {}, "medium");

    client.emitServerRequest(12, "item/tool/unknownThing", {});

    expect(client.respondErrorToServer).toHaveBeenCalledWith(
      12,
      -32601,
      "Unhandled server request: item/tool/unknownThing"
    );
  });

  it("answers requests that arrive after cancellation without reopening the session", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium");
    await manager.cancelSession(started.sessionId, "by test");

    client.emitServerRequest(20, Methods.USER_INPUT_REQUEST, { questions: [] });
    client.emitServerRequest(21, Methods.DYNAMIC_TOOL_CALL, { name: "x" });
    client.emitServerRequest(22, Methods.LEGACY_EXEC_APPROVAL, { command: "x" });
    client.emitServerRequest(23, "item/tool/unknownThing", {});

    expect(client.respondToServer).toHaveBeenCalledWith(20, { answers: {} });
    expect(client.respondToServer).toHaveBeenCalledWith(21, {
      success: false,
      contentItems: [{ type: "inputText", text: "Session is terminal" }],
    });
    expect(client.respondToServer).toHaveBeenCalledWith(22, { decision: "denied" });
    expect(client.respondErrorToServer).toHaveBeenCalledWith(
      23,
      -32601,
      "Unhandled server request: item/tool/unknownThing"
    );
    expect(manager.getSession(started.sessionId).status).toBe("cancelled");
  });

  it("reports every pending request the client refuses to answer during cancellation", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium");
    client.emitServerRequest(30, Methods.COMMAND_APPROVAL, {
      itemId: "item_1",
      threadId: started.threadId,
      turnId: "turn_1",
      command: "echo hi",
      cwd: workspace,
    });
    client.emitServerRequest(31, Methods.FILE_CHANGE_APPROVAL, {
      itemId: "item_2",
      threadId: started.threadId,
      turnId: "turn_1",
    });
    client.emitServerRequest(32, Methods.USER_INPUT_REQUEST, {
      itemId: "item_3",
      threadId: started.threadId,
      turnId: "turn_1",
      questions: [{ id: "q1", question: "which?" }],
    });
    client.respondToServer = vi.fn(() => {
      throw new Error("pipe closed");
    });

    await manager.cancelSession(started.sessionId, "by test");

    const reported = errors.mock.calls.filter((call) =>
      String(call[0]).includes("Failed to respond pending request during cancel")
    );
    expect(reported).toHaveLength(3);
    expect(reported.map((call) => String(call[0])).join(" ")).toContain("pipe closed");
    expect(manager.getSession(started.sessionId).pendingRequestCount).toBe(0);
  });
});

describe("SessionManager approval timeouts", () => {
  let client: MockClient;
  let manager: SessionManager;
  let errors: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    client = new MockClient();
    manager = new SessionManager({
      disableCleanup: true,
      createClient: () => client as unknown as AppServerClient,
    });
    errors = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    manager.destroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("auto-declines a file change approval and lets the turn run on", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium", {
      approvalTimeoutMs: 1000,
    });
    client.emitServerRequest(40, Methods.FILE_CHANGE_APPROVAL, {
      itemId: "item_1",
      threadId: started.threadId,
      turnId: "turn_1",
      reason: "writes a file",
    });
    expect(manager.getSession(started.sessionId).status).toBe("waiting_approval");

    await vi.advanceTimersByTimeAsync(1000);

    expect(client.respondToServer).toHaveBeenCalledWith(40, { decision: "decline" });
    const info = manager.getSession(started.sessionId);
    expect(info.status).toBe("running");
    expect(info.pendingRequestCount).toBe(0);
    const poll = manager.pollEvents(started.sessionId, 0, 50);
    const timedOut = poll.events.find(
      (event) => (event.data as Record<string, unknown>)?.timeout === true
    );
    expect(timedOut).toBeDefined();
    expect((timedOut!.data as Record<string, unknown>).kind).toBe("fileChange");
    expect((timedOut!.data as Record<string, unknown>).decision).toBe("decline");
  });

  it("reports a command approval whose auto-decline cannot be delivered", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium", {
      approvalTimeoutMs: 1000,
    });
    client.emitServerRequest(41, Methods.COMMAND_APPROVAL, {
      itemId: "item_1",
      threadId: started.threadId,
      turnId: "turn_1",
      command: "echo hi",
      cwd: workspace,
    });
    client.respondToServer = vi.fn(() => {
      throw new Error("pipe closed");
    });

    await vi.advanceTimersByTimeAsync(1000);

    expect(
      errors.mock.calls.some((call) =>
        String(call[0]).includes("Failed to auto-decline command approval timeout")
      )
    ).toBe(true);
    expect(manager.getSession(started.sessionId).pendingRequestCount).toBe(0);
  });

  it("reports a file change approval whose auto-decline cannot be delivered", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium", {
      approvalTimeoutMs: 1000,
    });
    client.emitServerRequest(42, Methods.FILE_CHANGE_APPROVAL, {
      itemId: "item_1",
      threadId: started.threadId,
      turnId: "turn_1",
    });
    client.respondToServer = vi.fn(() => {
      throw new Error("pipe closed");
    });

    await vi.advanceTimersByTimeAsync(1000);

    expect(
      errors.mock.calls.some((call) =>
        String(call[0]).includes("Failed to auto-decline file-change approval timeout")
      )
    ).toBe(true);
  });

  it("reports a user input request whose empty answer cannot be delivered", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium", {
      approvalTimeoutMs: 1000,
    });
    client.emitServerRequest(43, Methods.USER_INPUT_REQUEST, {
      itemId: "item_1",
      threadId: started.threadId,
      turnId: "turn_1",
      questions: [{ id: "q1", question: "which?" }],
    });
    client.respondToServer = vi.fn(() => {
      throw new Error("pipe closed");
    });

    await vi.advanceTimersByTimeAsync(1000);

    expect(
      errors.mock.calls.some((call) =>
        String(call[0]).includes("Failed to auto-answer user-input timeout")
      )
    ).toBe(true);
    expect(manager.getSession(started.sessionId).pendingRequestCount).toBe(0);
  });
});

describe("SessionManager approval decision validation", () => {
  let client: MockClient;
  let manager: SessionManager;

  beforeEach(() => {
    client = new MockClient();
    manager = new SessionManager({
      disableCleanup: true,
      createClient: () => client as unknown as AppServerClient,
    });
  });

  afterEach(() => {
    manager.destroy();
    vi.restoreAllMocks();
  });

  async function openCommandApproval(
    extra: Record<string, unknown> = {}
  ): Promise<{ sessionId: string; requestId: string }> {
    const started = await manager.createSession("hi", workspace, {}, "medium");
    client.emitServerRequest(50, Methods.COMMAND_APPROVAL, {
      itemId: "item_1",
      threadId: started.threadId,
      turnId: "turn_1",
      command: "echo hi",
      cwd: workspace,
      ...extra,
    });
    const poll = manager.pollEvents(started.sessionId, 0, 50);
    return { sessionId: started.sessionId, requestId: poll.actions![0].requestId };
  }

  it("refuses a decision the prompt did not advertise", async () => {
    const { sessionId, requestId } = await openCommandApproval({
      availableDecisions: ["accept", "decline"],
    });

    expect(() => manager.resolveApproval(sessionId, requestId, "acceptForSession")).toThrow(
      "is not available for this approval prompt"
    );
    expect(manager.getSession(sessionId).pendingRequestCount).toBe(1);
  });

  it("refuses a decision the protocol does not define", async () => {
    const { sessionId, requestId } = await openCommandApproval();

    expect(() => manager.resolveApproval(sessionId, requestId, "maybe")).toThrow(
      "Invalid command decision 'maybe'"
    );
  });

  it("refuses an execpolicy amendment on a plain accept", async () => {
    const { sessionId, requestId } = await openCommandApproval();

    expect(() =>
      manager.resolveApproval(sessionId, requestId, "accept", {
        execpolicy_amendment: ["allow echo"],
      })
    ).toThrow("execpolicy_amendment is only valid for acceptWithExecpolicyAmendment");
  });

  it("refuses a network policy amendment with an action that is neither allow nor deny", async () => {
    const { sessionId, requestId } = await openCommandApproval({
      availableDecisions: ["accept", { applyNetworkPolicyAmendment: {} }],
    });

    expect(() =>
      manager.resolveApproval(sessionId, requestId, "applyNetworkPolicyAmendment", {
        network_policy_amendment: { action: "maybe", host: "example.com" } as never,
      })
    ).toThrow("network_policy_amendment.action must be 'allow' or 'deny'");
  });

  it("refuses a network policy amendment without a host", async () => {
    const { sessionId, requestId } = await openCommandApproval({
      availableDecisions: ["accept", { applyNetworkPolicyAmendment: {} }],
    });

    expect(() =>
      manager.resolveApproval(sessionId, requestId, "applyNetworkPolicyAmendment", {
        network_policy_amendment: { action: "allow" } as never,
      })
    ).toThrow("network_policy_amendment.host required");
  });

  it("sends the nested decision for an advertised execpolicy amendment", async () => {
    const { sessionId, requestId } = await openCommandApproval({
      availableDecisions: ["accept", { acceptWithExecpolicyAmendment: {} }],
    });

    manager.resolveApproval(sessionId, requestId, "acceptWithExecpolicyAmendment", {
      execpolicy_amendment: ["allow echo"],
    });

    expect(client.respondToServer).toHaveBeenCalledWith(50, {
      decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["allow echo"] } },
    });
    expect(manager.getSession(sessionId).pendingRequestCount).toBe(0);
  });

  it("refuses acceptWithExecpolicyAmendment without an amendment", async () => {
    const { sessionId, requestId } = await openCommandApproval({
      availableDecisions: ["accept", { acceptWithExecpolicyAmendment: {} }],
    });

    expect(() =>
      manager.resolveApproval(sessionId, requestId, "acceptWithExecpolicyAmendment")
    ).toThrow("execpolicy_amendment required for acceptWithExecpolicyAmendment");
  });

  it("refuses applyNetworkPolicyAmendment without an amendment", async () => {
    const { sessionId, requestId } = await openCommandApproval({
      availableDecisions: ["accept", { applyNetworkPolicyAmendment: {} }],
    });

    expect(() =>
      manager.resolveApproval(sessionId, requestId, "applyNetworkPolicyAmendment")
    ).toThrow("network_policy_amendment required for applyNetworkPolicyAmendment");
  });

  it("refuses a network policy amendment on a plain accept", async () => {
    const { sessionId, requestId } = await openCommandApproval();

    expect(() =>
      manager.resolveApproval(sessionId, requestId, "accept", {
        network_policy_amendment: { action: "allow", host: "example.com" },
      })
    ).toThrow("network_policy_amendment is only valid for applyNetworkPolicyAmendment");
  });

  it("refuses to treat a user input request as an approval", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium");
    client.emitServerRequest(51, Methods.USER_INPUT_REQUEST, {
      itemId: "item_1",
      threadId: started.threadId,
      turnId: "turn_1",
      questions: [{ id: "q1", question: "which?" }],
    });
    const poll = manager.pollEvents(started.sessionId, 0, 50);
    const requestId = poll.actions![0].requestId;

    expect(() => manager.resolveApproval(started.sessionId, requestId, "accept")).toThrow(
      "is not an approval request"
    );
  });
});
