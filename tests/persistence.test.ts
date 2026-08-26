import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Injected failures, keyed by `${call}\0${path}`, holding the errno code to raise. */
const { fsFaults } = vi.hoisted(() => ({ fsFaults: new Map<string, string>() }));

/**
 * Make one `node:fs` call fail for one path; every other call and path reaches the real
 * filesystem. A POSIX mode cannot stand in for this: Windows ignores the mode bits, so a
 * `chmod 0o500` directory stays writable and the error branch under test never runs there.
 */
function failFs(call: "openSync" | "readdirSync" | "rmSync", path: string, code = "EACCES"): void {
  fsFaults.set(`${call}\0${path}`, code);
}

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const failIfInjected = (call: string, target: unknown): void => {
    const code = fsFaults.get(`${call}\0${String(target)}`);
    if (!code) return;
    const err = new Error(
      `${code}: injected failure, ${call} '${String(target)}'`
    ) as NodeJS.ErrnoException;
    err.code = code;
    throw err;
  };
  return {
    ...actual,
    default: actual,
    openSync: ((...args: Parameters<typeof actual.openSync>) => {
      failIfInjected("openSync", args[0]);
      return actual.openSync(...args);
    }) as typeof actual.openSync,
    readdirSync: ((...args: Parameters<typeof actual.readdirSync>) => {
      failIfInjected("readdirSync", args[0]);
      return actual.readdirSync(...args);
    }) as typeof actual.readdirSync,
    rmSync: ((...args: Parameters<typeof actual.rmSync>) => {
      failIfInjected("rmSync", args[0]);
      return actual.rmSync(...args);
    }) as typeof actual.rmSync,
  };
});

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  EventLog,
  SCHEMA_VERSION,
  acquireLock,
  atomicWriteJson,
  pruneSessionDirs,
  scanRecoverableSessions,
} from "../src/persistence/index.js";
import { getDirSize } from "../src/persistence/retention.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "codex-mcp-persistence-"));
});

afterEach(() => {
  fsFaults.clear();
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("atomicWriteJson", () => {
  it("creates missing parent directories and writes pretty JSON with a trailing newline", () => {
    const target = join(root, "deep", "nested", "meta.json");
    atomicWriteJson(target, { a: 1, b: ["x"] });

    const raw = readFileSync(target, "utf-8");
    expect(raw).toBe('{\n  "a": 1,\n  "b": [\n    "x"\n  ]\n}\n');
    expect(JSON.parse(raw)).toEqual({ a: 1, b: ["x"] });
  });

  it("replaces the previous content and leaves no temp file behind", () => {
    const target = join(root, "meta.json");
    atomicWriteJson(target, { v: 1 });
    atomicWriteJson(target, { v: 2 });

    expect(JSON.parse(readFileSync(target, "utf-8"))).toEqual({ v: 2 });
    expect(readdirSync(root)).toEqual(["meta.json"]);
  });

  it("removes the temp file and rethrows when serialization fails", () => {
    const target = join(root, "circular.json");
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() => atomicWriteJson(target, circular)).toThrow(TypeError);
    expect(existsSync(target)).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });
});

describe("EventLog", () => {
  it("numbers events from zero and flushes critical events immediately", () => {
    const filePath = join(root, "logs", "events.jsonl");
    const log = new EventLog({ filePath });

    expect(log.append({ type: "output" }, "critical")).toBe(0);
    expect(readFileSync(filePath, "utf-8")).toBe('{"seq":0,"type":"output"}\n');

    expect(log.append({ type: "result" }, "critical")).toBe(1);
    expect(readFileSync(filePath, "utf-8").trim().split("\n")).toHaveLength(2);

    log.destroy();
  });

  it("batches normal events until the interval elapses", async () => {
    const filePath = join(root, "events.jsonl");
    const log = new EventLog({ filePath, batchIntervalMs: 10 });

    log.append({ type: "progress", n: 1 });
    log.append({ type: "progress", n: 2 });
    expect(existsSync(filePath)).toBe(false);

    await sleep(80);

    const lines = readFileSync(filePath, "utf-8").trim().split("\n");
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { seq: 0, type: "progress", n: 1 },
      { seq: 1, type: "progress", n: 2 },
    ]);

    log.destroy();
  });

  it("flushes buffered normal events when a critical event arrives", () => {
    const filePath = join(root, "events.jsonl");
    const log = new EventLog({ filePath, batchIntervalMs: 10_000 });

    log.append({ type: "progress" });
    expect(existsSync(filePath)).toBe(false);
    log.append({ type: "error" }, "critical");

    expect(readFileSync(filePath, "utf-8").trim().split("\n")).toHaveLength(2);
    log.destroy();
  });

  it("continues numbering from the sequence set during recovery", () => {
    const filePath = join(root, "events.jsonl");
    const log = new EventLog({ filePath });

    log.setNextSeq(42);
    expect(log.append({ type: "output" }, "critical")).toBe(42);
    expect(log.append({ type: "output" }, "critical")).toBe(43);
    expect(readFileSync(filePath, "utf-8")).toContain('"seq":42');

    log.destroy();
  });

  it("flushes on destroy and refuses further appends", () => {
    const filePath = join(root, "events.jsonl");
    const log = new EventLog({ filePath, batchIntervalMs: 10_000 });

    log.append({ type: "progress" });
    log.destroy();
    expect(readFileSync(filePath, "utf-8")).toBe('{"seq":0,"type":"progress"}\n');

    expect(log.append({ type: "progress" }, "critical")).toBe(-1);
    expect(readFileSync(filePath, "utf-8").trim().split("\n")).toHaveLength(1);

    log.destroy();
  });

  it("writes nothing when flushSync runs with an empty buffer", () => {
    const filePath = join(root, "events.jsonl");
    const log = new EventLog({ filePath, batchIntervalMs: 10 });

    log.flushSync();
    expect(existsSync(filePath)).toBe(false);

    log.destroy();
    expect(existsSync(filePath)).toBe(false);
  });

  it("cancels the pending batch timer on destroy", async () => {
    const filePath = join(root, "events.jsonl");
    const log = new EventLog({ filePath, batchIntervalMs: 10 });

    log.append({ type: "progress" });
    log.destroy();
    await sleep(60);

    expect(readFileSync(filePath, "utf-8")).toBe('{"seq":0,"type":"progress"}\n');
  });

  it("reports a failed flush on stderr instead of throwing", () => {
    const dirAsFile = join(root, "blocked");
    mkdirSync(dirAsFile, { recursive: true });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const log = new EventLog({ filePath: join(dirAsFile, "events.jsonl") });
    mkdirSync(join(dirAsFile, "events.jsonl"));

    expect(() => log.append({ type: "output" }, "critical")).not.toThrow();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[event-log] Failed to flush to"),
      expect.anything()
    );

    log.destroy();
  });
});

describe("acquireLock", () => {
  it("writes the current pid and removes the file on release", () => {
    const lockPath = join(root, "state", ".lock");
    const release = acquireLock(lockPath);

    const content = JSON.parse(readFileSync(lockPath, "utf-8"));
    expect(content.pid).toBe(process.pid);
    expect(Number.isNaN(Date.parse(content.startedAt))).toBe(false);

    release();
    expect(existsSync(lockPath)).toBe(false);
    release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it("refuses a lock held by another live process", () => {
    const lockPath = join(root, ".lock");
    writeFileSync(lockPath, JSON.stringify({ pid: 555, startedAt: "2024-01-01T00:00:00.000Z" }));
    vi.spyOn(process, "kill").mockImplementation(() => true);

    expect(() => acquireLock(lockPath)).toThrow(/STATE_DIR is locked by another process \(pid=555/);
    expect(existsSync(lockPath)).toBe(true);
  });

  it("reclaims a lock left by a dead process", () => {
    const lockPath = join(root, ".lock");
    writeFileSync(lockPath, JSON.stringify({ pid: 424242, startedAt: "2024-01-01T00:00:00.000Z" }));
    vi.spyOn(process, "kill").mockImplementation((pid) => {
      if (pid === 424242) throw new Error("ESRCH");
      return true;
    });

    const release = acquireLock(lockPath);
    expect(JSON.parse(readFileSync(lockPath, "utf-8")).pid).toBe(process.pid);
    release();
  });

  it("reclaims its own stale lock", () => {
    const lockPath = join(root, ".lock");
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, startedAt: "2024-01-01T00:00:00.000Z" })
    );

    const release = acquireLock(lockPath);
    expect(JSON.parse(readFileSync(lockPath, "utf-8")).startedAt).not.toBe(
      "2024-01-01T00:00:00.000Z"
    );
    release();
  });

  it("rethrows a create failure that is not a lost race", () => {
    const lockPath = join(root, "readonly", ".lock");
    failFs("openSync", lockPath, "EACCES");

    expect(() => acquireLock(lockPath)).toThrow(/EACCES/);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("keeps an unreadable lockfile and fails the O_EXCL create", () => {
    const lockPath = join(root, ".lock");
    writeFileSync(lockPath, "{not json");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => acquireLock(lockPath)).toThrow(/race with another process/);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("is unreadable"));
    expect(readFileSync(lockPath, "utf-8")).toBe("{not json");
  });
});

describe("scanRecoverableSessions", () => {
  function writeSession(
    id: string,
    files: { meta?: unknown; events?: string; result?: unknown; pid?: unknown }
  ): string {
    const dir = join(root, "sessions", id);
    mkdirSync(dir, { recursive: true });
    if (files.meta !== undefined) writeFileSync(join(dir, "meta.json"), JSON.stringify(files.meta));
    if (files.events !== undefined) writeFileSync(join(dir, "events.jsonl"), files.events);
    if (files.result !== undefined)
      writeFileSync(join(dir, "result.json"), JSON.stringify(files.result));
    if (files.pid !== undefined) writeFileSync(join(dir, "pid.json"), JSON.stringify(files.pid));
    return dir;
  }

  it("returns nothing for a missing sessions directory", () => {
    expect(scanRecoverableSessions(join(root, "absent"))).toEqual([]);
  });

  it("recovers metadata, events, result and pid info", () => {
    const dir = writeSession("sess_a", {
      meta: {
        schemaVersion: SCHEMA_VERSION,
        sessionId: "sess_a",
        status: "running",
        createdAt: "2024-01-01T00:00:00.000Z",
        lastActiveAt: "2024-01-02T00:00:00.000Z",
        threadId: "thread_a",
      },
      events: '{"seq":1,"type":"b"}\n{"seq":0,"type":"a"}\n',
      result: { ok: true },
      pid: { pid: 77, spawnedAt: "2024-01-01T00:00:00.000Z" },
    });

    const [recovered, ...rest] = scanRecoverableSessions(join(root, "sessions"));
    expect(rest).toEqual([]);
    expect(recovered!.sessionId).toBe("sess_a");
    expect(recovered!.sessionDir).toBe(dir);
    expect(recovered!.meta.threadId).toBe("thread_a");
    expect(recovered!.events).toEqual([
      { seq: 0, type: "a" },
      { seq: 1, type: "b" },
    ]);
    expect(recovered!.lastSeq).toBe(1);
    expect(recovered!.result).toEqual({ ok: true });
    expect(recovered!.pidInfo).toEqual({ pid: 77, spawnedAt: "2024-01-01T00:00:00.000Z" });
  });

  it("drops the torn tail of events.jsonl without reporting damage", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    writeSession("sess_torn", {
      meta: { sessionId: "sess_torn", status: "running" },
      events: '{"seq":0}\n{"seq":1}\n{"seq":2,"partia',
    });

    const [recovered] = scanRecoverableSessions(join(root, "sessions"));
    expect(recovered!.events.map((e) => e.seq)).toEqual([0, 1]);
    expect(recovered!.lastSeq).toBe(1);
    expect(recovered!.corruptEventLines).toBe(0);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("keeps the events after a corrupt line in the middle and reports it", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    writeSession("sess_corrupt", {
      meta: { sessionId: "sess_corrupt", status: "running" },
      events: '{"seq":0}\n{"seq":1,"cut\n{"seq":2}\n{"seq":3}\n',
    });

    const [recovered] = scanRecoverableSessions(join(root, "sessions"));
    expect(recovered!.events.map((e) => e.seq)).toEqual([0, 2, 3]);
    expect(recovered!.lastSeq).toBe(3);
    expect(recovered!.corruptEventLines).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(
      "[recovery] Session sess_corrupt: skipped 1 corrupt line(s) in events.jsonl"
    );
  });

  it("counts only the corrupt middle lines when the tail is torn as well", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    writeSession("sess_both", {
      meta: { sessionId: "sess_both", status: "running" },
      events: '{"seq":0}\nnot json\n{"seq":1}\n{"seq":2,"tor',
    });

    const [recovered] = scanRecoverableSessions(join(root, "sessions"));
    expect(recovered!.events.map((e) => e.seq)).toEqual([0, 1]);
    expect(recovered!.corruptEventLines).toBe(1);
  });

  it("ignores lines without a numeric seq and reports -1 when nothing survives", () => {
    writeSession("sess_noseq", {
      meta: { sessionId: "sess_noseq", status: "idle" },
      events: '{"type":"output"}\n\n',
    });

    const [recovered] = scanRecoverableSessions(join(root, "sessions"));
    expect(recovered!.events).toEqual([]);
    expect(recovered!.lastSeq).toBe(-1);
  });

  it("keeps only the tail when the event count exceeds maxEvents", () => {
    const events = Array.from({ length: 10 }, (_, i) => JSON.stringify({ seq: i })).join("\n");
    writeSession("sess_many", {
      meta: { sessionId: "sess_many", status: "idle" },
      events: events + "\n",
    });

    const [recovered] = scanRecoverableSessions(join(root, "sessions"), 3);
    expect(recovered!.events.map((e) => e.seq)).toEqual([7, 8, 9]);
    expect(recovered!.lastSeq).toBe(9);
  });

  it("skips entries without usable metadata, plain files, and unreadable json", () => {
    mkdirSync(join(root, "sessions"), { recursive: true });
    writeFileSync(join(root, "sessions", "stray.txt"), "not a session");
    writeSession("sess_no_meta", { events: '{"seq":0}\n' });
    writeSession("sess_bad_meta", { meta: undefined });
    writeFileSync(join(root, "sessions", "sess_bad_meta", "meta.json"), "{oops");
    writeSession("sess_no_id", { meta: { status: "idle" } });

    expect(scanRecoverableSessions(join(root, "sessions"))).toEqual([]);
  });

  it("skips an entry whose stat fails", () => {
    mkdirSync(join(root, "sessions"), { recursive: true });
    symlinkSync(join(root, "nowhere"), join(root, "sessions", "dangling"));

    expect(scanRecoverableSessions(join(root, "sessions"))).toEqual([]);
  });

  it("returns nothing when the sessions directory cannot be listed", () => {
    const sessions = join(root, "sessions");
    writeSession("sess_listed", {
      meta: {
        schemaVersion: SCHEMA_VERSION,
        sessionId: "sess_listed",
        status: "running",
        createdAt: "2024-01-01T00:00:00.000Z",
        lastActiveAt: "2024-01-02T00:00:00.000Z",
      },
    });
    failFs("readdirSync", sessions);

    expect(scanRecoverableSessions(sessions)).toEqual([]);
  });

  it("skips a session written by a newer schema", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    writeSession("sess_future", {
      meta: { schemaVersion: SCHEMA_VERSION + 1, sessionId: "sess_future", status: "idle" },
    });

    expect(scanRecoverableSessions(join(root, "sessions"))).toEqual([]);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(`schema version ${SCHEMA_VERSION + 1} > ${SCHEMA_VERSION}`)
    );
  });

  it("returns null result and pid info when those files are absent or corrupt", () => {
    writeSession("sess_min", { meta: { sessionId: "sess_min", status: "idle" } });
    writeFileSync(join(root, "sessions", "sess_min", "result.json"), "{broken");

    const [recovered] = scanRecoverableSessions(join(root, "sessions"));
    expect(recovered!.result).toBeNull();
    expect(recovered!.pidInfo).toBeNull();
    expect(recovered!.events).toEqual([]);
  });
});

describe("pruneSessionDirs", () => {
  function makeSession(id: string, lastActiveAt: string | null, bytes = 0): string {
    const dir = join(root, "sessions", id);
    mkdirSync(dir, { recursive: true });
    if (lastActiveAt !== null) {
      writeFileSync(join(dir, "meta.json"), JSON.stringify({ sessionId: id, lastActiveAt }));
    }
    if (bytes > 0) writeFileSync(join(dir, "events.jsonl"), "x".repeat(bytes));
    return dir;
  }

  const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

  it("returns zero for a missing directory", () => {
    expect(pruneSessionDirs(join(root, "absent"))).toBe(0);
  });

  it("removes sessions older than maxAgeMs", () => {
    const old = makeSession("old", iso(60_000));
    const fresh = makeSession("fresh", iso(1_000));

    expect(pruneSessionDirs(join(root, "sessions"), { maxAgeMs: 10_000 })).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it("removes the oldest sessions above maxCount", () => {
    const a = makeSession("a", iso(3_000));
    const b = makeSession("b", iso(2_000));
    const c = makeSession("c", iso(1_000));

    expect(pruneSessionDirs(join(root, "sessions"), { maxCount: 2, maxAgeMs: 60_000 })).toBe(1);
    expect(existsSync(a)).toBe(false);
    expect(existsSync(b)).toBe(true);
    expect(existsSync(c)).toBe(true);
  });

  it("removes the oldest sessions until the total size fits maxDiskBytes", () => {
    const a = makeSession("a", iso(3_000), 1_000);
    const b = makeSession("b", iso(2_000), 100);
    const c = makeSession("c", iso(1_000), 100);

    expect(
      pruneSessionDirs(join(root, "sessions"), {
        maxAgeMs: 60_000,
        maxCount: 100,
        maxDiskBytes: 1_000,
      })
    ).toBe(1);
    expect(existsSync(a)).toBe(false);
    expect(existsSync(b)).toBe(true);
    expect(existsSync(c)).toBe(true);
  });

  it("counts files in nested subdirectories toward maxDiskBytes", () => {
    const a = makeSession("a", iso(3_000));
    mkdirSync(join(a, "artifacts", "deep"), { recursive: true });
    writeFileSync(join(a, "artifacts", "deep", "blob.bin"), "x".repeat(1_000));
    const b = makeSession("b", iso(1_000), 100);

    expect(
      pruneSessionDirs(join(root, "sessions"), {
        maxAgeMs: 60_000,
        maxCount: 100,
        maxDiskBytes: 1_000,
      })
    ).toBe(1);
    expect(existsSync(a)).toBe(false);
    expect(existsSync(b)).toBe(true);
  });

  it("falls back to the directory mtime when meta.json is unusable", () => {
    const stale = makeSession("stale", null);
    const old = new Date(Date.now() - 120_000);
    utimesSync(stale, old, old);
    const fresh = makeSession("fresh", iso(1_000));

    expect(pruneSessionDirs(join(root, "sessions"), { maxAgeMs: 60_000 })).toBe(1);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it("keeps everything within the policy and ignores plain files", () => {
    mkdirSync(join(root, "sessions"), { recursive: true });
    writeFileSync(join(root, "sessions", "note.txt"), "x");
    makeSession("a", iso(1_000), 10);

    expect(pruneSessionDirs(join(root, "sessions"))).toBe(0);
    expect(existsSync(join(root, "sessions", "note.txt"))).toBe(true);
    expect(existsSync(join(root, "sessions", "a"))).toBe(true);
  });

  it("skips an entry whose stat fails", () => {
    mkdirSync(join(root, "sessions"), { recursive: true });
    symlinkSync(join(root, "nowhere"), join(root, "sessions", "dangling"));

    expect(pruneSessionDirs(join(root, "sessions"), { maxAgeMs: 1 })).toBe(0);
  });

  it("reports a removal failure on stderr and does not count it", () => {
    const old = makeSession("old", iso(120_000));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    failFs("rmSync", old);

    expect(pruneSessionDirs(join(root, "sessions"), { maxAgeMs: 60_000 })).toBe(0);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(`[retention] Failed to remove ${old}`),
      expect.anything()
    );
    expect(existsSync(old)).toBe(true);
  });

  it("uses createdAt when lastActiveAt is absent", () => {
    const dir = join(root, "sessions", "created-only");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ createdAt: iso(120_000) }));

    expect(pruneSessionDirs(join(root, "sessions"), { maxAgeMs: 60_000 })).toBe(1);
    expect(existsSync(dir)).toBe(false);
  });
});

describe("getDirSize", () => {
  it("sums every file of the tree, at any depth", () => {
    const dir = join(root, "session");
    mkdirSync(join(dir, "sub", "deeper"), { recursive: true });
    writeFileSync(join(dir, "events.jsonl"), "x".repeat(10));
    writeFileSync(join(dir, "sub", "part.bin"), "x".repeat(100));
    writeFileSync(join(dir, "sub", "deeper", "blob.bin"), "x".repeat(1_000));

    expect(getDirSize(dir)).toBe(1_110);
  });

  it("counts nothing for a directory removed by a concurrent prune", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(getDirSize(join(root, "gone"))).toBe(0);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("counts nothing for a path that is not a directory", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const file = join(root, "meta.json");
    writeFileSync(file, "{}");

    expect(getDirSize(join(file, "inside"))).toBe(0);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("reports an unreadable subdirectory on stderr and keeps counting the rest", () => {
    const dir = join(root, "session");
    const locked = join(dir, "locked");
    mkdirSync(locked, { recursive: true });
    writeFileSync(join(locked, "blob.bin"), "x".repeat(500));
    writeFileSync(join(dir, "events.jsonl"), "x".repeat(42));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    failFs("readdirSync", locked);

    expect(getDirSize(dir)).toBe(42);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(`[retention] Failed to size ${locked}`),
      expect.anything()
    );
  });

  it("leaves symlinked entries uncounted", () => {
    const dir = join(root, "session");
    mkdirSync(dir, { recursive: true });
    const target = join(root, "outside.bin");
    writeFileSync(target, "x".repeat(700));
    symlinkSync(target, join(dir, "link.bin"));
    symlinkSync(join(root, "nowhere"), join(dir, "dangling"));

    expect(getDirSize(dir)).toBe(0);
  });
});
