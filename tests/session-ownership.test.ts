/**
 * Who owns a session, what an abandoned one looks like, and what resuming it does.
 */
import { EventEmitter } from "events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { SessionManager } from "../src/session/manager.js";
import { SessionPersistence } from "../src/session/persistence.js";
import { ownStartedAt } from "../src/persistence/process-identity.js";
import { ErrorCode } from "../src/types.js";

class MockClient extends EventEmitter {
  notificationHandler: ((method: string, params: unknown) => void) | null = null;
  serverRequestHandler: ((id: number, method: string, params: unknown) => void) | null = null;

  supportsTurnOverrides = true;
  unappliedTurnOverrides: readonly string[] | undefined = undefined;
  childPid: number | undefined = undefined;
  destroyed = false;

  start = vi.fn(async () => ({ userAgent: "mock" }));
  threadStart = vi.fn(async () => ({ thread: { id: "thr_started" } }));
  threadFork = vi.fn(async () => ({ thread: { id: "thr_forked" } }));
  threadResume = vi.fn(async (_params: unknown) => ({ thread: { id: "thr_resumed" } }));
  threadBackgroundTerminalsClean = vi.fn(async () => ({}));
  turnStart = vi.fn(async (_params: unknown) => ({ turn: { id: "turn_1" } }));
  turnInterrupt = vi.fn(async () => {});
  respondToServer = vi.fn(() => {});
  respondErrorToServer = vi.fn(() => {});
  destroy = vi.fn(async () => {
    this.destroyed = true;
  });

  onNotification(handler: (method: string, params: unknown) => void): void {
    this.notificationHandler = handler;
  }
  onServerRequest(handler: (id: number, method: string, params: unknown) => void): void {
    this.serverRequestHandler = handler;
  }
}

let stateDir: string;
let persistence: SessionPersistence;
let manager: SessionManager;
let clients: MockClient[];

function sessionFile(sessionId: string, name: string): string {
  return join(stateDir, "sessions", sessionId, name);
}

function readMeta(sessionId: string): Record<string, unknown> {
  return JSON.parse(readFileSync(sessionFile(sessionId, "meta.json"), "utf-8"));
}

/** Write a session directory the way a server that died mid-turn left one. */
function writeAbandonedOnDisk(
  sessionId: string,
  extras: Record<string, unknown> = {},
  activity?: string
): void {
  const at = "2026-01-02T03:04:05.000Z";
  const dir = join(stateDir, "sessions", sessionId);
  const helper = new SessionPersistence(stateDir);
  helper.appendEvent(sessionId, "activity", { activity: activity ?? "Reading src/index.ts" }, at);
  helper.flushAll();
  writeFileSync(
    join(dir, "meta.json"),
    JSON.stringify({
      schemaVersion: 2,
      sessionId,
      status: "running",
      createdAt: at,
      lastActiveAt: at,
      threadId: "thr_on_disk",
      cwd: process.cwd(),
      model: "gpt-5",
      developerInstructions: "# Activity marker",
      ...extras,
    })
  );
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "codex-mcp-ownership-"));
  persistence = new SessionPersistence(stateDir);
  clients = [];
  manager = new SessionManager({
    disableCleanup: true,
    persistence,
    createClient: () => {
      const client = new MockClient();
      clients.push(client);
      return client as never;
    },
  });
});

afterEach(() => {
  manager.destroy();
  persistence.destroy();
  rmSync(stateDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("a session this server drives", () => {
  it("claims the session and writes its thread id before the first turn ends", async () => {
    await manager.createSession("hello", process.cwd(), {}, "low");
    const [sessionId] = manager.listSessions().map((s) => s.sessionId);

    // The turn is still running: nothing has completed, and the id is on disk.
    expect(manager.getSession(sessionId!).status).toBe("running");
    expect(readMeta(sessionId!).threadId).toBe("thr_started");
    expect(JSON.parse(readFileSync(sessionFile(sessionId!, "owner.json"), "utf-8")).pid).toBe(
      process.pid
    );
    expect(persistence.ownedSessions()).toEqual([sessionId]);
  });

  it("records everything a resume needs, including the marker instruction", async () => {
    await manager.createSession(
      "hello",
      process.cwd(),
      { model: "gpt-5", profile: "work", approvalPolicy: "never", sandbox: "read-only" },
      "low",
      { personality: "pragmatic", approvalTimeoutMs: 900_000 }
    );
    const [sessionId] = manager.listSessions().map((s) => s.sessionId);

    expect(readMeta(sessionId!)).toMatchObject({
      model: "gpt-5",
      profile: "work",
      approvalPolicy: "never",
      sandbox: "read-only",
      personality: "pragmatic",
      approvalTimeoutMs: 900_000,
    });
    expect(String(readMeta(sessionId!).developerInstructions)).toContain("%%%ACTIVITY:");
  });

  it("writes a turn cut off by shutdown as abandoned and gives the session back", async () => {
    await manager.createSession("hello", process.cwd(), {}, "low");
    const [sessionId] = manager.listSessions().map((s) => s.sessionId);

    manager.finalizeForShutdown();

    expect(readMeta(sessionId!).status).toBe("abandoned");
    expect(existsSync(sessionFile(sessionId!, "owner.json"))).toBe(false);
    expect(persistence.ownedSessions()).toEqual([]);
  });
});

describe("listing", () => {
  it("carries a session that is only on disk, with what it was doing", () => {
    writeAbandonedOnDisk("sess_disk", {}, "Подсчёт TypeScript-файлов в src");

    const listed = manager.listAllSessions();
    const found = listed.find((s) => s.sessionId === "sess_disk")!;
    expect(found.status).toBe("abandoned");
    expect(found.activity).toBe("Подсчёт TypeScript-файлов в src");
    expect(found.owner).toBeUndefined();
  });

  it("names this server as the owner of the sessions it drives", async () => {
    await manager.createSession("hello", process.cwd(), {}, "low");
    const [sessionId] = manager.listSessions().map((s) => s.sessionId);

    const listed = manager.listAllSessions().find((s) => s.sessionId === sessionId)!;
    expect(listed.owner).toEqual({ pid: process.pid, state: "self" });
  });
});

describe("resume", () => {
  it("restores the thread from disk and lets the next turn through", async () => {
    writeAbandonedOnDisk("sess_disk");

    const resumed = await manager.resumeSession("sess_disk");
    expect(resumed).toMatchObject({
      sessionId: "sess_disk",
      threadId: "thr_on_disk",
      status: "idle",
    });

    const client = clients[0]!;
    expect(client.threadResume).toHaveBeenCalledWith({
      threadId: "thr_on_disk",
      developerInstructions: "# Activity marker",
    });
    expect(client.start).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-5", profile: undefined })
    );
    expect(readMeta("sess_disk").status).toBe("idle");
    expect(JSON.parse(readFileSync(sessionFile("sess_disk", "owner.json"), "utf-8")).pid).toBe(
      process.pid
    );

    await manager.replyToSession("sess_disk", "carry on");
    expect(client.turnStart).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "thr_on_disk" })
    );
  });

  it("refuses a session a running server holds", async () => {
    writeAbandonedOnDisk("sess_held");
    // This test process is alive under its own pid and start time — the same
    // claim a running codex-mcp writes for the sessions it drives.
    writeFileSync(
      sessionFile("sess_held", "owner.json"),
      JSON.stringify({ pid: process.pid, startedAt: ownStartedAt() })
    );
    // The owner is read as another server: the pid is not this manager's to take.
    vi.spyOn(process, "pid", "get").mockReturnValue(process.pid + 1);

    await expect(manager.resumeSession("sess_held")).rejects.toThrow(
      ErrorCode.SESSION_HELD_BY_OTHER_SERVER
    );
  });

  it("refuses a session that recorded no thread id", async () => {
    writeAbandonedOnDisk("sess_no_thread", { threadId: undefined });

    await expect(manager.resumeSession("sess_no_thread")).rejects.toThrow(/records no threadId/);
  });

  it("refuses a session this server is already driving", async () => {
    await manager.createSession("hello", process.cwd(), {}, "low");
    const [sessionId] = manager.listSessions().map((s) => s.sessionId);

    await expect(manager.resumeSession(sessionId!)).rejects.toThrow(ErrorCode.SESSION_BUSY);
  });

  it("leaves the session abandoned when the resume itself fails", async () => {
    writeAbandonedOnDisk("sess_broken");
    const failing = new MockClient();
    failing.threadResume = vi.fn(async () => {
      throw new Error("app-server refused");
    });
    manager = new SessionManager({
      disableCleanup: true,
      persistence,
      createClient: () => failing as never,
    });

    await expect(manager.resumeSession("sess_broken")).rejects.toThrow(
      ErrorCode.THREAD_FORK_RESUME_FAILED
    );
    expect(manager.getSession("sess_broken").status).toBe("abandoned");
    expect(failing.destroyed).toBe(true);
  });

  it("reports a session no directory holds as not found", async () => {
    await expect(manager.resumeSession("sess_nowhere")).rejects.toThrow(
      ErrorCode.SESSION_NOT_FOUND
    );
  });
});
