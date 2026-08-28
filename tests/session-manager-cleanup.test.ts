import { advanceAsync } from "./helpers/clock.js";
import { EventEmitter } from "events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import type { AppServerClient } from "../src/app-server/client.js";
import { Methods } from "../src/app-server/protocol.js";
import { SessionManager } from "../src/session/manager.js";
import { SessionPersistence } from "../src/session/persistence.js";
import {
  DEFAULT_IDLE_CLEANUP_MS,
  DEFAULT_RUNNING_CLEANUP_MS,
  DEFAULT_TERMINAL_CLEANUP_MS,
} from "../src/types.js";

class MockClient extends EventEmitter {
  notificationHandler: ((method: string, params: unknown) => void) | null = null;
  serverRequestHandler: ((id: number, method: string, params: unknown) => void) | null = null;

  supportsTurnOverrides = true;
  childPid: number | undefined = undefined;

  start = jest.fn(async () => ({ userAgent: "mock" }));
  threadStart = jest.fn(async () => ({ thread: { id: "thread_mock" } }));
  threadFork = jest.fn(async () => ({ thread: { id: "thread_forked" } }));
  threadResume = jest.fn(async () => ({ thread: { id: "thread_forked" } }));
  threadBackgroundTerminalsClean = jest.fn(async () => ({}));
  turnStart = jest.fn(async () => ({ turn: { id: "turn_mock" } }));
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
const NEVER_TIMEOUT_MS = 10 * 60 * 60 * 1000;

/** The TTL warnings the manager wrote to a session's event log. */
function ttlWarnings(
  persistence: SessionPersistence,
  stateDir: string,
  sessionId: string
): Array<Record<string, unknown>> {
  persistence.flushAll();
  const file = path.join(stateDir, "sessions", sessionId, "events.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf-8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => (JSON.parse(line) as { data: Record<string, unknown> }).data)
    .filter((data) => data?.method === "codex-mcp/ttl_warning");
}

describe("SessionManager background cleanup", () => {
  let client: MockClient;
  let manager: SessionManager;
  let persistence: SessionPersistence;
  let stateDir: string;

  const warningsOf = (sessionId: string) => ttlWarnings(persistence, stateDir, sessionId);

  beforeEach(() => {
    jest.useFakeTimers();
    client = new MockClient();
    stateDir = mkdtempSync(path.join(os.tmpdir(), "codex-mcp-cleanup-"));
    persistence = new SessionPersistence(stateDir);
    manager = new SessionManager({
      persistence,
      createClient: () => client as unknown as AppServerClient,
    });
  });

  afterEach(() => {
    manager.destroy();
    persistence.destroy();
    rmSync(stateDir, { recursive: true, force: true });
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("cancels an idle session once it outlives the idle TTL", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium");
    client.emitNotification(Methods.TURN_COMPLETED, {
      threadId: started.threadId,
      turn: { id: "turn_1", status: "completed", output: "done" },
    });
    expect(manager.getSession(started.sessionId).status).toBe("idle");

    await advanceAsync(DEFAULT_IDLE_CLEANUP_MS + 60_000);

    const info = manager.getSession(started.sessionId);
    expect(info.status).toBe("cancelled");
    expect(info.cancelledReason).toBe("Idle timeout");
    expect(client.destroy).toHaveBeenCalledTimes(1);
  });

  it("warns once before the idle TTL expires and reports the time left", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium");
    client.emitNotification(Methods.TURN_COMPLETED, {
      threadId: started.threadId,
      turn: { id: "turn_1", status: "completed", output: "done" },
    });

    await advanceAsync(DEFAULT_IDLE_CLEANUP_MS - 60_000);
    const firstPass = warningsOf(started.sessionId);
    expect(firstPass).toHaveLength(1);
    expect(firstPass[0].ttlRemainingMs).toBe(60_000);
    expect(firstPass[0].sessionId).toBe(started.sessionId);
    expect(firstPass[0].type).toBe("ttl_warning");

    // The next cleanup pass sits inside the same warning window and must stay quiet.
    await advanceAsync(60_000);
    expect(warningsOf(started.sessionId)).toHaveLength(1);
    expect(manager.getSession(started.sessionId).status).toBe("idle");
  });

  it("cancels a running session once it outlives the running TTL, warning first", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium");
    expect(manager.getSession(started.sessionId).status).toBe("running");

    await advanceAsync(DEFAULT_RUNNING_CLEANUP_MS - 60_000);
    const warnings = warningsOf(started.sessionId);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].ttlRemainingMs).toBe(60_000);

    await advanceAsync(2 * 60_000);
    const info = manager.getSession(started.sessionId);
    expect(info.status).toBe("cancelled");
    expect(info.cancelledReason).toBe("Running timeout");
  });

  it("cancels a session parked on an approval once it outlives the running TTL", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium", {
      approvalTimeoutMs: NEVER_TIMEOUT_MS,
    });
    client.emitServerRequest(1, Methods.COMMAND_APPROVAL, {
      itemId: "item_1",
      threadId: started.threadId,
      turnId: "turn_1",
      command: "echo hi",
      cwd: workspace,
    });
    expect(manager.getSession(started.sessionId).status).toBe("waiting_approval");

    await advanceAsync(DEFAULT_RUNNING_CLEANUP_MS + 60_000);

    const info = manager.getSession(started.sessionId);
    expect(info.status).toBe("cancelled");
    expect(info.cancelledReason).toBe("Approval timeout");
    expect(info.pendingRequestCount).toBe(0);
  });

  it("cancels a session whose lastActiveAt cannot be parsed", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium");
    const sessions = (manager as unknown as { sessions: Map<string, { lastActiveAt: string }> })
      .sessions;
    sessions.get(started.sessionId)!.lastActiveAt = "not-a-timestamp";

    await advanceAsync(60_000);

    expect(manager.getSession(started.sessionId).cancelledReason).toBe("Invalid timestamp");
  });

  it("drops a terminal session from memory and disk once it outlives the terminal TTL", async () => {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), "codex-mcp-cleanup-"));
    const persistence = new SessionPersistence(stateDir);
    const terminalManager = new SessionManager({
      createClient: () => client as unknown as AppServerClient,
      persistence,
    });
    try {
      const started = await terminalManager.createSession("hi", workspace, {}, "medium");
      await terminalManager.cancelSession(started.sessionId, "by test");
      expect(persistence.hasSessionOnDisk(started.sessionId)).toBe(true);

      await advanceAsync(DEFAULT_TERMINAL_CLEANUP_MS + 60_000);

      expect(terminalManager.listSessions()).toHaveLength(0);
      expect(persistence.hasSessionOnDisk(started.sessionId)).toBe(false);
    } finally {
      terminalManager.destroy();
      persistence.destroy();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("reports a cancellation that fails during a cleanup pass", async () => {
    const errors = jest.spyOn(console, "error").mockImplementation(() => {});
    client.destroy = jest.fn(async () => {
      throw new Error("shutdown boom");
    });
    const started = await manager.createSession("hi", workspace, {}, "medium");
    client.emitNotification(Methods.TURN_COMPLETED, {
      threadId: started.threadId,
      turn: { id: "turn_1", status: "completed", output: "done" },
    });

    await advanceAsync(DEFAULT_IDLE_CLEANUP_MS + 60_000);

    expect(
      errors.mock.calls.some(
        (call) =>
          String(call[0]).includes("Failed to cancel session during cleanup") &&
          String(call[0]).includes("shutdown boom")
      )
    ).toBe(true);
  });

  it("does not start a second cancellation while one is still in flight", async () => {
    let releaseDestroy: (() => void) | null = null;
    client.destroy = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseDestroy = resolve;
        })
    );
    const started = await manager.createSession("hi", workspace, {}, "medium");
    client.emitNotification(Methods.TURN_COMPLETED, {
      threadId: started.threadId,
      turn: { id: "turn_1", status: "completed", output: "done" },
    });

    // First pass past the TTL starts a cancellation that never settles; the
    // following passes must not queue another one.
    await advanceAsync(DEFAULT_IDLE_CLEANUP_MS + 5 * 60_000);
    expect(client.destroy).toHaveBeenCalledTimes(1);

    releaseDestroy!();
    await advanceAsync(0);
    expect(manager.getSession(started.sessionId).cancelledReason).toBe("Idle timeout");
  });
});

describe("SessionManager cleanSessions", () => {
  let clients: MockClient[];
  let manager: SessionManager;
  let stateDir: string;
  let persistence: SessionPersistence;

  beforeEach(() => {
    jest.useFakeTimers();
    clients = [];
    stateDir = mkdtempSync(path.join(os.tmpdir(), "codex-mcp-clean-"));
    persistence = new SessionPersistence(stateDir);
    manager = new SessionManager({
      disableCleanup: true,
      persistence,
      createClient: () => {
        const next = new MockClient();
        clients.push(next);
        return next as unknown as AppServerClient;
      },
    });
  });

  afterEach(() => {
    manager.destroy();
    persistence.destroy();
    rmSync(stateDir, { recursive: true, force: true });
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  async function startIdleSession(): Promise<string> {
    const started = await manager.createSession("hi", workspace, {}, "medium");
    clients[clients.length - 1].emitNotification(Methods.TURN_COMPLETED, {
      threadId: started.threadId,
      turn: { id: "turn_1", status: "completed", output: "done" },
    });
    return started.sessionId;
  }

  it("lists matches without removing anything on a dry run", async () => {
    const idleId = await startIdleSession();
    const runningStart = await manager.createSession("hi", workspace, {}, "medium");

    const report = await manager.cleanSessions({ dryRun: true });

    expect(report.dryRun).toBe(true);
    expect(report.matchedSessionIds).toEqual([idleId]);
    expect(report.removedSessionIds).toEqual([]);
    expect(report.removedCount).toBe(0);
    expect(report.diskSessionsRemoved).toBe(0);
    expect(
      manager
        .listSessions()
        .map((s) => s.sessionId)
        .sort()
    ).toEqual([idleId, runningStart.sessionId].sort());
  });

  it("removes only the statuses it was asked for", async () => {
    const idleId = await startIdleSession();
    const cancelledStart = await manager.createSession("hi", workspace, {}, "medium");
    await manager.cancelSession(cancelledStart.sessionId, "by test");

    const report = await manager.cleanSessions({ statuses: ["cancelled"] });

    expect(report.matchedSessionIds).toEqual([cancelledStart.sessionId]);
    expect(report.removedSessionIds).toEqual([cancelledStart.sessionId]);
    expect(report.removedCount).toBe(1);
    expect(manager.listSessions().map((s) => s.sessionId)).toEqual([idleId]);
  });

  it("keeps a session younger than olderThanMs and takes it once it ages", async () => {
    const idleId = await startIdleSession();

    const tooYoung = await manager.cleanSessions({ olderThanMs: 10 * 60_000 });
    expect(tooYoung.matchedSessionIds).toEqual([]);
    expect(manager.listSessions()).toHaveLength(1);

    jest.advanceTimersByTime(11 * 60_000);

    const aged = await manager.cleanSessions({ olderThanMs: 10 * 60_000 });
    expect(aged.matchedSessionIds).toEqual([idleId]);
    expect(aged.removedCount).toBe(1);
    expect(manager.listSessions()).toHaveLength(0);
  });

  it("skips a session whose lastActiveAt cannot be compared against olderThanMs", async () => {
    const idleId = await startIdleSession();
    const sessions = (manager as unknown as { sessions: Map<string, { lastActiveAt: string }> })
      .sessions;
    sessions.get(idleId)!.lastActiveAt = "not-a-timestamp";

    const report = await manager.cleanSessions({ olderThanMs: 1000 });

    expect(report.matchedSessionIds).toEqual([]);
    expect(manager.listSessions()).toHaveLength(1);
  });

  it("keeps the session on disk when includeDisk is false", async () => {
    const idleId = await startIdleSession();

    const report = await manager.cleanSessions({ includeDisk: false });

    expect(report.removedSessionIds).toEqual([idleId]);
    expect(report.diskSessionsRemoved).toBe(0);
    expect(persistence.hasSessionOnDisk(idleId)).toBe(true);
    expect(existsSync(path.join(stateDir, "sessions", idleId))).toBe(true);
  });

  it("removes the session directory when includeDisk defaults on", async () => {
    const idleId = await startIdleSession();

    const report = await manager.cleanSessions();

    expect(report.diskSessionsRemoved).toBe(1);
    expect(persistence.hasSessionOnDisk(idleId)).toBe(false);
    expect(manager.listSessions()).toHaveLength(0);
  });

  it("names the session directories a failed removal left on disk", async () => {
    const errors = jest.spyOn(console, "error").mockImplementation(() => {});
    const idleId = await startIdleSession();
    jest.spyOn(persistence, "removeSession").mockImplementation(() => {
      throw new Error("rm boom");
    });

    const report = await manager.cleanSessions();

    expect(report.removedCount).toBe(1);
    expect(report.diskSessionsRemoved).toBe(0);
    expect(report.message).toContain(idleId);
    expect(report.message).toContain("rm boom");
    expect(report.message).toContain("still on disk");
    expect(
      errors.mock.calls.some(
        (call) =>
          String(call[0]).includes("Failed to remove the session directory") &&
          String(call[0]).includes("rm boom")
      )
    ).toBe(true);
  });

  it("says nothing about disk when removal was never asked for", async () => {
    await startIdleSession();

    const report = await manager.cleanSessions({ includeDisk: false });

    expect(report.diskSessionsRemoved).toBe(0);
    expect(report.message).toBeUndefined();
  });

  it("reports a client that fails to shut down during eviction and still drops the session", async () => {
    const errors = jest.spyOn(console, "error").mockImplementation(() => {});
    const idleId = await startIdleSession();
    clients[clients.length - 1].destroy = jest.fn(async () => {
      throw new Error("destroy boom");
    });

    const report = await manager.cleanSessions();
    await advanceAsync(0);

    expect(report.removedSessionIds).toEqual([idleId]);
    expect(manager.listSessions()).toHaveLength(0);
    expect(
      errors.mock.calls.some(
        (call) =>
          String(call[0]).includes("Failed to destroy app-server client during cleanup") &&
          String(call[0]).includes("destroy boom")
      )
    ).toBe(true);
  });

  it("reports a client that fails to shut down during manager.destroy()", async () => {
    const errors = jest.spyOn(console, "error").mockImplementation(() => {});
    await startIdleSession();
    clients[clients.length - 1].destroy = jest.fn(async () => {
      throw new Error("teardown boom");
    });

    manager.destroy();
    await advanceAsync(0);

    expect(manager.listSessions()).toHaveLength(0);
    expect(
      errors.mock.calls.some(
        (call) =>
          String(call[0]).includes("during manager.destroy()") &&
          String(call[0]).includes("teardown boom")
      )
    ).toBe(true);
  });
});
