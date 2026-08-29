import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppServerClient } from "../src/app-server/client.js";
import { Methods } from "../src/app-server/protocol.js";
import { type RecoveredSession, SCHEMA_VERSION } from "../src/persistence/recovery-scanner.js";
import { SessionManager } from "../src/session/manager.js";
import { SessionPersistence } from "../src/session/persistence.js";
import { advanceAsync } from "./helpers/clock.js";

class MockClient extends EventEmitter {
  notificationHandler: ((method: string, params: unknown) => void) | null = null;
  serverRequestHandler: ((id: number, method: string, params: unknown) => void) | null = null;

  threadStartResult: unknown = { thread: { id: "thread_mock" } };
  turnStartResult: unknown = { turn: { id: "turn_mock" } };

  supportsTurnOverrides = true;
  /** Undefined unless a test makes this client report what its last turn dropped. */
  unappliedTurnOverrides: readonly string[] | undefined = undefined;
  childPid: number | undefined = undefined;

  /** Spawn instant reported with the "spawn" event, as the real clients report theirs. */
  spawnedAt = "2024-05-05T10:00:00.000Z";

  start = jest.fn(async () => {
    if (this.childPid !== undefined) this.emit("spawn", this.childPid, this.spawnedAt);
    return { userAgent: "mock" };
  });
  threadStart = jest.fn(async () => this.threadStartResult);
  threadFork = jest.fn(async () => ({ thread: { id: "thread_forked" } }));
  threadResume = jest.fn(async () => ({ thread: { id: "thread_forked" } }));
  threadBackgroundTerminalsClean = jest.fn(async (_params: { threadId: string }) => ({}));
  turnStart = jest.fn(async (_params: unknown) => this.turnStartResult);
  turnInterrupt = jest.fn(async () => {});
  respondToServer = jest.fn((_id: number, _result: unknown) => {});
  respondErrorToServer = jest.fn((_id: number, _code: number, _message: string) => {});
  destroy = jest.fn(async () => {});

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
      schemaVersion: SCHEMA_VERSION,
      sessionId,
      status: "idle",
      createdAt: "2024-01-01T00:00:00.000Z",
      lastActiveAt: "2024-01-01T00:01:00.000Z",
      threadId: "thread_recovered",
      cwd: workspace,
      ...(overrides.meta ?? {}),
    },
    lastSeq: overrides.lastSeq ?? -1,
    result: overrides.result ?? null,
    pidInfo: null,
    owner: overrides.owner ?? { kind: "unowned" },
    ...(overrides.lastActivity ? { lastActivity: overrides.lastActivity } : {}),
    sessionDir: path.join(os.tmpdir(), sessionId),
  };
}

/**
 * The events the manager wrote to a session's log.
 *
 * `codex_check` reports the state of a session and none of this; the log on disk is
 * where the events of the turn go, so it is where a test reads them.
 */
function loggedEvents(
  persistence: SessionPersistence,
  stateDir: string,
  sessionId: string
): Array<{ seq: number; type: string; data: Record<string, unknown> }> {
  persistence.flushAll();
  const file = path.join(stateDir, "sessions", sessionId, "events.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf-8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map(
      (line) => JSON.parse(line) as { seq: number; type: string; data: Record<string, unknown> }
    );
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
    jest.restoreAllMocks();
  });

  it("wakes every waiter when the turn ends", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium");
    const settled: number[] = [];
    const waits = [0, 1, 2].map((i) =>
      manager.waitForChange(started.sessionId, 60_000).then(() => settled.push(i))
    );

    client.emitNotification(Methods.TURN_COMPLETED, {
      threadId: started.threadId,
      turnId: "turn_1",
      turn: { id: "turn_1", status: "completed" },
    });
    await Promise.all(waits);

    expect(settled.sort()).toEqual([0, 1, 2]);
  });

  it("leaves a waiter asleep through the delta and token traffic of a turn", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium");
    let woke = false;
    const wait = manager.waitForChange(started.sessionId, 60_000).then(() => {
      woke = true;
    });

    for (let i = 0; i < 20; i++) {
      client.emitNotification(Methods.AGENT_MESSAGE_DELTA, {
        threadId: started.threadId,
        turnId: "turn_1",
        itemId: "item_1",
        delta: `chunk ${i}`,
      });
      client.emitNotification(Methods.THREAD_TOKEN_USAGE_UPDATED, {
        threadId: started.threadId,
        tokenUsage: { total: { inputTokens: i, outputTokens: i } },
      });
    }
    await Promise.resolve();
    expect(woke).toBe(false);

    // The end of the turn is what the waiter is there for.
    client.emitNotification(Methods.TURN_COMPLETED, {
      threadId: started.threadId,
      turnId: "turn_1",
      turn: { id: "turn_1", status: "completed" },
    });
    await wait;
    expect(woke).toBe(true);
  });

  it("wakes every waiter when the session is dropped", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium");
    await manager.cancelSession(started.sessionId, "by test");
    const waits = [0, 1].map(() => manager.waitForChange(started.sessionId, 60_000));

    await manager.cleanSessions({ statuses: ["cancelled"] });
    await Promise.all(waits);

    // The waiter that wakes reads a session that is no longer there.
    expect(() => manager.getSessionSignal(started.sessionId)).toThrow("SESSION_NOT_FOUND");
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

    client.emitServerRequest(1, Methods.COMMAND_APPROVAL, {
      itemId: "item_waiters",
      threadId: started.threadId,
      turnId: "turn_1",
      command: "echo hi",
      cwd: workspace,
    });
    await Promise.all(waits);

    // The drained queue accepts a full set again — no waiter was left behind.
    const second = [0, 1, 2, 3].map(() => manager.waitForChange(started.sessionId, 60_000));
    await manager.cancelSession(started.sessionId, "done");
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
    await manager.cancelSession(started.sessionId, "done");
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
    jest.restoreAllMocks();
  });

  it("marks a session whose owner died mid-turn as abandoned, not failed", () => {
    manager.ingestRecovered([
      recovered({ sessionId: "sess_was_running", meta: { status: "running" } as never }),
    ]);

    const info = manager.getSession("sess_was_running");
    expect(info.status).toBe("abandoned");
    expect(info.cancelledReason).toBeUndefined();
  });

  it("carries the last activity of an abandoned session into what a listing reports", () => {
    manager.ingestRecovered([
      recovered({
        sessionId: "sess_cut_off",
        meta: { status: "running" } as never,
        lastActivity: "Подсчёт TypeScript-файлов в src",
      }),
    ]);

    const listed = manager.listSessions().find((s) => s.sessionId === "sess_cut_off")!;
    expect(listed.status).toBe("abandoned");
    expect(listed.activity).toBe("Подсчёт TypeScript-файлов в src");
    expect(listed.owner).toBeUndefined();
  });

  it("leaves a session another running server holds out of memory", () => {
    const errors = jest.spyOn(console, "error").mockImplementation(() => {});
    manager.ingestRecovered([
      recovered({
        sessionId: "sess_held",
        meta: { status: "running" } as never,
        owner: {
          kind: "held",
          owner: { pid: 4242, startedAt: "2024-01-01T00:00:00.000Z" },
          proven: true,
        },
      }),
    ]);

    expect(manager.listSessions()).toHaveLength(0);
    expect(
      errors.mock.calls.some((call) => String(call[0]).includes("leaving it to that server"))
    ).toBe(true);
  });

  it("restores every thread parameter a resume needs", () => {
    manager.ingestRecovered([
      recovered({
        sessionId: "sess_full",
        meta: {
          status: "running",
          threadId: "thr_full",
          model: "gpt-5",
          profile: "work",
          approvalPolicy: "never",
          sandbox: "read-only",
          personality: "pragmatic",
          developerInstructions: "# Activity marker",
          approvalTimeoutMs: 900_000,
          config: { "a.b": 1 },
        } as never,
      }),
    ]);

    const info = manager.getSession("sess_full", true) as Record<string, unknown>;
    expect(info).toMatchObject({
      threadId: "thr_full",
      model: "gpt-5",
      profile: "work",
      approvalPolicy: "never",
      sandbox: "read-only",
      config: { "a.b": 1 },
    });
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

  it("keeps the instant the recovered session was last active", () => {
    manager.ingestRecovered([
      recovered({
        sessionId: "sess_aged",
        meta: { lastActiveAt: "2020-03-04T05:06:07.000Z" } as never,
      }),
    ]);

    expect(manager.getSession("sess_aged").lastActiveAt).toBe("2020-03-04T05:06:07.000Z");
    expect(manager.getProgress("sess_aged").lastEventAt).toBe("2020-03-04T05:06:07.000Z");
  });

  it("writes the recovered lastActiveAt back for a session that was active at shutdown", async () => {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), "codex-mcp-aged-"));
    const persistence = new SessionPersistence(stateDir);
    const agedManager = new SessionManager({ disableCleanup: true, persistence });
    try {
      agedManager.ingestRecovered([
        recovered({
          sessionId: "sess_active",
          meta: { status: "running", lastActiveAt: "2020-03-04T05:06:07.000Z" } as never,
        }),
      ]);

      const meta = JSON.parse(
        readFileSync(path.join(stateDir, "sessions", "sess_active", "meta.json"), "utf-8")
      );
      expect(meta.status).toBe("abandoned");
      expect(meta.lastActiveAt).toBe("2020-03-04T05:06:07.000Z");
    } finally {
      agedManager.destroy();
      persistence.destroy();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("leaves cwd unset when the recovered metadata records none", () => {
    manager.ingestRecovered([
      recovered({ sessionId: "sess_nocwd", meta: { cwd: undefined } as never }),
    ]);

    expect((manager.getSession("sess_nocwd", true) as { cwd?: string }).cwd).toBeUndefined();
  });

  it("skips a recovered session whose metadata records no lastActiveAt", () => {
    const errors = jest.spyOn(console, "error").mockImplementation(() => {});

    manager.ingestRecovered([
      recovered({ sessionId: "sess_undated", meta: { lastActiveAt: undefined } as never }),
    ]);

    expect(manager.listSessions()).toHaveLength(0);
    expect(
      errors.mock.calls.some(
        (call) =>
          String(call[0]).includes("Skipping recovered session sess_undated") &&
          String(call[0]).includes("lastActiveAt")
      )
    ).toBe(true);
  });

  it("says an unreadable status is what made the recovered session an error", () => {
    manager.ingestRecovered([
      recovered({ sessionId: "sess_weird", meta: { status: "half-way" } as never }),
    ]);

    const info = manager.getSession("sess_weird");
    expect(info.status).toBe("error");
    expect(info.cancelledReason).toContain("half-way");
  });

  it("keeps the reason a recovered session already carries", () => {
    manager.ingestRecovered([
      recovered({
        sessionId: "sess_damaged",
        meta: { status: "unknown", cancelledReason: "meta.json on disk is unusable" } as never,
      }),
    ]);

    expect(manager.getSession("sess_damaged").cancelledReason).toBe(
      "meta.json on disk is unusable"
    );
  });

  it("resumes the event log sequence for a recovered session", () => {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), "codex-mcp-recover-"));
    const persistence = new SessionPersistence(stateDir);
    const recoverManager = new SessionManager({ disableCleanup: true, persistence });
    const setNextSeq = jest.spyOn(persistence, "setEventLogNextSeq");
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
  let persistence: SessionPersistence;
  let stateDir: string;

  const events = (sessionId: string) => loggedEvents(persistence, stateDir, sessionId);

  beforeEach(() => {
    client = new MockClient();
    stateDir = mkdtempSync(path.join(os.tmpdir(), "codex-mcp-operations-"));
    persistence = new SessionPersistence(stateDir);
    manager = new SessionManager({
      disableCleanup: true,
      persistence,
      createClient: () => client as unknown as AppServerClient,
    });
  });

  afterEach(() => {
    manager.destroy();
    persistence.destroy();
    rmSync(stateDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it("cleans background terminals and records the request as an event", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium");

    await manager.cleanBackgroundTerminals(started.sessionId);

    expect(client.threadBackgroundTerminalsClean).toHaveBeenCalledWith({
      threadId: started.threadId,
    });
    const cleaned = events(started.sessionId).find(
      (event) => event.data?.method === Methods.THREAD_BACKGROUND_TERMINALS_CLEAN
    );
    expect(cleaned).toBeDefined();
    expect(cleaned!.data.status).toBe("requested");
  });

  it("pushes no event when the client refuses to clean background terminals", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium");
    client.threadBackgroundTerminalsClean = jest.fn(async () => {
      throw new Error("Error [EXEC_NOT_SUPPORTED]: not supported in exec mode");
    });

    await expect(manager.cleanBackgroundTerminals(started.sessionId)).rejects.toThrow(
      "EXEC_NOT_SUPPORTED"
    );

    expect(
      events(started.sessionId).some(
        (event) => event.data?.method === Methods.THREAD_BACKGROUND_TERMINALS_CLEAN
      )
    ).toBe(false);
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

  it("takes the turn id from the turn/start response", async () => {
    client.turnStartResult = { turn: { id: "turn_v2" } };
    const started = await manager.createSession("hi", workspace, {}, "medium");

    expect(started.progress.activeTurnId).toBe("turn_v2");
  });

  it("keeps no active turn when turn/start puts the id outside `turn`", async () => {
    // turn/steer is the one response of the bundle answering a bare `turnId`
    // (codex-schema/v2/TurnSteerResponse.json), and this server never sends it.
    client.turnStartResult = { turnId: "turn_v1" };
    const started = await manager.createSession("hi", workspace, {}, "medium");

    expect(started.progress.activeTurnId).toBeUndefined();
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
    const writePid = jest.spyOn(persistence, "writePidInfo");
    try {
      const started = await forkManager.createSession(
        "hi",
        workspace,
        { model: "gpt-a" },
        "medium"
      );
      const forked = await forkManager.forkSession(started.sessionId);

      expect(forked.status).toBe("idle");
      expect(writePid).toHaveBeenCalledWith(forked.sessionId, 4242, {
        model: "gpt-a",
        spawnedAt: forkClient.spawnedAt,
      });
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
    client.turnStart = jest.fn(async () => {
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

    const poll = manager.pollStatus(started.sessionId);
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
    const writeMeta = jest.spyOn(persistence, "writeSessionMeta");
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

describe("SessionManager persistence failures", () => {
  let client: MockClient;
  let stateDir: string;
  let persistence: SessionPersistence;
  let manager: SessionManager;
  let errors: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    errors = jest.spyOn(console, "error").mockImplementation(() => {});
    client = new MockClient();
    stateDir = mkdtempSync(path.join(os.tmpdir(), "codex-mcp-persist-fail-"));
    persistence = new SessionPersistence(stateDir);
    manager = new SessionManager({
      disableCleanup: true,
      persistence,
      createClient: () => client as unknown as AppServerClient,
    });
  });

  afterEach(() => {
    manager.destroy();
    persistence.destroy();
    rmSync(stateDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  function loggedOnce(fragment: string, cause: string): number {
    return errors.mock.calls.filter(
      (call) => String(call[0]).includes(fragment) && String(call[0]).includes(cause)
    ).length;
  }

  it("reports a pid.json that could not be written, naming the pid left unreaped", async () => {
    client.childPid = 9911;
    jest.spyOn(persistence, "writePidInfo").mockImplementation(() => {
      throw new Error("EDQUOT: quota exceeded");
    });

    const started = await manager.createSession("hi", workspace, {}, "medium");

    expect(started.status).toBe("running");
    expect(loggedOnce("will not be reaped", "EDQUOT: quota exceeded")).toBe(1);
    expect(errors.mock.calls.some((call) => String(call[0]).includes("9911"))).toBe(true);
  });

  it("reports every spawn whose pid.json could not be written", async () => {
    client.childPid = 9911;
    jest.spyOn(persistence, "writePidInfo").mockImplementation(() => {
      throw new Error("EDQUOT: quota exceeded");
    });

    await manager.createSession("hi", workspace, {}, "medium");
    client.emit("spawn", 9912, "2024-05-05T10:00:01.000Z");

    expect(loggedOnce("will not be reaped", "EDQUOT: quota exceeded")).toBe(2);
  });

  it("reports the first metadata write that could not create the session directory", async () => {
    jest.spyOn(persistence, "writeSessionMeta").mockImplementation(() => {
      throw new Error("EACCES: create boom");
    });

    const started = await manager.createSession("hi", workspace, {}, "medium");

    expect(started.status).toBe("running");
    expect(loggedOnce("Failed to persist session metadata", "EACCES: create boom")).toBe(1);
  });

  it("reports a status change that could not be written and keeps the session running", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium");
    jest.spyOn(persistence, "writeSessionMeta").mockImplementation(() => {
      throw new Error("EACCES: status boom");
    });

    client.emitNotification(Methods.TURN_COMPLETED, {
      threadId: started.threadId,
      turn: { id: "turn_1", status: "completed", output: "done" },
    });
    await manager.cancelSession(started.sessionId, "by test");

    expect(manager.getSession(started.sessionId).status).toBe("cancelled");
    // One line per session, however many status changes fail after it.
    expect(loggedOnce("Failed to persist session metadata", "EACCES: status boom")).toBe(1);
  });

  it("reports a turn result that could not be written", async () => {
    jest.spyOn(persistence, "writeResult").mockImplementation(() => {
      throw new Error("ENOSPC: result boom");
    });

    const started = await manager.createSession("hi", workspace, {}, "medium");
    client.emitNotification(Methods.TURN_COMPLETED, {
      threadId: started.threadId,
      turn: { id: "turn_1", status: "completed", output: "done" },
    });

    expect(manager.getLastResult(started.sessionId)?.turnId).toBe("turn_1");
    expect(loggedOnce("Failed to persist turn result", "ENOSPC: result boom")).toBe(1);
  });
});

describe("SessionManager unapplied turn overrides", () => {
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
    jest.restoreAllMocks();
  });

  async function idleSession(): Promise<string> {
    const started = await manager.createSession(
      "hi",
      workspace,
      { sandbox: "workspace-write" },
      "medium"
    );
    client.emitNotification(Methods.TURN_COMPLETED, {
      threadId: started.threadId,
      turn: { id: "turn_1", status: "completed", output: "done" },
    });
    return started.sessionId;
  }

  it("warns the caller that a narrowed sandbox was not applied", async () => {
    const sessionId = await idleSession();
    client.supportsTurnOverrides = false;

    const reply = await manager.replyToSession(sessionId, "again", { sandbox: "read-only" });

    expect(reply.status).toBe("running");
    expect(reply.compatWarnings).toHaveLength(1);
    expect(reply.compatWarnings![0]).toContain("read-only");
    expect(reply.compatWarnings![0]).toContain("workspace-write");
    // The session keeps the permissions the turn actually runs under.
    expect((manager.getSession(sessionId) as { sandbox?: string }).sandbox).toBe("workspace-write");
  });

  it("names an unapplied cwd override alongside the sandbox", async () => {
    const otherCwd = mkdtempSync(path.join(os.tmpdir(), "codex-mcp-other-cwd-"));
    try {
      const sessionId = await idleSession();
      client.supportsTurnOverrides = false;

      const reply = await manager.replyToSession(sessionId, "again", { cwd: otherCwd });

      expect(reply.compatWarnings![0]).toContain(otherCwd);
      expect(reply.compatWarnings![0]).toContain("cwd");
    } finally {
      rmSync(otherCwd, { recursive: true, force: true });
    }
  });

  it("stays silent when the client applies the overrides", async () => {
    const sessionId = await idleSession();

    const reply = await manager.replyToSession(sessionId, "again", { sandbox: "read-only" });

    expect(reply.compatWarnings).toBeUndefined();
    expect((manager.getSession(sessionId) as { sandbox?: string }).sandbox).toBe("read-only");
  });

  it("reports the overrides the client says it dropped", async () => {
    const sessionId = await idleSession();
    client.unappliedTurnOverrides = ["sandbox", "outputSchema"];

    const reply = await manager.replyToSession(sessionId, "again", {
      sandbox: "read-only",
      outputSchema: { type: "object" },
    });

    expect(reply.compatWarnings).toHaveLength(1);
    expect(reply.compatWarnings![0]).toContain("sandbox 'read-only'");
    expect(reply.compatWarnings![0]).toContain("workspace-write");
    expect(reply.compatWarnings![0]).toContain("outputSchema");
  });

  it("does not read the turn output as structured when the schema was dropped", async () => {
    const sessionId = await idleSession();
    client.unappliedTurnOverrides = ["outputSchema"];

    await manager.replyToSession(sessionId, "again", { outputSchema: { type: "object" } });
    client.emitNotification(Methods.TURN_COMPLETED, {
      turn: { id: "turn_2", status: "completed", output: '{"a":1}' },
    });

    expect(manager.getLastResult(sessionId)?.structuredOutput).toBeUndefined();
  });

  it("keeps the session sandbox when the client says the override was dropped", async () => {
    const sessionId = await idleSession();
    // The client applies overrides in general, and still dropped this one.
    client.unappliedTurnOverrides = ["sandbox"];

    await manager.replyToSession(sessionId, "again", { sandbox: "read-only" });

    expect((manager.getSession(sessionId) as { sandbox?: string }).sandbox).toBe("workspace-write");
  });

  it("stays silent when the client reports an empty list", async () => {
    const sessionId = await idleSession();
    client.unappliedTurnOverrides = [];
    client.supportsTurnOverrides = false;

    const reply = await manager.replyToSession(sessionId, "again", { sandbox: "read-only" });

    expect(reply.compatWarnings).toBeUndefined();
  });

  it("stays silent when nothing that needs applying was asked for", async () => {
    const sessionId = await idleSession();
    client.supportsTurnOverrides = false;

    const reply = await manager.replyToSession(sessionId, "again", { model: "gpt-b" });

    expect(reply.compatWarnings).toBeUndefined();
  });
});

describe("SessionManager notification handling", () => {
  let client: MockClient;
  let manager: SessionManager;
  let persistence: SessionPersistence;
  let stateDir: string;

  const events = (sessionId: string) => loggedEvents(persistence, stateDir, sessionId);

  beforeEach(() => {
    client = new MockClient();
    stateDir = mkdtempSync(path.join(os.tmpdir(), "codex-mcp-notifications-"));
    persistence = new SessionPersistence(stateDir);
    manager = new SessionManager({
      disableCleanup: true,
      persistence,
      createClient: () => client as unknown as AppServerClient,
    });
  });

  afterEach(() => {
    manager.destroy();
    persistence.destroy();
    rmSync(stateDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it("adopts the thread id the thread/started notification carries", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium");

    // Thread.status is a ThreadStatus object, not a string
    // (codex-schema/v2/ThreadStartedNotification.json → Thread.status).
    client.emitNotification(Methods.THREAD_STARTED, {
      thread: {
        id: "thread_real",
        status: { type: "active", activeFlags: [] },
        cliVersion: "0.0.0",
        createdAt: 1,
        cwd: workspace,
        modelProvider: "openai",
        preview: "hi",
        source: "appServer",
        turns: [],
        updatedAt: 1,
      },
    });

    const info = manager.getSession(started.sessionId, true) as { threadId?: string };
    expect(info.threadId).toBe("thread_real");
    const event = events(started.sessionId).find((e) => e.data?.method === Methods.THREAD_STARTED);
    expect(event!.data.threadId).toBe("thread_real");
    expect(event!.data.status).toBe("active");
  });

  it("reports the idle variant of a thread/started status", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium");

    client.emitNotification(Methods.THREAD_STARTED, {
      thread: { id: started.threadId, status: { type: "idle" } },
    });

    const event = events(started.sessionId).find((e) => e.data?.method === Methods.THREAD_STARTED);
    expect(event!.data.status).toBe("idle");
  });

  it("reports no status for a thread/started that carries no thread", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium");

    client.emitNotification(Methods.THREAD_STARTED, { threadId: started.threadId });

    const event = events(started.sessionId).find((e) => e.data?.method === Methods.THREAD_STARTED);
    expect(event!.data.status).toBeUndefined();
  });

  it("drops a command output delta that is nothing but shell profile noise", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium");

    client.emitNotification(Methods.COMMAND_OUTPUT_DELTA, {
      itemId: "item_1",
      turnId: "turn_1",
      delta: "WARNING: oh-my-posh update available",
    });

    expect(events(started.sessionId)).toHaveLength(0);
  });

  it("keeps a command output delta that is not a string", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium");

    client.emitNotification(Methods.COMMAND_OUTPUT_DELTA, {
      itemId: "item_1",
      turnId: "turn_1",
      delta: { chunks: ["a"] },
    });

    const logged = events(started.sessionId);
    expect(logged).toHaveLength(1);
    expect(logged[0]!.data.delta).toEqual({ chunks: ["a"] });
  });

  it("ignores a notification method it has no case for", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium");

    client.emitNotification("account/somethingNew", { whatever: true });

    expect(events(started.sessionId)).toHaveLength(0);
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

  it("keeps the completed agent message the protocol sends without a status", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium");

    // AgentMessageThreadItem carries id/text/phase and no status
    // (codex-schema/v2/ItemCompletedNotification.json).
    client.emitNotification(Methods.ITEM_COMPLETED, {
      threadId: started.threadId,
      turnId: "turn_1",
      item: { id: "item_1", type: "agentMessage", text: "the answer", phase: "final_answer" },
    });
    client.emitNotification(Methods.TURN_COMPLETED, {
      threadId: started.threadId,
      turn: { id: "turn_1", status: "completed", items: [] },
    });

    expect(manager.getLastResult(started.sessionId)?.text).toBe("the answer");
  });

  it("keeps a completed plan item as progress and out of the final answer", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium");

    // PlanThreadItem requires [id, text, type] (codex-schema/v2/ItemCompletedNotification.json
    // → ThreadItem), and reaches this server because the client asks for the
    // experimental API.
    client.emitNotification(Methods.ITEM_COMPLETED, {
      threadId: started.threadId,
      turnId: "turn_1",
      item: { id: "item_plan", type: "plan", text: "1. read the file\n2. patch it" },
    });
    client.emitNotification(Methods.ITEM_COMPLETED, {
      threadId: started.threadId,
      turnId: "turn_1",
      item: { id: "item_1", type: "agentMessage", text: "the answer" },
    });
    client.emitNotification(Methods.TURN_COMPLETED, {
      threadId: started.threadId,
      turn: { id: "turn_1", status: "completed", items: [] },
    });

    const planEvent = events(started.sessionId).find(
      (e) => (e.data?.item as { id?: string })?.id === "item_plan"
    );
    expect(planEvent!.type).toBe("progress");
    expect(manager.getLastResult(started.sessionId)?.text).toBe("the answer");
  });

  it("keeps the final answer of the ThreadItem stream when a raw response item repeats it", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium");

    client.emitNotification(Methods.ITEM_COMPLETED, {
      threadId: started.threadId,
      turnId: "turn_1",
      item: { id: "item_1", type: "agentMessage", text: "the answer" },
    });
    // MessageResponseItem requires [content, role, type] and keeps its text in
    // content[].text — no `agentMessage` type and no top-level `text`
    // (codex-schema/v2/RawResponseItemCompletedNotification.json → ResponseItem).
    client.emitNotification(Methods.RAW_RESPONSE_ITEM_COMPLETED, {
      threadId: started.threadId,
      turnId: "turn_1",
      item: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "a lower-level copy" }],
      },
    });
    client.emitNotification(Methods.TURN_COMPLETED, {
      threadId: started.threadId,
      turn: { id: "turn_1", status: "completed", items: [] },
    });

    expect(manager.getLastResult(started.sessionId)?.text).toBe("the answer");
    const rawEvent = events(started.sessionId).find(
      (e) => e.data?.method === Methods.RAW_RESPONSE_ITEM_COMPLETED
    );
    expect(rawEvent!.type).toBe("progress");
  });

  it("reads the final message as structured output when the turn asked for a schema", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium", {
      outputSchema: { type: "object", properties: { answer: { type: "number" } } },
    });

    client.emitNotification(Methods.ITEM_COMPLETED, {
      threadId: started.threadId,
      turnId: "turn_1",
      item: { id: "item_1", type: "agentMessage", text: '{"answer": 42}' },
    });
    client.emitNotification(Methods.TURN_COMPLETED, {
      threadId: started.threadId,
      turn: { id: "turn_1", status: "completed", items: [] },
    });

    const result = manager.getLastResult(started.sessionId);
    expect(result?.structuredOutput).toEqual({ answer: 42 });
    expect(result?.text).toBe('{"answer": 42}');
  });

  it("reports no structured output for a turn that asked for no schema", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium");

    client.emitNotification(Methods.ITEM_COMPLETED, {
      threadId: started.threadId,
      turnId: "turn_1",
      item: { id: "item_1", type: "agentMessage", text: '{"answer": 42}' },
    });
    client.emitNotification(Methods.TURN_COMPLETED, {
      threadId: started.threadId,
      turn: { id: "turn_1", status: "completed", items: [] },
    });

    expect(manager.getLastResult(started.sessionId)?.structuredOutput).toBeUndefined();
  });

  it("reports no structured output when the schema-constrained message is not JSON", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium", {
      outputSchema: { type: "object" },
    });

    client.emitNotification(Methods.ITEM_COMPLETED, {
      threadId: started.threadId,
      turnId: "turn_1",
      item: { id: "item_1", type: "agentMessage", text: "sorry, I could not comply" },
    });
    client.emitNotification(Methods.TURN_COMPLETED, {
      threadId: started.threadId,
      turn: { id: "turn_1", status: "completed", items: [] },
    });

    const result = manager.getLastResult(started.sessionId);
    expect(result?.structuredOutput).toBeUndefined();
    expect(result?.text).toBe("sorry, I could not comply");
  });

  it("counts the tokens the tokenUsage notification nests under total", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium");

    // Shape of ThreadTokenUsageUpdatedNotification
    // (codex-schema/v2/ThreadTokenUsageUpdatedNotification.json).
    client.emitNotification(Methods.THREAD_TOKEN_USAGE_UPDATED, {
      threadId: started.threadId,
      turnId: "turn_1",
      tokenUsage: {
        total: {
          cachedInputTokens: 2,
          inputTokens: 30,
          outputTokens: 12,
          reasoningOutputTokens: 4,
          totalTokens: 42,
        },
        last: {
          cachedInputTokens: 0,
          inputTokens: 7,
          outputTokens: 3,
          reasoningOutputTokens: 1,
          totalTokens: 10,
        },
        modelContextWindow: 272000,
      },
    });

    expect(manager.getProgress(started.sessionId).tokens).toEqual({
      input: 30,
      output: 12,
      total: 42,
    });
  });

  it("counts the tokens the exec token_count event nests under info", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium");

    // Shape of TokenCountEventMsg (codex-schema/EventMsg.json), which exec mode
    // forwards under the same method.
    client.emitNotification(Methods.THREAD_TOKEN_USAGE_UPDATED, {
      threadId: started.threadId,
      turnId: "turn_1",
      type: "token_count",
      info: {
        total_token_usage: {
          cached_input_tokens: 1,
          input_tokens: 100,
          output_tokens: 20,
          reasoning_output_tokens: 5,
          total_tokens: 120,
        },
        last_token_usage: {
          cached_input_tokens: 0,
          input_tokens: 10,
          output_tokens: 2,
          reasoning_output_tokens: 0,
          total_tokens: 12,
        },
        model_context_window: 272000,
      },
    });

    expect(manager.getProgress(started.sessionId).tokens).toEqual({
      input: 100,
      output: 20,
      total: 120,
    });
  });

  it("reports the progress a tool-call progress notification carries and no percentage", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium");

    // McpToolCallProgressNotification carries [itemId, message, threadId, turnId]
    // (codex-schema/ServerNotification.json). No notification of the bundle carries
    // a completion percentage, so `progress` reports no such field.
    client.emitNotification(Methods.MCP_TOOL_PROGRESS, {
      itemId: "item_1",
      message: "fetching",
      threadId: started.threadId,
      turnId: "turn_1",
    });

    const progress = manager.getProgress(started.sessionId);
    expect(progress.phase).toBe("acting");
    expect(Object.keys(progress)).not.toContain("percent");
  });

  it("merges reported token usage without moving the phase", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium");

    client.emitNotification(Methods.REASONING_TEXT_DELTA, { turnId: "turn_mock", delta: "a" });
    client.emitNotification(Methods.THREAD_TOKEN_USAGE_UPDATED, {
      threadId: started.threadId,
      turnId: "turn_mock",
      tokenUsage: {
        total: {
          cachedInputTokens: 0,
          inputTokens: 10,
          outputTokens: 4,
          reasoningOutputTokens: 0,
          totalTokens: 14,
        },
        last: {
          cachedInputTokens: 0,
          inputTokens: 10,
          outputTokens: 4,
          reasoningOutputTokens: 0,
          totalTokens: 14,
        },
      },
    });
    client.emitNotification(Methods.THREAD_TOKEN_USAGE_UPDATED, {
      threadId: started.threadId,
      turnId: "turn_mock",
      tokenUsage: {
        total: {
          cachedInputTokens: 0,
          inputTokens: 10,
          outputTokens: 9,
          reasoningOutputTokens: 3,
          totalTokens: 19,
        },
        last: {
          cachedInputTokens: 0,
          inputTokens: 0,
          outputTokens: 5,
          reasoningOutputTokens: 3,
          totalTokens: 5,
        },
      },
    });

    const progress = manager.getProgress(started.sessionId);
    expect(progress.tokens).toEqual({ input: 10, output: 9, total: 19 });
    // The counter update carries no phase of its own: the reasoning delta before it
    // is still what the session is doing.
    expect(progress.phase).toBe("reasoning");
  });

  it("keeps the token counters a tokenUsage update reports after the turn completed", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium");

    // `usage` on a completed turn is ExecClient's addition, carrying the `usage`
    // of the exec `turn.completed` record (src/app-server/exec-client.ts).
    client.emitNotification(Methods.TURN_COMPLETED, {
      threadId: started.threadId,
      turn: {
        id: "turn_1",
        status: "completed",
        items: [],
        usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 20 },
      },
    });
    client.emitNotification(Methods.THREAD_TOKEN_USAGE_UPDATED, {
      threadId: started.threadId,
      turnId: "turn_1",
      tokenUsage: {
        total: {
          cachedInputTokens: 0,
          inputTokens: 300,
          outputTokens: 40,
          reasoningOutputTokens: 10,
          totalTokens: 340,
        },
        last: {
          cachedInputTokens: 0,
          inputTokens: 200,
          outputTokens: 20,
          reasoningOutputTokens: 10,
          totalTokens: 220,
        },
      },
    });

    expect(manager.getProgress(started.sessionId).tokens).toEqual({
      input: 300,
      output: 40,
      total: 340,
    });
  });

  it("ignores a turn start and an error that arrive after cancellation", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium");
    await manager.cancelSession(started.sessionId, "by test");
    const before = events(started.sessionId).length;

    client.emitNotification(Methods.TURN_STARTED, { turn: { id: "turn_late", status: "active" } });
    client.emitNotification(Methods.ERROR, {
      threadId: started.threadId,
      turnId: "turn_late",
      error: { message: "late boom" },
      willRetry: false,
    });

    expect(events(started.sessionId).length).toBe(before);
    expect(manager.getSession(started.sessionId).status).toBe("cancelled");
  });

  it("redacts an error notification that carries a bare string error", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium");

    client.emitNotification(Methods.ERROR, {
      error: "failed reading /home/someone/secret/file.txt",
      willRetry: false,
    });

    const errorEvent = events(started.sessionId).find((event) => event.type === "error")!;
    expect(errorEvent.data.error).toContain("<path>");
    expect(errorEvent.data.error).not.toContain("/home/someone/secret");
  });

  it("survives a notification that carries no params", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium");

    client.emitNotification(Methods.MCP_TOOL_PROGRESS, null);

    const progress = manager.getProgress(started.sessionId);
    expect(progress.phase).toBe("acting");
    expect(progress.tokens).toBeUndefined();
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
    expect(events(started.sessionId).some((event) => event.type === "error")).toBe(true);
  });
});

describe("SessionManager server-initiated requests", () => {
  let client: MockClient;
  let manager: SessionManager;
  let errors: ReturnType<typeof jest.spyOn>;
  let persistence: SessionPersistence;
  let stateDir: string;

  beforeEach(() => {
    client = new MockClient();
    stateDir = mkdtempSync(path.join(os.tmpdir(), "codex-mcp-server-requests-"));
    persistence = new SessionPersistence(stateDir);
    manager = new SessionManager({
      disableCleanup: true,
      persistence,
      createClient: () => client as unknown as AppServerClient,
    });
    errors = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    manager.destroy();
    persistence.destroy();
    rmSync(stateDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it("reports a dynamic tool call whose refusal cannot be sent and runs on", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium");
    client.respondToServer = jest.fn(() => {
      throw new Error("stdin closed");
    });

    client.emitServerRequest(10, Methods.DYNAMIC_TOOL_CALL, { name: "whatever" });

    // Nothing here is the caller's to answer, so the session stays as it was.
    expect(manager.pollStatus(started.sessionId).status).toBe("running");
    expect(
      errors.mock.calls.some(
        (call) =>
          String(call[0]).includes("Failed to answer a server request") &&
          String(call[0]).includes("stdin closed")
      )
    ).toBe(true);
  });

  it("reports an unhandled server request whose error reply cannot be sent", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium");
    client.respondErrorToServer = jest.fn(() => {
      throw new Error("stdin closed");
    });

    client.emitServerRequest(11, "some/unknown/method", {});

    expect(manager.pollStatus(started.sessionId).status).toBe("running");
    expect(
      errors.mock.calls.some(
        (call) =>
          String(call[0]).includes("Failed to answer a server request") &&
          String(call[0]).includes("some/unknown/method")
      )
    ).toBe(true);
  });

  it("reports a terminal session's refusal that cannot be delivered", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium");
    await manager.cancelSession(started.sessionId, "by test");
    client.respondToServer = jest.fn(() => {
      throw new Error("stdin closed");
    });

    client.emitServerRequest(12, Methods.COMMAND_APPROVAL, {
      itemId: "item_1",
      threadId: started.threadId,
      turnId: "turn_1",
      command: "ls",
    });

    expect(
      errors.mock.calls.some(
        (call) =>
          String(call[0]).includes("Failed to answer a server request") &&
          String(call[0]).includes(Methods.COMMAND_APPROVAL)
      )
    ).toBe(true);
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
    client.respondToServer = jest.fn(() => {
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
  let errors: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    jest.useFakeTimers();
    client = new MockClient();
    manager = new SessionManager({
      disableCleanup: true,
      createClient: () => client as unknown as AppServerClient,
    });
    errors = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    manager.destroy();
    jest.useRealTimers();
    jest.restoreAllMocks();
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

    await advanceAsync(1000);

    expect(client.respondToServer).toHaveBeenCalledWith(40, { decision: "decline" });
    const info = manager.getSession(started.sessionId);
    expect(info.status).toBe("running");
    expect(info.pendingRequestCount).toBe(0);
    expect(manager.pollStatus(started.sessionId).actions).toEqual([]);
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
    client.respondToServer = jest.fn(() => {
      throw new Error("pipe closed");
    });

    await advanceAsync(1000);

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
    client.respondToServer = jest.fn(() => {
      throw new Error("pipe closed");
    });

    await advanceAsync(1000);

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
    client.respondToServer = jest.fn(() => {
      throw new Error("pipe closed");
    });

    await advanceAsync(1000);

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
    jest.restoreAllMocks();
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
    const poll = manager.pollStatus(started.sessionId);
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
    const poll = manager.pollStatus(started.sessionId);
    const requestId = poll.actions![0].requestId;

    expect(() => manager.resolveApproval(started.sessionId, requestId, "accept")).toThrow(
      "is not an approval request"
    );
  });
});
