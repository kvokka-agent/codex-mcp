/**
 * Recovery scanner — scans STATE_DIR/sessions/ on startup to recover persisted sessions.
 *
 * - Reads meta.json for session metadata
 * - Detects torn tails in events.jsonl (incomplete last line)
 * - Reads result.json if present
 * - Returns recovered sessions for the SessionManager to ingest
 */
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

export const SCHEMA_VERSION = 1;

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
  /** Parsed events from events.jsonl (valid lines only, torn tail discarded) */
  events: Array<{ seq: number; [key: string]: unknown }>;
  /** Corrupt lines skipped in the middle of events.jsonl — a torn tail is not counted */
  corruptEventLines?: number;
  /** Highest sequence number found in events */
  lastSeq: number;
  /** Result from result.json if present */
  result: unknown | null;
  /** PID info from pid.json if present */
  pidInfo: RecoveredPidInfo | null;
  /** Path to the session directory */
  sessionDir: string;
}

interface ParsedEventsJsonl {
  events: Array<{ seq: number; [key: string]: unknown }>;
  /** Unparsable lines before the last one; the torn tail is excluded */
  corruptLines: number;
}

/**
 * Parse events.jsonl into events sorted by seq.
 *
 * A cut power tears the last line only, so an unparsable final line is dropped without
 * a word. An unparsable line anywhere before it is lost data: the line is skipped, the
 * valid lines after it are kept, and the number skipped goes to the caller.
 */
function parseEventsJsonl(filePath: string): ParsedEventsJsonl {
  if (!existsSync(filePath)) return { events: [], corruptLines: 0 };
  const raw = readFileSync(filePath, "utf-8");
  const lines = raw.split("\n");
  const events: Array<{ seq: number; [key: string]: unknown }> = [];
  let corruptLines = 0;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed.seq === "number") {
        events.push(parsed);
      }
    } catch {
      // The last element of the split holds text written after the final newline:
      // an unparsable one is the torn tail of an interrupted write.
      if (i < lines.length - 1) corruptLines++;
    }
  }
  return { events: events.sort((a, b) => a.seq - b.seq), corruptLines };
}

function readJsonSafe<T>(filePath: string): T | null {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
}

/**
 * Scan `sessionsDir` for persisted sessions and return recovered metadata.
 *
 * @param sessionsDir - Path to STATE_DIR/sessions/
 * @param maxEvents - Max events to load per session (default: 500, from tail)
 */
export function scanRecoverableSessions(sessionsDir: string, maxEvents = 500): RecoveredSession[] {
  if (!existsSync(sessionsDir)) return [];

  const results: RecoveredSession[] = [];
  let entries: string[];
  try {
    entries = readdirSync(sessionsDir);
  } catch {
    return [];
  }

  for (const entry of entries) {
    const sessionDir = join(sessionsDir, entry);
    try {
      if (!statSync(sessionDir).isDirectory()) continue;
    } catch {
      continue;
    }

    const meta = readJsonSafe<RecoveredSessionMeta>(join(sessionDir, "meta.json"));
    if (!meta || !meta.sessionId) continue;

    // Schema version check
    if (meta.schemaVersion !== undefined && meta.schemaVersion > SCHEMA_VERSION) {
      console.error(
        `[recovery] Skipping session ${meta.sessionId}: schema version ${meta.schemaVersion} > ${SCHEMA_VERSION}`
      );
      continue;
    }

    const parsed = parseEventsJsonl(join(sessionDir, "events.jsonl"));
    if (parsed.corruptLines > 0) {
      console.error(
        `[recovery] Session ${meta.sessionId}: skipped ${parsed.corruptLines} corrupt line(s) in events.jsonl`
      );
    }
    let events = parsed.events;
    // Keep only the tail
    if (events.length > maxEvents) {
      events = events.slice(-maxEvents);
    }
    const lastSeq = events.length > 0 ? events[events.length - 1]!.seq : -1;

    const result = readJsonSafe<unknown>(join(sessionDir, "result.json"));
    const pidInfo = readJsonSafe<RecoveredPidInfo>(join(sessionDir, "pid.json"));

    results.push({
      sessionId: meta.sessionId,
      meta,
      events,
      corruptEventLines: parsed.corruptLines,
      lastSeq,
      result,
      pidInfo,
      sessionDir,
    });
  }

  return results;
}
