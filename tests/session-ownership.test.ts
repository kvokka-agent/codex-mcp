/**
 * Who owns a session, what an abandoned one looks like, and what resuming it does.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownStartedAt } from "../src/persistence/process-identity.js";
import { createServer } from "../src/server.js";
import { SessionManager } from "../src/session/manager/session-manager.js";
import { SessionPersistence } from "../src/session/persistence.js";
import { ErrorCode } from "../src/types/index.js";
import { present } from "./helpers/present.js";

class MockClient extends EventEmitter {
  notificationHandler: ((method: string, params: unknown) => void) | null = null;
  serverRequestHandler: ((id: number, method: string, params: unknown) => void) | null = null;

  unappliedTurnOverrides: readonly string[] | undefined = undefined;
  childPid: number | undefined = undefined;
  destroyed = false;

  start = jest.fn(async () => ({ userAgent: "mock" }));
  threadStart = jest.fn(async () => ({ thread: { id: "thr_started" } }));
  threadFork = jest.fn(async () => ({ thread: { id: "thr_forked" } }));
  threadResume = jest.fn(async (_params: unknown) => ({ thread: { id: "thr_resumed" } }));
  threadBackgroundTerminalsClean = jest.fn(async () => ({}));
  turnStart = jest.fn(async (_params: unknown) => ({ turn: { id: "turn_1" } }));
  turnInterrupt = jest.fn(async () => {});
  respondToServer = jest.fn(() => {});
  respondErrorToServer = jest.fn(() => {});
  destroy = jest.fn(async () => {
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
  jest.restoreAllMocks();
});

describe("a session this server drives", () => {
  it("claims the session and writes its thread id before the first turn ends", async () => {
    await manager.createSession("hello", process.cwd(), {}, "low");
    const [sessionId] = manager.listSessions().map((s) => s.sessionId);

    // The turn is still running: nothing has completed, and the id is on disk.
    expect(manager.getSession(sessionId).status).toBe("running");
    expect(readMeta(sessionId).threadId).toBe("thr_started");
    expect(JSON.parse(readFileSync(sessionFile(sessionId, "owner.json"), "utf-8")).pid).toBe(
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

    expect(readMeta(sessionId)).toMatchObject({
      model: "gpt-5",
      profile: "work",
      approvalPolicy: "never",
      sandbox: "read-only",
      personality: "pragmatic",
      approvalTimeoutMs: 900_000,
    });
    expect(String(readMeta(sessionId).developerInstructions)).toContain("%%%ACTIVITY:");
  });

  it("writes a turn cut off by shutdown as abandoned and gives the session back", async () => {
    await manager.createSession("hello", process.cwd(), {}, "low");
    const [sessionId] = manager.listSessions().map((s) => s.sessionId);

    manager.finalizeForShutdown();

    expect(readMeta(sessionId).status).toBe("abandoned");
    expect(existsSync(sessionFile(sessionId, "owner.json"))).toBe(false);
    expect(persistence.ownedSessions()).toEqual([]);
  });
});

describe("listing", () => {
  it("carries a session that is only on disk, with what it was doing", () => {
    writeAbandonedOnDisk("sess_disk", {}, "Подсчёт TypeScript-файлов в src");

    const listed = manager.listAllSessions();
    const found = present(
      listed.find((s) => s.sessionId === "sess_disk"),
      "the sess_disk session in the listing"
    );
    expect(found.status).toBe("abandoned");
    expect(found.activity).toBe("Подсчёт TypeScript-файлов в src");
    expect(found.owner).toBeUndefined();
  });

  it("carries the profile and the reviewer a disk record asked for", () => {
    writeAbandonedOnDisk("sess_perm", {
      permissions: ":read-only",
      approvalsReviewer: "auto_review",
      effective: { activePermissionProfile: { id: ":read-only" } },
    });

    const found = present(
      manager.listAllSessions().find((s) => s.sessionId === "sess_perm"),
      "the sess_perm session in the listing"
    );
    expect(found.permissions).toBe(":read-only");
    expect(found.approvalsReviewer).toBe("auto_review");
    expect(found.effective?.activePermissionProfile).toEqual({ id: ":read-only" });
  });

  it("leaves out a field of meta.json the schema does not describe and keeps the rest", () => {
    writeAbandonedOnDisk("sess_stale", {
      // What this release dropped from `approvalPolicy`, so a directory the
      // previous one wrote carries it.
      approvalPolicy: "on-failure",
      sandbox: "read-only",
      approvalsReviewer: "auto_review",
      permissions: ":read-only",
    });

    const found = present(
      manager.listAllSessions().find((s) => s.sessionId === "sess_stale"),
      "the sess_stale session in the listing"
    );
    expect(found.approvalPolicy).toBeUndefined();
    expect(found.sandbox).toBe("read-only");
    expect(found.approvalsReviewer).toBe("auto_review");
    expect(found.permissions).toBe(":read-only");
    expect(found.model).toBe("gpt-5");
    expect(found.status).toBe("abandoned");
  });

  it("leaves out a sandbox and a reviewer it cannot read, each on its own", () => {
    writeAbandonedOnDisk("sess_odd", {
      approvalPolicy: "never",
      sandbox: "read-write",
      approvalsReviewer: 7,
    });

    const found = present(
      manager.listAllSessions().find((s) => s.sessionId === "sess_odd"),
      "the sess_odd session in the listing"
    );
    expect(found.approvalPolicy).toBe("never");
    expect(found.sandbox).toBeUndefined();
    expect(found.approvalsReviewer).toBeUndefined();
  });

  it("names this server as the owner of the sessions it drives", async () => {
    await manager.createSession("hello", process.cwd(), {}, "low");
    const [sessionId] = manager.listSessions().map((s) => s.sessionId);

    const listed = present(
      manager.listAllSessions().find((s) => s.sessionId === sessionId),
      "the created session in the listing"
    );
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

    const client = clients[0];
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

  it("takes the settings back from Codex, including ones this server never recorded", async () => {
    // The directory records `model: "gpt-5"` and nothing about what the thread
    // ran with. A resume reads the thread out of Codex's own rollout log, so
    // its answer is what the session runs with from here.
    writeAbandonedOnDisk("sess_disk");
    const answered = {
      thread: { id: "thr_on_disk" },
      model: "gpt-5.6-luna",
      modelProvider: "myproxy",
      cwd: "/srv/work",
      approvalPolicy: "on-request",
      sandbox: { type: "readOnly", networkAccess: false },
      reasoningEffort: "xhigh",
      approvalsReviewer: "auto_review",
      activePermissionProfile: { id: ":read-only", extends: null },
    };
    manager = new SessionManager({
      disableCleanup: true,
      persistence,
      createClient: () => {
        const client = new MockClient();
        client.threadResume = jest.fn(async () => answered);
        clients.push(client);
        return client as never;
      },
    });

    await manager.resumeSession("sess_disk");

    const session = manager.getSession("sess_disk", true);
    expect(session.effective).toEqual({
      model: "gpt-5.6-luna",
      modelProvider: "myproxy",
      reasoningEffort: "xhigh",
      approvalPolicy: "on-request",
      sandbox: { type: "readOnly", networkAccess: false },
      cwd: "/srv/work",
      approvalsReviewer: "auto_review",
      activePermissionProfile: { id: ":read-only" },
    });
    expect(session.model).toBe("gpt-5");
    // The reviewer and the profile are the thread's, not this server's record:
    // nothing on disk named either.
    expect(session.approvalsReviewer).toBeUndefined();
    expect(session.permissions).toBeUndefined();
    expect(readMeta("sess_disk").effective).toMatchObject({
      model: "gpt-5.6-luna",
      approvalsReviewer: "auto_review",
      activePermissionProfile: { id: ":read-only" },
    });
  });

  it("keeps the settings it holds when the resume answers none", async () => {
    writeAbandonedOnDisk("sess_kept", {
      effective: { model: "gpt-5.6-luna", reasoningEffort: "high" },
    });

    await manager.resumeSession("sess_kept");

    expect(manager.getSession("sess_kept", true).effective).toEqual({
      model: "gpt-5.6-luna",
      reasoningEffort: "high",
    });
  });

  it("refuses a session a running server holds", async () => {
    writeAbandonedOnDisk("sess_held");
    // This test process is alive under its own pid and start time — the same
    // claim a running codex-mcp writes for the sessions it drives.
    writeFileSync(
      sessionFile("sess_held", "owner.json"),
      JSON.stringify({ pid: process.pid, startedAt: ownStartedAt() })
    );
    // The owner is read as another server: the pid is not this manager's to
    // take. `process.pid` is an own accessor of the process object, which a spy
    // does not reach, so it is redefined here and put back below — every file of
    // the suite shares this process.
    const ownPid = process.pid;
    Object.defineProperty(process, "pid", { configurable: true, get: () => ownPid + 1 });
    try {
      await expect(manager.resumeSession("sess_held")).rejects.toThrow(
        ErrorCode.SESSION_HELD_BY_OTHER_SERVER
      );
    } finally {
      Object.defineProperty(process, "pid", { configurable: true, value: ownPid });
    }
    // 30s: proving the recorded pid is a live process asks the OS for its start
    // time, and on Windows that is a CIM query and then a wmic one, each with a
    // five-second budget of its own.
  }, 30_000);

  it("refuses a session that recorded no thread id", async () => {
    writeAbandonedOnDisk("sess_no_thread", { threadId: undefined });

    await expect(manager.resumeSession("sess_no_thread")).rejects.toThrow(/records no threadId/);
  });

  it("refuses a session this server is already driving", async () => {
    await manager.createSession("hello", process.cwd(), {}, "low");
    const [sessionId] = manager.listSessions().map((s) => s.sessionId);

    await expect(manager.resumeSession(sessionId)).rejects.toThrow(ErrorCode.SESSION_BUSY);
  });

  it("leaves the session abandoned when the resume itself fails", async () => {
    writeAbandonedOnDisk("sess_broken");
    const failing = new MockClient();
    failing.threadResume = jest.fn(async () => {
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

/**
 * The answer `codex_session(action="list")` hands a client, which the MCP SDK
 * holds against the tool's output schema before it leaves the server: a field
 * outside an enum of that schema fails the whole call, not the field.
 */
describe("the listing a client receives", () => {
  interface ToolCallResult {
    content: Array<{ type: string; text: string }>;
    structuredContent?: { sessions?: Array<Record<string, unknown>> };
    isError?: boolean;
  }

  it("carries a good session directory beside one whose approvalPolicy it cannot read", async () => {
    writeAbandonedOnDisk("sess_stale", { approvalPolicy: "on-failure" });
    writeAbandonedOnDisk("sess_good", { approvalPolicy: "never", sandbox: "read-only" });

    const ctx = createServer(process.cwd(), {
      disableCleanup: true,
      persistence,
      createClient: () => new MockClient() as never,
    });
    const internal = ctx.server as unknown as {
      server: {
        _requestHandlers: Map<string, (req: unknown, extra: unknown) => Promise<unknown>>;
      };
    };
    const handler = present(
      internal.server._requestHandlers.get("tools/call"),
      "the tools/call request handler"
    );

    const res = (await handler(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "codex_session", arguments: { action: "list" } },
      },
      { signal: new AbortController().signal }
    )) as ToolCallResult;
    await ctx.server.close();

    expect(res.isError).toBeFalsy();
    const sessions = present(res.structuredContent?.sessions, "the listed sessions");
    const byId = new Map(sessions.map((session) => [session.sessionId, session]));
    expect(byId.get("sess_stale")?.approvalPolicy).toBeUndefined();
    expect(byId.get("sess_good")?.approvalPolicy).toBe("never");
    expect(byId.get("sess_good")?.sandbox).toBe("read-only");
  });
});
