/**
 * SessionPersistence — disk persistence adapter for codex-mcp sessions.
 *
 * Uses shared primitives (atomic writer, event log, recovery scanner, retention)
 * to persist session state across MCP server restarts.
 */
import { join } from "node:path";
import { mkdirSync, existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";

import {
  atomicWriteJson,
  acquireLock,
  EventLog,
  type EventCriticality,
  scanRecoverableSessions,
  pruneSessionDirs,
  SCHEMA_VERSION,
  type RecoveredSession,
  type RetentionPolicy,
} from "../persistence/index.js";

import type { SessionInfo, SessionEventType } from "../types.js";

// ── Types ────────────────────────────────────────────────────────────

export interface PersistedSessionMeta {
  schemaVersion: number;
  sessionId: string;
  status: string;
  createdAt: string;
  lastActiveAt: string;
  cancelledAt?: string;
  cancelledReason?: string;
  threadId?: string;
  model?: string;
  cwd?: string;
  approvalPolicy?: string;
  sandbox?: string;
  profile?: string;
}

export interface PidInfo {
  pid: number;
  spawnedAt: string;
  /** Command line the child was spawned with, when the client exposes it. */
  command?: string;
  /** Model the session runs with — identifies the process in logs, never used to match a PID. */
  model?: string;
}

/** Everything besides pid and spawn time that goes into pid.json. */
export interface PidDetails {
  command?: string;
  model?: string;
  /** The instant the client spawned the process, which the reaper matches against the OS start time. */
  spawnedAt?: string;
}

// ── Critical event types that require immediate flush ────────────────

const CRITICAL_EVENT_TYPES = new Set<SessionEventType>([
  "approval_request",
  "approval_result",
  "result",
  // An `activity` line is what somebody tailing events.jsonl is reading, so it
  // reaches the file when it happens rather than on the next batch.
  "activity",
  "error",
]);

function eventCriticality(type: SessionEventType): EventCriticality {
  return CRITICAL_EVENT_TYPES.has(type) ? "critical" : "normal";
}

// ── SessionPersistence ───────────────────────────────────────────────

export class SessionPersistence {
  private readonly stateDir: string;
  private readonly sessionsDir: string;
  private releaseLock: (() => void) | null = null;
  private eventLogs = new Map<string, EventLog>();

  constructor(stateDir?: string) {
    this.stateDir =
      stateDir ?? process.env.CODEX_MCP_STATE_DIR ?? join(homedir(), ".codex-mcp", "state");
    this.sessionsDir = join(this.stateDir, "sessions");
    mkdirSync(this.sessionsDir, { recursive: true });
  }

  /** Acquire the STATE_DIR lock. Call once at startup. */
  acquireLock(): void {
    this.releaseLock = acquireLock(join(this.stateDir, ".lock"));
  }

  /** Release the lock. Call on shutdown. */
  releaseLockIfHeld(): void {
    if (this.releaseLock) {
      this.releaseLock();
      this.releaseLock = null;
    }
  }

  // ── Write operations ────────────────────────────────────────────

  /** Persist session metadata (called on create and status changes). */
  writeSessionMeta(session: SessionInfo): void {
    const meta: PersistedSessionMeta = {
      schemaVersion: SCHEMA_VERSION,
      sessionId: session.sessionId,
      status: session.status,
      createdAt: session.createdAt,
      lastActiveAt: session.lastActiveAt,
      cancelledAt: session.cancelledAt,
      cancelledReason: session.cancelledReason,
      threadId: session.threadId,
      model: session.model,
      cwd: session.cwd,
      approvalPolicy: session.approvalPolicy,
      sandbox: session.sandbox,
      profile: session.profile,
    };
    const dir = join(this.sessionsDir, session.sessionId);
    atomicWriteJson(join(dir, "meta.json"), meta);
  }

  /**
   * Persist PID info for orphan detection.
   *
   * The orphan reaper matches a live PID against `spawnedAt` within five seconds, so the
   * caller passes the spawn instant: taking the clock here dates the record to the end of
   * the startup handshake instead. `command` and `model` only describe the process for a
   * reader of the file.
   */
  writePidInfo(sessionId: string, pid: number, details: PidDetails = {}): void {
    const info: PidInfo = {
      pid,
      spawnedAt: details.spawnedAt ?? new Date().toISOString(),
      command: details.command,
      model: details.model,
    };
    const dir = join(this.sessionsDir, sessionId);
    mkdirSync(dir, { recursive: true });
    atomicWriteJson(join(dir, "pid.json"), info);
  }

  /**
   * Append an event to the session's event log.
   *
   * The caller owns the clock: `timestamp` is the instant the manager handled the
   * event, so the log dates it by when it happened rather than when it was flushed.
   */
  appendEvent(sessionId: string, type: SessionEventType, data: unknown, timestamp: string): void {
    let log = this.eventLogs.get(sessionId);
    if (!log) {
      const dir = join(this.sessionsDir, sessionId);
      mkdirSync(dir, { recursive: true });
      log = new EventLog({ filePath: join(dir, "events.jsonl") });
      this.eventLogs.set(sessionId, log);
    }
    log.append({ type, data, timestamp }, eventCriticality(type));
  }

  /** Set the next sequence number for a recovered session's event log. */
  setEventLogNextSeq(sessionId: string, seq: number): void {
    let log = this.eventLogs.get(sessionId);
    if (!log) {
      const dir = join(this.sessionsDir, sessionId);
      mkdirSync(dir, { recursive: true });
      log = new EventLog({ filePath: join(dir, "events.jsonl") });
      this.eventLogs.set(sessionId, log);
    }
    log.setNextSeq(seq);
  }

  /** Persist the final result. */
  writeResult(sessionId: string, result: unknown): void {
    const dir = join(this.sessionsDir, sessionId);
    mkdirSync(dir, { recursive: true });
    atomicWriteJson(join(dir, "result.json"), result);
  }

  // ── Read / Recovery ─────────────────────────────────────────────

  /** Scan and recover sessions from disk. */
  recoverSessions(): RecoveredSession[] {
    return scanRecoverableSessions(this.sessionsDir);
  }

  /** Apply retention policy. Returns number of sessions pruned. */
  prune(policy?: RetentionPolicy): number {
    return pruneSessionDirs(this.sessionsDir, policy);
  }

  // ── Lifecycle ───────────────────────────────────────────────────

  /** Flush all event logs synchronously (call on shutdown). */
  flushAll(): void {
    for (const log of this.eventLogs.values()) {
      log.flushSync();
    }
  }

  /** Destroy a single session's event log. */
  destroySessionLog(sessionId: string): void {
    const log = this.eventLogs.get(sessionId);
    if (log) {
      log.destroy();
      this.eventLogs.delete(sessionId);
    }
  }

  /** Remove a persisted session directory from disk. */
  removeSession(sessionId: string): void {
    this.destroySessionLog(sessionId);
    rmSync(join(this.sessionsDir, sessionId), { recursive: true, force: true });
  }

  /** Clean up: flush all logs, release lock. */
  destroy(): void {
    for (const log of this.eventLogs.values()) {
      log.destroy();
    }
    this.eventLogs.clear();
    this.releaseLockIfHeld();
  }

  /** Check if a session directory exists on disk. */
  hasSessionOnDisk(sessionId: string): boolean {
    return existsSync(join(this.sessionsDir, sessionId, "meta.json"));
  }
}

// ── Startup ──────────────────────────────────────────────────────────

export interface DiskPersistenceStartup {
  /** The adapter to use, or undefined when another server owns STATE_DIR. */
  persistence?: SessionPersistence;
  recovered: RecoveredSession[];
  pruned: number;
}

/**
 * Take ownership of STATE_DIR and read back what the previous run left there.
 *
 * Serving MCP requests needs no disk state, so every step here is best-effort: creating
 * the state directory, taking the lock, pruning and scanning all run under one rollback
 * that reports the reason on stderr and hands back a server that runs in memory only.
 * Recovery, pruning and orphan reaping act on another server's live sessions when
 * STATE_DIR is shared, which is why losing the lock takes that same rollback.
 */
export function startDiskPersistence(stateDir?: string): DiskPersistenceStartup {
  let persistence: SessionPersistence | undefined;
  try {
    persistence = new SessionPersistence(stateDir);
    persistence.acquireLock();
    // Prune first: a directory retention deletes must not come back in `recovered`,
    // where SessionManager would list it and write the session back to disk.
    const pruned = persistence.prune();
    return { persistence, recovered: persistence.recoverSessions(), pruned };
  } catch (err) {
    console.error(
      "[codex-mcp] WARNING: STATE_DIR unusable — running without disk persistence:",
      err
    );
    // Releases the lock only when this process took it; another server's lock is left alone.
    persistence?.destroy();
    return { recovered: [], pruned: 0 };
  }
}
