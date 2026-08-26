/**
 * Recovery scanner — scans STATE_DIR/sessions/ on startup to recover persisted sessions.
 *
 * - Reads meta.json for session metadata
 * - Reads events.jsonl for the sequence number to continue from, and detects torn tails
 * - Reads result.json if present
 * - Returns recovered sessions for the SessionManager to ingest
 */
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

import { isMissing } from "./fs-errors.js";
import { ownerState, readOwner, type OwnerState } from "./session-owner.js";

/**
 * The version of the session directory format. Version 2 records the whole set
 * of thread parameters a resume needs and the owner of the session.
 */
export const SCHEMA_VERSION = 2;

export interface RecoveredSessionMeta {
  schemaVersion: number;
  sessionId: string;
  status: string;
  createdAt: string;
  lastActiveAt: string;
  cancelledAt?: string;
  cancelledReason?: string;
  /** codex-mcp specific */
  threadId?: string;
  model?: string;
  cwd?: string;
  /** Arbitrary extra fields from the MCP-specific adapter */
  [key: string]: unknown;
}

export interface RecoveredPidInfo {
  pid: number;
  spawnedAt: string;
  command?: string;
}

export interface RecoveredSession {
  sessionId: string;
  meta: RecoveredSessionMeta;
  /** Corrupt lines skipped in the middle of events.jsonl — a torn tail is not counted */
  corruptEventLines?: number;
  /**
   * Set when meta.json was there and unusable, so `meta` carries what the directory
   * itself says rather than what the session wrote.
   */
  metaDamaged?: true;
  /** Highest sequence number written to events.jsonl, or -1 for an empty log */
  lastSeq: number;
  /** Result from result.json if present */
  result: unknown | null;
  /** PID info from pid.json if present */
  pidInfo: RecoveredPidInfo | null;
  /** Who holds the session: another running server, a dead owner, or nobody. */
  owner: OwnerState;
  /** The last line the session reported as its activity, or undefined for none. */
  lastActivity?: string;
  /** Path to the session directory */
  sessionDir: string;
}

interface EventLogScan {
  /** Highest seq of a readable line, or -1 when the log holds none. */
  lastSeq: number;
  /** Unparsable lines before the last one; the torn tail is excluded */
  corruptLines: number;
  /** The activity the last `activity` record of the log names. */
  lastActivity?: string;
}

/**
 * Read events.jsonl for the sequence number the next run continues from.
 *
 * The events themselves are not carried back: nothing in a recovered session is
 * built from them, and the turn they describe is in the Codex rollout log.
 *
 * The last `activity` record does come back: it is the one line saying what the session
 * was doing when it was cut off, and a caller looking for an abandoned session reads it
 * instead of a session id alone.
 *
 * A cut power tears the last line only, so an unparsable final line is dropped without
 * a word. An unparsable line anywhere before it is lost data: the line is skipped and
 * the number skipped goes to the caller.
 */
function scanEventsJsonl(filePath: string): EventLogScan {
  if (!existsSync(filePath)) return { lastSeq: -1, corruptLines: 0 };
  const raw = readFileSync(filePath, "utf-8");
  const lines = raw.split("\n");
  let lastSeq = -1;
  let corruptLines = 0;
  let lastActivity: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed.seq === "number" && parsed.seq > lastSeq) lastSeq = parsed.seq;
      if (parsed.type === "activity" && typeof parsed.data?.activity === "string") {
        lastActivity = parsed.data.activity;
      }
    } catch {
      // The last element of the split holds text written after the final newline:
      // an unparsable one is the torn tail of an interrupted write.
      if (i < lines.length - 1) corruptLines++;
    }
  }
  return { lastSeq, corruptLines, lastActivity };
}

/** What one JSON file of a session directory turned out to be. */
type JsonRead<T> =
  | { state: "absent" }
  /** The file is there and its content is not JSON — a write torn by a cut power. */
  | { state: "damaged" }
  | { state: "ok"; value: T };

/**
 * Read one JSON file of a session directory.
 *
 * A file that is not there, and one a concurrent prune removed, hold nothing. A file that
 * is there and cannot be read is neither: it throws, so the caller of the scan decides,
 * instead of the session being recovered as if the file had never been written.
 */
function readJson<T>(filePath: string): JsonRead<T> {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (err) {
    if (isMissing(err)) return { state: "absent" };
    throw err;
  }
  try {
    return { state: "ok", value: JSON.parse(raw) as T };
  } catch {
    return { state: "damaged" };
  }
}

/** result.json and pid.json say nothing about the session when they are absent or torn. */
function readJsonSafe<T>(filePath: string): T | null {
  const read = readJson<T>(filePath);
  return read.state === "ok" ? read.value : null;
}

/**
 * The metadata of a session whose meta.json is there and unusable, built from what the
 * directory itself says: the name it was written under, and its own mtime.
 *
 * `status` states the ignorance rather than guessing a session state — the SessionManager
 * turns a status it does not know into `error`, which is what an unrestorable session is.
 */
function metaFromDirectory(sessionId: string, mtimeMs: number): RecoveredSessionMeta {
  const at = new Date(mtimeMs).toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    sessionId,
    status: "unknown",
    createdAt: at,
    lastActiveAt: at,
    cancelledReason: "meta.json on disk is unusable",
  };
}

/**
 * Scan `sessionsDir` for persisted sessions and return recovered metadata.
 *
 * A directory that is not there holds no sessions. A directory that is there and cannot
 * be listed throws: an empty result would hand the caller a state directory that reads
 * as freshly created, and the sessions it holds would be written over.
 *
 * @param sessionsDir - Path to STATE_DIR/sessions/
 */
export function scanRecoverableSessions(sessionsDir: string): RecoveredSession[] {
  // throwIfNoEntry: false — a state directory the previous run never created holds no
  // sessions. existsSync cannot stand here: it answers false for a directory it may not
  // stat, which is the very case that must not read as "no sessions".
  if (!statSync(sessionsDir, { throwIfNoEntry: false })) return [];

  const results: RecoveredSession[] = [];
  const entries = readdirSync(sessionsDir);

  for (const entry of entries) {
    const sessionDir = join(sessionsDir, entry);
    // throwIfNoEntry: false — an entry removed between the listing and this call, and a
    // dangling symlink, are both nothing to recover. Any other stat failure throws.
    const stat = statSync(sessionDir, { throwIfNoEntry: false });
    if (!stat?.isDirectory()) continue;

    const metaRead = readJson<RecoveredSessionMeta>(join(sessionDir, "meta.json"));
    // A directory with no meta.json is a session that wrote none: nothing to recover.
    if (metaRead.state === "absent") continue;

    const stored = metaRead.state === "ok" && metaRead.value.sessionId ? metaRead.value : null;
    if (!stored) {
      // Dropping the directory would take its pid.json with it, and the orphan reaper
      // would leave that session's codex process running for good.
      console.error(
        `[recovery] Session ${entry}: meta.json is unusable — recovering the directory` +
          ` without it, so its pid.json is still read`
      );
    } else if (stored.schemaVersion !== undefined && stored.schemaVersion > SCHEMA_VERSION) {
      console.error(
        `[recovery] Skipping session ${stored.sessionId}: schema version ${stored.schemaVersion} > ${SCHEMA_VERSION}`
      );
      continue;
    }

    const meta = stored ?? metaFromDirectory(entry, stat.mtimeMs);

    const eventLog = scanEventsJsonl(join(sessionDir, "events.jsonl"));
    if (eventLog.corruptLines > 0) {
      console.error(
        `[recovery] Session ${meta.sessionId}: skipped ${eventLog.corruptLines} corrupt line(s) in events.jsonl`
      );
    }

    const result = readJsonSafe<unknown>(join(sessionDir, "result.json"));
    const pidInfo = readJsonSafe<RecoveredPidInfo>(join(sessionDir, "pid.json"));

    results.push({
      sessionId: meta.sessionId,
      meta,
      corruptEventLines: eventLog.corruptLines,
      ...(stored ? {} : { metaDamaged: true as const }),
      lastSeq: eventLog.lastSeq,
      result,
      pidInfo,
      owner: ownerState(readOwner(sessionDir)),
      ...(eventLog.lastActivity ? { lastActivity: eventLog.lastActivity } : {}),
      sessionDir,
    });
  }

  return results;
}
