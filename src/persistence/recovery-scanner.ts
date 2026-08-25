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
  /** Highest sequence number found in events */
  lastSeq: number;
  /** Result from result.json if present */
  result: unknown | null;
  /** PID info from pid.json if present */
  pidInfo: RecoveredPidInfo | null;
  /** Path to the session directory */
  sessionDir: string;
}

/**
 * Parse events.jsonl, discarding any torn tail (incomplete last line).
 * Returns valid events sorted by seq.
 */
function parseEventsJsonl(filePath: string): Array<{ seq: number; [key: string]: unknown }> {
  if (!existsSync(filePath)) return [];
  const raw = readFileSync(filePath, "utf-8");
  const lines = raw.split("\n");
  const events: Array<{ seq: number; [key: string]: unknown }> = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed.seq === "number") {
        events.push(parsed);
      }
    } catch {
      // Torn tail or corrupt line — discard this and all subsequent lines
      break;
    }
  }
  return events.sort((a, b) => a.seq - b.seq);
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

    let events = parseEventsJsonl(join(sessionDir, "events.jsonl"));
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
      lastSeq,
      result,
      pidInfo,
      sessionDir,
    });
  }

  return results;
}
