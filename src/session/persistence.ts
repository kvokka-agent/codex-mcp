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
  command?: string;
}

// ── Critical event types that require immediate flush ────────────────

const CRITICAL_EVENT_TYPES = new Set<SessionEventType>([
  "approval_request",
  "approval_result",
  "result",
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

  /** Persist PID info for orphan detection. */
  writePidInfo(sessionId: string, pid: number, command?: string): void {
    const info: PidInfo = {
      pid,
      spawnedAt: new Date().toISOString(),
      command,
    };
    const dir = join(this.sessionsDir, sessionId);
    mkdirSync(dir, { recursive: true });
    atomicWriteJson(join(dir, "pid.json"), info);
  }

  /** Append an event to the session's event log. */
  appendEvent(sessionId: string, type: SessionEventType, data: unknown): void {
    let log = this.eventLogs.get(sessionId);
    if (!log) {
      const dir = join(this.sessionsDir, sessionId);
      mkdirSync(dir, { recursive: true });
      log = new EventLog({ filePath: join(dir, "events.jsonl") });
      this.eventLogs.set(sessionId, log);
    }
    log.append({ type, data, timestamp: new Date().toISOString() }, eventCriticality(type));
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
  recoverSessions(maxEvents?: number): RecoveredSession[] {
    return scanRecoverableSessions(this.sessionsDir, maxEvents);
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
