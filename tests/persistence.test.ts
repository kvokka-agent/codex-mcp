import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Injected failures, keyed by `${call}\0${path}`, holding the errno code to raise. */
const { fsFaults } = vi.hoisted(() => ({ fsFaults: new Map<string, string>() }));

/**
 * Make one `node:fs` call fail for one path; every other call and path reaches the real
 * filesystem. A POSIX mode cannot stand in for this: Windows ignores the mode bits, so a
 * `chmod 0o500` directory stays writable and the error branch under test never runs there.
 */
function failFs(
  call: "openSync" | "readdirSync" | "readFileSync" | "rmSync" | "statSync",
  path: string,
  code = "EACCES"
): void {
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
    readFileSync: ((...args: Parameters<typeof actual.readFileSync>) => {
      failIfInjected("readFileSync", args[0]);
      return actual.readFileSync(...args);
    }) as typeof actual.readFileSync,
    rmSync: ((...args: Parameters<typeof actual.rmSync>) => {
      failIfInjected("rmSync", args[0]);
      return actual.rmSync(...args);
    }) as typeof actual.rmSync,
    statSync: ((...args: Parameters<typeof actual.statSync>) => {
      failIfInjected("statSync", args[0]);
      return actual.statSync(...args);
    }) as typeof actual.statSync,
  };
});

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  EventLog,
  SCHEMA_VERSION,
  atomicWriteJson,
  claimSession,
  describeOwner,
  ownStartedAt,
  ownerState,
  pruneSessionDirs,
  readOwner,
  releaseSession,
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

describe("session ownership", () => {
  /** Make `process.kill(pid, 0)` raise the errno a real kernel would. */
  function killFails(pid: number, code: string): void {
    vi.spyOn(process, "kill").mockImplementation(((target: number) => {
      if (target !== pid) return true;
      const err = new Error(`kill ${code}`) as NodeJS.ErrnoException;
      err.code = code;
      throw err;
    }) as typeof process.kill);
  }

  it("writes this process's pid and start time, and takes them back", () => {
    const dir = join(root, "sessions", "sess_owned");
    mkdirSync(dir, { recursive: true });
    claimSession(dir);

    const written = readOwner(dir)!;
    expect(written.pid).toBe(process.pid);
    // The claim dates the process, not the machine: a start time older than the
    // process is what os.uptime() would have written.
    const recordedMs = Date.parse(written.startedAt);
    expect(Date.now() - recordedMs).toBeLessThan(process.uptime() * 1000 + 2000);
    expect(ownerState(written)).toEqual({ kind: "self", owner: written });

    releaseSession(dir);
    expect(readOwner(dir)).toBeNull();
    releaseSession(dir);
    expect(readOwner(dir)).toBeNull();
  });

  it("reads a session with no owner file as held by nobody", () => {
    const dir = join(root, "sessions", "sess_free");
    mkdirSync(dir, { recursive: true });
    expect(ownerState(readOwner(dir))).toEqual({ kind: "unowned" });
  });

  it("reads an owner whose process is gone as gone", () => {
    killFails(424242, "ESRCH");
    const state = ownerState({ pid: 424242, startedAt: "2024-01-01T00:00:00.000Z" });
    expect(state.kind).toBe("gone");
  });

  it("reads a running owner of another user as held", () => {
    // EPERM is a running process this user may not signal — a state directory
    // shared across accounts is where it appears. Its start time is unreadable
    // from here, so the claim stands unproven and the session stays held.
    killFails(424243, "EPERM");
    const state = ownerState({ pid: 424243, startedAt: "2024-01-01T00:00:00.000Z" });
    expect(state).toEqual({
      kind: "held",
      owner: { pid: 424243, startedAt: "2024-01-01T00:00:00.000Z" },
      proven: false,
    });
  });

  it("reads an owner whose liveness no source establishes as held", () => {
    killFails(424244, "EINVAL");
    const state = ownerState({ pid: 424244, startedAt: "2024-01-01T00:00:00.000Z" });
    expect(state).toEqual({
      kind: "held",
      owner: { pid: 424244, startedAt: "2024-01-01T00:00:00.000Z" },
      proven: false,
    });
  });

  it("reads a live pid that started at another instant as gone", () => {
    // This process is alive under its own pid, and the recorded start time is
    // from 2024: the number was handed on, so the session is free.
    const state = ownerState({ pid: process.pid, startedAt: "2024-01-01T00:00:00.000Z" });
    expect(state).toEqual({
      kind: "gone",
      owner: { pid: process.pid, startedAt: "2024-01-01T00:00:00.000Z" },
    });
  });

  it("reads an owner file that carries no usable pid as no owner at all", () => {
    const dir = join(root, "sessions", "sess_torn");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "owner.json"), JSON.stringify({ startedAt: "2024-01-01T00:00:00Z" }));
    expect(readOwner(dir)).toBeNull();
    writeFileSync(join(dir, "owner.json"), "{not json");
    expect(readOwner(dir)).toBeNull();
  });

  it("names a proven live owner in the line a caller is shown", () => {
    const owner = { pid: process.pid, startedAt: ownStartedAt() };
    expect(describeOwner({ kind: "held", owner, proven: true })).toContain(
      `pid ${process.pid}, started `
    );
    expect(describeOwner({ kind: "gone", owner })).toBe(
      `left by pid ${process.pid}, which is gone`
    );
    expect(describeOwner({ kind: "unowned" })).toBe("held by no server");
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

  it("recovers metadata, the log's last seq, result and pid info", () => {
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
    // The events themselves stay on disk: nothing of a recovered session is built
    // from them, so only the seq to continue from comes back.
    expect(recovered).not.toHaveProperty("events");
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
    expect(recovered!.lastSeq).toBe(1);
    expect(recovered!.corruptEventLines).toBe(0);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("reads past a corrupt line in the middle and reports it", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    writeSession("sess_corrupt", {
      meta: { sessionId: "sess_corrupt", status: "running" },
      events: '{"seq":0}\n{"seq":1,"cut\n{"seq":2}\n{"seq":3}\n',
    });

    const [recovered] = scanRecoverableSessions(join(root, "sessions"));
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
    expect(recovered!.lastSeq).toBe(1);
    expect(recovered!.corruptEventLines).toBe(1);
  });

  it("ignores lines without a numeric seq and reports -1 when nothing survives", () => {
    writeSession("sess_noseq", {
      meta: { sessionId: "sess_noseq", status: "idle" },
      events: '{"type":"output"}\n\n',
    });

    const [recovered] = scanRecoverableSessions(join(root, "sessions"));
    expect(recovered!.lastSeq).toBe(-1);
  });

  it("skips plain files and directories that hold no meta.json", () => {
    mkdirSync(join(root, "sessions"), { recursive: true });
    writeFileSync(join(root, "sessions", "stray.txt"), "not a session");
    writeSession("sess_no_meta", { events: '{"seq":0}\n' });

    expect(scanRecoverableSessions(join(root, "sessions"))).toEqual([]);
  });

  it("recovers a session whose meta.json is unparsable, keeping its pid for the reaper", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const dir = writeSession("sess_bad_meta", {
      events: '{"seq":4}\n',
      pid: { pid: 4242, spawnedAt: "2024-01-01T00:00:00.000Z" },
    });
    writeFileSync(join(dir, "meta.json"), "{oops");

    const [recovered, ...rest] = scanRecoverableSessions(join(root, "sessions"));
    expect(rest).toEqual([]);
    // Dropping it would hide the live codex process behind pid.json from the reaper.
    expect(recovered!.pidInfo).toEqual({ pid: 4242, spawnedAt: "2024-01-01T00:00:00.000Z" });
    expect(recovered!.metaDamaged).toBe(true);
    // The id is the name the directory was written under, and the times are its own.
    expect(recovered!.sessionId).toBe("sess_bad_meta");
    expect(recovered!.meta.status).toBe("unknown");
    expect(recovered!.meta.createdAt).toBe(new Date(statSync(dir).mtimeMs).toISOString());
    expect(recovered!.lastSeq).toBe(4);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[recovery] Session sess_bad_meta: meta.json is unusable")
    );
  });

  it("recovers a session whose meta.json names no session", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    writeSession("sess_no_id", { meta: { status: "idle" }, pid: { pid: 77, spawnedAt: "x" } });

    const [recovered] = scanRecoverableSessions(join(root, "sessions"));
    expect(recovered!.sessionId).toBe("sess_no_id");
    expect(recovered!.metaDamaged).toBe(true);
    expect(recovered!.pidInfo).toEqual({ pid: 77, spawnedAt: "x" });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("meta.json is unusable"));
  });

  it("leaves a readable session unmarked", () => {
    writeSession("sess_fine", { meta: { sessionId: "sess_fine", status: "idle" } });

    const [recovered] = scanRecoverableSessions(join(root, "sessions"));
    expect(recovered!.metaDamaged).toBeUndefined();
  });

  it("skips an entry whose stat fails", () => {
    mkdirSync(join(root, "sessions"), { recursive: true });
    symlinkSync(join(root, "nowhere"), join(root, "sessions", "dangling"));

    expect(scanRecoverableSessions(join(root, "sessions"))).toEqual([]);
  });

  it("throws when an entry is there and cannot be examined", () => {
    const dir = writeSession("sess_locked_dir", {
      meta: { sessionId: "sess_locked_dir", status: "idle" },
    });
    failFs("statSync", dir);

    // Skipping it would leave a session on disk out of the recovered set, and the next
    // session to take that id would write over it.
    expect(() => scanRecoverableSessions(join(root, "sessions"))).toThrow(/EACCES/);
  });

  it("throws when the sessions directory cannot be examined", () => {
    const sessions = join(root, "sessions");
    writeSession("sess_unseen", { meta: { sessionId: "sess_unseen", status: "idle" } });
    failFs("statSync", sessions);

    expect(() => scanRecoverableSessions(sessions)).toThrow(/EACCES/);
  });

  it("throws when the sessions directory cannot be listed", () => {
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

    // An empty result would report the session on disk as absent, and the caller would
    // start over a state directory that still holds it.
    expect(() => scanRecoverableSessions(sessions)).toThrow(/EACCES/);
  });

  it("skips a session whose meta.json a concurrent prune removed mid-read", () => {
    writeSession("sess_racing", { meta: { sessionId: "sess_racing", status: "idle" } });
    failFs("readFileSync", join(root, "sessions", "sess_racing", "meta.json"), "ENOENT");

    expect(scanRecoverableSessions(join(root, "sessions"))).toEqual([]);
  });

  it("throws when a session's meta.json is there and cannot be read", () => {
    writeSession("sess_locked", { meta: { sessionId: "sess_locked", status: "idle" } });
    failFs("readFileSync", join(root, "sessions", "sess_locked", "meta.json"));

    expect(() => scanRecoverableSessions(join(root, "sessions"))).toThrow(/EACCES/);
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
    expect(recovered!.lastSeq).toBe(-1);
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

  it("throws when the sessions directory cannot be examined", () => {
    const sessions = join(root, "sessions");
    const old = makeSession("old", iso(120_000));
    failFs("statSync", sessions);

    expect(() => pruneSessionDirs(sessions, { maxAgeMs: 60_000 })).toThrow(/EACCES/);
    expect(existsSync(old)).toBe(true);
  });

  it("throws when the sessions directory cannot be listed", () => {
    const sessions = join(root, "sessions");
    makeSession("old", iso(120_000));
    failFs("readdirSync", sessions);

    // Zero would read as "retention ran and found nothing", while the sessions it could
    // not list keep every byte they hold.
    expect(() => pruneSessionDirs(sessions, { maxAgeMs: 60_000 })).toThrow(/EACCES/);
    expect(existsSync(join(sessions, "old"))).toBe(true);
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

  it("throws when an entry is there and cannot be examined", () => {
    const dir = makeSession("locked", iso(120_000));
    failFs("statSync", dir);

    expect(() => pruneSessionDirs(join(root, "sessions"), { maxAgeMs: 60_000 })).toThrow(/EACCES/);
    expect(existsSync(dir)).toBe(true);
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
