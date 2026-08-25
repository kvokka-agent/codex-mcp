import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SessionPersistence, startDiskPersistence } from "../src/session/persistence.js";
import { SCHEMA_VERSION } from "../src/persistence/index.js";
import type { SessionInfo } from "../src/types.js";

let root: string;
let persistence: SessionPersistence | null = null;
const envBackup = process.env.CODEX_MCP_STATE_DIR;

function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    sessionId: "sess_1",
    threadId: "thread_1",
    lastEventCursor: 0,
    status: "running",
    createdAt: "2024-01-01T00:00:00.000Z",
    lastActiveAt: "2024-01-02T00:00:00.000Z",
    cwd: "/work/repo",
    model: "gpt-5",
    profile: "default",
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
    eventBuffer: { events: [], maxSize: 10, hardMaxSize: 20, nextId: 0 },
    pendingRequests: new Map(),
    ...overrides,
  } as SessionInfo;
}

function sessionFile(sessionId: string, name: string): string {
  return join(root, "sessions", sessionId, name);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "codex-mcp-session-persistence-"));
  delete process.env.CODEX_MCP_STATE_DIR;
});

afterEach(() => {
  persistence?.destroy();
  persistence = null;
  rmSync(root, { recursive: true, force: true });
  if (envBackup === undefined) delete process.env.CODEX_MCP_STATE_DIR;
  else process.env.CODEX_MCP_STATE_DIR = envBackup;
});

describe("SessionPersistence", () => {
  it("creates the sessions directory under the given state dir", () => {
    persistence = new SessionPersistence(root);
    expect(existsSync(join(root, "sessions"))).toBe(true);
  });

  it("uses CODEX_MCP_STATE_DIR when no state dir is passed", () => {
    const stateDir = join(root, "from-env");
    process.env.CODEX_MCP_STATE_DIR = stateDir;
    persistence = new SessionPersistence();

    persistence.writeSessionMeta(makeSession());
    expect(existsSync(join(stateDir, "sessions", "sess_1", "meta.json"))).toBe(true);
  });

  it("writes session metadata that the recovery scanner reads back", () => {
    persistence = new SessionPersistence(root);
    persistence.writeSessionMeta(
      makeSession({
        status: "cancelled",
        cancelledAt: "2024-01-03T00:00:00.000Z",
        cancelledReason: "user",
      })
    );

    const meta = JSON.parse(readFileSync(sessionFile("sess_1", "meta.json"), "utf-8"));
    expect(meta).toEqual({
      schemaVersion: SCHEMA_VERSION,
      sessionId: "sess_1",
      status: "cancelled",
      createdAt: "2024-01-01T00:00:00.000Z",
      lastActiveAt: "2024-01-02T00:00:00.000Z",
      cancelledAt: "2024-01-03T00:00:00.000Z",
      cancelledReason: "user",
      threadId: "thread_1",
      model: "gpt-5",
      cwd: "/work/repo",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      profile: "default",
    });

    const [recovered] = persistence.recoverSessions();
    expect(recovered!.sessionId).toBe("sess_1");
    expect(recovered!.meta.status).toBe("cancelled");
  });

  it("writes pid info with a spawn timestamp", () => {
    persistence = new SessionPersistence(root);
    persistence.writePidInfo("sess_1", 4242, "codex exec");

    const info = JSON.parse(readFileSync(sessionFile("sess_1", "pid.json"), "utf-8"));
    expect(info.pid).toBe(4242);
    expect(info.command).toBe("codex exec");
    expect(Number.isNaN(Date.parse(info.spawnedAt))).toBe(false);
  });

  it("flushes critical events immediately and batches the rest until flushAll", () => {
    persistence = new SessionPersistence(root);

    persistence.appendEvent("sess_1", "progress", { step: 1 });
    expect(existsSync(sessionFile("sess_1", "events.jsonl"))).toBe(false);

    persistence.appendEvent("sess_1", "approval_request", { requestId: "req_1" });
    const afterCritical = readFileSync(sessionFile("sess_1", "events.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(afterCritical).toHaveLength(2);
    expect(afterCritical[0]).toMatchObject({ seq: 0, type: "progress", data: { step: 1 } });
    expect(afterCritical[1]).toMatchObject({ seq: 1, type: "approval_request" });
    expect(Number.isNaN(Date.parse(afterCritical[1].timestamp))).toBe(false);

    persistence.appendEvent("sess_1", "output", { text: "hi" });
    persistence.flushAll();
    expect(
      readFileSync(sessionFile("sess_1", "events.jsonl"), "utf-8").trim().split("\n")
    ).toHaveLength(3);
  });

  it("continues event numbering from the recovered sequence", () => {
    persistence = new SessionPersistence(root);
    persistence.setEventLogNextSeq("sess_1", 7);
    persistence.appendEvent("sess_1", "result", { ok: true });

    const line = JSON.parse(readFileSync(sessionFile("sess_1", "events.jsonl"), "utf-8").trim());
    expect(line.seq).toBe(7);
  });

  it("keeps using the same log when the sequence is set after the first append", () => {
    persistence = new SessionPersistence(root);
    persistence.appendEvent("sess_1", "error", { message: "x" });
    persistence.setEventLogNextSeq("sess_1", 100);
    persistence.appendEvent("sess_1", "error", { message: "y" });

    const seqs = readFileSync(sessionFile("sess_1", "events.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).seq);
    expect(seqs).toEqual([0, 100]);
  });

  it("writes the final result", () => {
    persistence = new SessionPersistence(root);
    persistence.writeResult("sess_1", { status: "completed", output: "done" });

    expect(JSON.parse(readFileSync(sessionFile("sess_1", "result.json"), "utf-8"))).toEqual({
      status: "completed",
      output: "done",
    });
  });

  it("reports whether a session is on disk", () => {
    persistence = new SessionPersistence(root);
    expect(persistence.hasSessionOnDisk("sess_1")).toBe(false);

    persistence.writeSessionMeta(makeSession());
    expect(persistence.hasSessionOnDisk("sess_1")).toBe(true);
  });

  it("removes a session directory and its event log", () => {
    persistence = new SessionPersistence(root);
    persistence.writeSessionMeta(makeSession());
    persistence.appendEvent("sess_1", "result", { ok: true });

    persistence.removeSession("sess_1");
    expect(existsSync(join(root, "sessions", "sess_1"))).toBe(false);
    expect(persistence.hasSessionOnDisk("sess_1")).toBe(false);
    expect(persistence.recoverSessions()).toEqual([]);

    // A later append recreates the directory with a fresh sequence.
    persistence.appendEvent("sess_1", "result", { ok: true });
    expect(
      JSON.parse(readFileSync(sessionFile("sess_1", "events.jsonl"), "utf-8").trim()).seq
    ).toBe(0);
  });

  it("destroySessionLog flushes buffered events for that session only", () => {
    persistence = new SessionPersistence(root);
    persistence.appendEvent("sess_1", "progress", { a: 1 });
    persistence.appendEvent("sess_2", "progress", { b: 2 });

    persistence.destroySessionLog("sess_1");
    expect(existsSync(sessionFile("sess_1", "events.jsonl"))).toBe(true);
    expect(existsSync(sessionFile("sess_2", "events.jsonl"))).toBe(false);

    persistence.destroySessionLog("sess_missing");
    persistence.flushAll();
    expect(existsSync(sessionFile("sess_2", "events.jsonl"))).toBe(true);
  });

  it("prunes session directories through the retention policy", () => {
    persistence = new SessionPersistence(root);
    const stale = join(root, "sessions", "sess_old");
    mkdirSync(stale, { recursive: true });
    writeFileSync(
      join(stale, "meta.json"),
      JSON.stringify({
        sessionId: "sess_old",
        lastActiveAt: new Date(Date.now() - 60_000).toISOString(),
      })
    );
    persistence.writeSessionMeta(makeSession({ lastActiveAt: new Date().toISOString() }));

    expect(persistence.prune({ maxAgeMs: 10_000 })).toBe(1);
    expect(existsSync(stale)).toBe(false);
    expect(persistence.hasSessionOnDisk("sess_1")).toBe(true);
  });

  it("holds the state dir lock until it is released", () => {
    persistence = new SessionPersistence(root);
    persistence.acquireLock();

    const lockPath = join(root, ".lock");
    expect(JSON.parse(readFileSync(lockPath, "utf-8")).pid).toBe(process.pid);

    persistence.releaseLockIfHeld();
    expect(existsSync(lockPath)).toBe(false);
    persistence.releaseLockIfHeld();
    expect(existsSync(lockPath)).toBe(false);
  });

  it("destroy flushes every log and releases the lock", () => {
    persistence = new SessionPersistence(root);
    persistence.acquireLock();
    persistence.appendEvent("sess_1", "progress", { a: 1 });
    persistence.appendEvent("sess_2", "progress", { b: 2 });

    persistence.destroy();
    persistence = null;

    expect(existsSync(sessionFile("sess_1", "events.jsonl"))).toBe(true);
    expect(existsSync(sessionFile("sess_2", "events.jsonl"))).toBe(true);
    expect(existsSync(join(root, ".lock"))).toBe(false);
  });
});

describe("startDiskPersistence", () => {
  it("recovers and prunes when it owns STATE_DIR", () => {
    persistence = new SessionPersistence(root);
    persistence.writeSessionMeta(makeSession({ sessionId: "sess_owned", status: "running" }));
    persistence.destroy();

    const second = new SessionPersistence(root);
    const startup = startDiskPersistence(second);
    persistence = second;

    expect(startup.persistence).toBe(second);
    expect(startup.recovered.map((r) => r.sessionId)).toContain("sess_owned");
    expect(existsSync(join(root, ".lock"))).toBe(true);
  });

  it("leaves another server's state untouched when the lock is held", () => {
    // The first server keeps its lock and its session directory. acquireLock treats a
    // lock held by this very process as reentrant, so the owner is the parent process.
    const owner = new SessionPersistence(root);
    owner.writeSessionMeta(makeSession({ sessionId: "sess_live", status: "running" }));
    owner.writePidInfo("sess_live", 4242, "gpt-5");
    writeFileSync(
      join(root, ".lock"),
      JSON.stringify({ pid: process.ppid, startedAt: "2024-01-01T00:00:00.000Z" }) + "\n",
      "utf-8"
    );

    const errors: unknown[][] = [];
    const consoleError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };

    try {
      const startup = startDiskPersistence(new SessionPersistence(root));

      // No adapter, so SessionManager never writes into the owner's STATE_DIR.
      expect(startup.persistence).toBeUndefined();
      // No recovered sessions, so reapOrphanProcesses gets no live PID to kill.
      expect(startup.recovered).toEqual([]);
      expect(startup.pruned).toBe(0);
      expect(errors.some((args) => String(args[0]).includes("another server owns STATE_DIR"))).toBe(
        true
      );
    } finally {
      console.error = consoleError;
    }

    expect(existsSync(sessionFile("sess_live", "meta.json"))).toBe(true);
    expect(existsSync(sessionFile("sess_live", "pid.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(root, ".lock"), "utf-8")).pid).toBe(process.ppid);

    owner.destroy();
  });
});
