import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Injected failures, keyed by `${call}\0${path}`, holding the errno code to raise. */
const { fsFaults } = vi.hoisted(() => ({
  fsFaults: new Map<string, { code: string; skip: number; times: number }>(),
}));

/**
 * Make one `node:fs` call fail for one path; every other call and path reaches the real
 * filesystem. A POSIX mode cannot stand in for this: Windows ignores the mode bits, so a
 * `chmod 0o500` directory stays writable and the error branch under test never runs there.
 *
 * `skip` lets that many calls through first and `times` caps how many then fail, which is
 * how one step of startup is singled out when the steps around it read the same path.
 */
function failFs(
  call: "mkdirSync" | "readdirSync",
  path: string,
  code = "EACCES",
  { skip = 0, times = Number.POSITIVE_INFINITY }: { skip?: number; times?: number } = {}
): void {
  fsFaults.set(`${call}\0${path}`, { code, skip, times });
}

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const failIfInjected = (call: string, target: unknown): void => {
    const fault = fsFaults.get(`${call}\0${String(target)}`);
    if (!fault) return;
    if (fault.skip > 0) {
      fault.skip--;
      return;
    }
    if (fault.times <= 0) return;
    fault.times--;
    const err = new Error(
      `${fault.code}: injected failure, ${call} '${String(target)}'`
    ) as NodeJS.ErrnoException;
    err.code = fault.code;
    throw err;
  };
  return {
    ...actual,
    default: actual,
    mkdirSync: ((...args: Parameters<typeof actual.mkdirSync>) => {
      failIfInjected("mkdirSync", args[0]);
      return actual.mkdirSync(...args);
    }) as typeof actual.mkdirSync,
    readdirSync: ((...args: Parameters<typeof actual.readdirSync>) => {
      failIfInjected("readdirSync", args[0]);
      return actual.readdirSync(...args);
    }) as typeof actual.readdirSync,
  };
});

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionPersistence, startDiskPersistence } from "../src/session/persistence.js";
import { SCHEMA_VERSION } from "../src/persistence/index.js";
import type { SessionInfo } from "../src/types.js";

let root: string;
let persistence: SessionPersistence | null = null;
const envBackup = process.env.CODEX_MCP_STATE_DIR;
/** appendEvent takes the event's timestamp from its caller; these tests supply it. */
const EVENT_AT = "2024-03-04T05:06:07.008Z";

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
  fsFaults.clear();
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

  it("writes pid info with a spawn timestamp, and the model under its own key", () => {
    persistence = new SessionPersistence(root);
    persistence.writePidInfo("sess_1", 4242, { command: "codex app-server", model: "gpt-5" });

    const info = JSON.parse(readFileSync(sessionFile("sess_1", "pid.json"), "utf-8"));
    expect(info.pid).toBe(4242);
    expect(info.command).toBe("codex app-server");
    expect(info.model).toBe("gpt-5");
    expect(Number.isNaN(Date.parse(info.spawnedAt))).toBe(false);
  });

  it("gives the orphan reaper the pid and spawn time even with no details", () => {
    persistence = new SessionPersistence(root);
    persistence.writePidInfo("sess_1", 4242);

    // reapOrphanProcesses reads exactly these two fields off pidInfo.
    const [recovered] = persistence.recoverSessions();
    expect(recovered).toBeUndefined();

    persistence.writeSessionMeta(makeSession());
    const pidInfo = persistence.recoverSessions()[0]!.pidInfo!;
    expect(pidInfo.pid).toBe(4242);
    expect(Number.isNaN(Date.parse(pidInfo.spawnedAt))).toBe(false);
    expect("command" in pidInfo).toBe(false);
  });

  it("flushes critical events immediately and batches the rest until flushAll", () => {
    persistence = new SessionPersistence(root);

    persistence.appendEvent("sess_1", "progress", { step: 1 }, EVENT_AT);
    expect(existsSync(sessionFile("sess_1", "events.jsonl"))).toBe(false);

    persistence.appendEvent("sess_1", "approval_request", { requestId: "req_1" }, EVENT_AT);
    const afterCritical = readFileSync(sessionFile("sess_1", "events.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(afterCritical).toHaveLength(2);
    expect(afterCritical[0]).toMatchObject({ seq: 0, type: "progress", data: { step: 1 } });
    expect(afterCritical[1]).toMatchObject({ seq: 1, type: "approval_request" });
    // The line carries the caller's timestamp, not one appendEvent read itself.
    expect(afterCritical.map((line: { timestamp: string }) => line.timestamp)).toEqual([
      EVENT_AT,
      EVENT_AT,
    ]);

    persistence.appendEvent("sess_1", "output", { text: "hi" }, EVENT_AT);
    persistence.flushAll();
    expect(
      readFileSync(sessionFile("sess_1", "events.jsonl"), "utf-8").trim().split("\n")
    ).toHaveLength(3);
  });

  it("continues event numbering from the recovered sequence", () => {
    persistence = new SessionPersistence(root);
    persistence.setEventLogNextSeq("sess_1", 7);
    persistence.appendEvent("sess_1", "result", { ok: true }, EVENT_AT);

    const line = JSON.parse(readFileSync(sessionFile("sess_1", "events.jsonl"), "utf-8").trim());
    expect(line.seq).toBe(7);
  });

  it("keeps using the same log when the sequence is set after the first append", () => {
    persistence = new SessionPersistence(root);
    persistence.appendEvent("sess_1", "error", { message: "x" }, EVENT_AT);
    persistence.setEventLogNextSeq("sess_1", 100);
    persistence.appendEvent("sess_1", "error", { message: "y" }, EVENT_AT);

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
    persistence.appendEvent("sess_1", "result", { ok: true }, EVENT_AT);

    persistence.removeSession("sess_1");
    expect(existsSync(join(root, "sessions", "sess_1"))).toBe(false);
    expect(persistence.hasSessionOnDisk("sess_1")).toBe(false);
    expect(persistence.recoverSessions()).toEqual([]);

    // A later append recreates the directory with a fresh sequence.
    persistence.appendEvent("sess_1", "result", { ok: true }, EVENT_AT);
    expect(
      JSON.parse(readFileSync(sessionFile("sess_1", "events.jsonl"), "utf-8").trim()).seq
    ).toBe(0);
  });

  it("destroySessionLog flushes buffered events for that session only", () => {
    persistence = new SessionPersistence(root);
    persistence.appendEvent("sess_1", "progress", { a: 1 }, EVENT_AT);
    persistence.appendEvent("sess_2", "progress", { b: 2 }, EVENT_AT);

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

  it("hands a sessions directory it cannot list to the caller of prune", () => {
    persistence = new SessionPersistence(root);
    persistence.writeSessionMeta(makeSession());
    failFs("readdirSync", join(root, "sessions"));

    // Zero pruned would tell a running server retention succeeded over an empty disk.
    expect(() => persistence!.prune({ maxAgeMs: 10_000 })).toThrow(/EACCES/);
    expect(persistence.hasSessionOnDisk("sess_1")).toBe(true);
  });

  it("hands a sessions directory it cannot list to the caller of recoverSessions", () => {
    persistence = new SessionPersistence(root);
    persistence.writeSessionMeta(makeSession());
    failFs("readdirSync", join(root, "sessions"));

    expect(() => persistence!.recoverSessions()).toThrow(/EACCES/);
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
    persistence.appendEvent("sess_1", "progress", { a: 1 }, EVENT_AT);
    persistence.appendEvent("sess_2", "progress", { b: 2 }, EVENT_AT);

    persistence.destroy();
    persistence = null;

    expect(existsSync(sessionFile("sess_1", "events.jsonl"))).toBe(true);
    expect(existsSync(sessionFile("sess_2", "events.jsonl"))).toBe(true);
    expect(existsSync(join(root, ".lock"))).toBe(false);
  });
});

describe("startDiskPersistence", () => {
  /** Collect stderr lines while `run` executes, so a warning can be asserted on. */
  function captureConsoleError<T>(run: () => T): { result: T; errors: unknown[][] } {
    const errors: unknown[][] = [];
    const consoleError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    try {
      return { result: run(), errors };
    } finally {
      console.error = consoleError;
    }
  }

  function activeSession(sessionId: string): SessionInfo {
    const now = new Date().toISOString();
    return makeSession({ sessionId, status: "running", createdAt: now, lastActiveAt: now });
  }

  it("recovers and prunes when it owns STATE_DIR", () => {
    const owner = new SessionPersistence(root);
    owner.writeSessionMeta(activeSession("sess_owned"));
    owner.destroy();

    const startup = startDiskPersistence(root);
    persistence = startup.persistence ?? null;

    expect(startup.persistence).toBeInstanceOf(SessionPersistence);
    expect(startup.recovered.map((r) => r.sessionId)).toContain("sess_owned");
    expect(existsSync(join(root, ".lock"))).toBe(true);
  });

  it("keeps pruned sessions out of what it hands back", () => {
    // Retention defaults to 7 days, so a session last active 30 days ago is pruned.
    const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const owner = new SessionPersistence(root);
    owner.writeSessionMeta(
      makeSession({ sessionId: "sess_stale", createdAt: longAgo, lastActiveAt: longAgo })
    );
    owner.writeSessionMeta(activeSession("sess_fresh"));
    owner.destroy();

    const startup = startDiskPersistence(root);
    persistence = startup.persistence ?? null;

    expect(startup.pruned).toBe(1);
    expect(startup.recovered.map((r) => r.sessionId)).toEqual(["sess_fresh"]);
    expect(existsSync(sessionFile("sess_stale", "meta.json"))).toBe(false);
  });

  it("serves without persistence when the state directory cannot be created", () => {
    const stateDir = join(root, "read-only-home", "state");
    failFs("mkdirSync", join(stateDir, "sessions"));

    const { result: startup, errors } = captureConsoleError(() => startDiskPersistence(stateDir));

    expect(startup.persistence).toBeUndefined();
    expect(startup.recovered).toEqual([]);
    expect(startup.pruned).toBe(0);
    const warning = errors.find((args) =>
      String(args[0]).includes("running without disk persistence")
    );
    expect(warning).toBeDefined();
    expect(String((warning![1] as Error).message)).toContain("EACCES");
  });

  it("serves without persistence when retention cannot list the sessions directory", () => {
    const owner = new SessionPersistence(root);
    owner.writeSessionMeta(activeSession("sess_kept"));
    owner.destroy();
    // times 1: only retention's listing fails, so the scan after it would have succeeded.
    failFs("readdirSync", join(root, "sessions"), "EACCES", { times: 1 });

    const { result: startup, errors } = captureConsoleError(() => startDiskPersistence(root));

    expect(startup.persistence).toBeUndefined();
    expect(startup.recovered).toEqual([]);
    expect(startup.pruned).toBe(0);
    const warning = errors.find((args) =>
      String(args[0]).includes("running without disk persistence")
    );
    expect(String((warning![1] as Error).message)).toContain("EACCES");
    // The rollback gives STATE_DIR back, so the next server can take it.
    expect(existsSync(join(root, ".lock"))).toBe(false);
    expect(existsSync(sessionFile("sess_kept", "meta.json"))).toBe(true);
  });

  it("serves without persistence when the recovery scan cannot list the sessions directory", () => {
    const owner = new SessionPersistence(root);
    owner.writeSessionMeta(activeSession("sess_kept"));
    owner.destroy();
    // skip 1: retention lists the directory first, and this fault is for the scan after it.
    failFs("readdirSync", join(root, "sessions"), "EACCES", { skip: 1 });

    const { result: startup, errors } = captureConsoleError(() => startDiskPersistence(root));

    expect(startup.persistence).toBeUndefined();
    expect(startup.recovered).toEqual([]);
    expect(startup.pruned).toBe(0);
    const warning = errors.find((args) =>
      String(args[0]).includes("running without disk persistence")
    );
    expect(String((warning![1] as Error).message)).toContain("EACCES");
    expect(existsSync(join(root, ".lock"))).toBe(false);
    expect(existsSync(sessionFile("sess_kept", "meta.json"))).toBe(true);
  });

  it("leaves another server's state untouched when the lock is held", () => {
    // The first server keeps its lock and its session directory. acquireLock treats a
    // lock held by this very process as reentrant, so the owner is the parent process.
    const owner = new SessionPersistence(root);
    owner.writeSessionMeta(activeSession("sess_live"));
    owner.writePidInfo("sess_live", 4242, { model: "gpt-5" });
    writeFileSync(
      join(root, ".lock"),
      JSON.stringify({ pid: process.ppid, startedAt: "2024-01-01T00:00:00.000Z" }) + "\n",
      "utf-8"
    );

    const { result: startup, errors } = captureConsoleError(() => startDiskPersistence(root));

    // No adapter, so SessionManager never writes into the owner's STATE_DIR.
    expect(startup.persistence).toBeUndefined();
    // No recovered sessions, so reapOrphanProcesses gets no live PID to kill.
    expect(startup.recovered).toEqual([]);
    expect(startup.pruned).toBe(0);
    const warning = errors.find((args) =>
      String(args[0]).includes("running without disk persistence")
    );
    expect(String((warning![1] as Error).message)).toContain("STATE_DIR is locked by another");

    expect(existsSync(sessionFile("sess_live", "meta.json"))).toBe(true);
    expect(existsSync(sessionFile("sess_live", "pid.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(root, ".lock"), "utf-8")).pid).toBe(process.ppid);

    owner.destroy();
  });
});
