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
  claimSession,
  releaseSession,
  EventLog,
  type EventCriticality,
  scanRecoverableSessions,
  pruneSessionDirs,
  SCHEMA_VERSION,
  type RecoveredSession,
  type RetentionPolicy,
} from "../persistence/index.js";

import type {
  ApprovalPolicy,
  EffortLevel,
  Personality,
  SandboxMode,
  SessionInfo,
  SessionEventType,
  SummaryMode,
} from "../types.js";

// ── Types ────────────────────────────────────────────────────────────

/**
 * What meta.json records.
 *
 * Everything a resumed session needs is here: what `thread/resume` takes, so a
 * session picked up by another server starts its thread with the parameters it
 * was created with, and what `turn/start` takes per turn — `effort` and
 * `summary` are not thread state, so a turn that omits them silently falls back
 * to `~/.codex/config.toml` instead of the values the session was started with.
 */
interface PersistedSessionMeta {
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
  approvalPolicy?: ApprovalPolicy;
  sandbox?: SandboxMode;
  profile?: string;
  personality?: Personality;
  effort?: EffortLevel;
  summary?: SummaryMode;
  config?: Record<string, unknown>;
  baseInstructions?: string;
  developerInstructions?: string;
  approvalTimeoutMs?: number;
}

interface PidInfo {
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
  /** Sessions this process claimed, so shutdown gives every one of them back. */
  private owned = new Set<string>();
  private eventLogs = new Map<string, EventLog>();

  constructor(stateDir?: string) {
    this.stateDir =
      stateDir ?? process.env.CODEX_MCP_STATE_DIR ?? join(homedir(), ".codex-mcp", "state");
    this.sessionsDir = join(this.stateDir, "sessions");
    mkdirSync(this.sessionsDir, { recursive: true });
  }

  /** The directory of one session, whether or not it exists yet. */
  sessionDir(sessionId: string): string {
    return join(this.sessionsDir, sessionId);
  }

  /** Record this process as the owner of a session it drives. */
  claim(sessionId: string): void {
    const dir = this.sessionDir(sessionId);
    mkdirSync(dir, { recursive: true });
    claimSession(dir);
    this.owned.add(sessionId);
  }

  /** Give up the claim on one session. */
  release(sessionId: string): void {
    this.owned.delete(sessionId);
    releaseSession(this.sessionDir(sessionId));
  }

  /** The sessions this process holds a claim on. */
  ownedSessions(): string[] {
    return Array.from(this.owned);
  }

  /** Give up every claim this process holds. */
  releaseAll(): void {
    for (const sessionId of Array.from(this.owned)) this.release(sessionId);
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
      personality: session.personality,
      effort: session.effort,
      summary: session.summary,
      config: session.config,
      baseInstructions: session.baseInstructions,
      developerInstructions: session.developerInstructions,
      approvalTimeoutMs: session.approvalTimeoutMs,
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
    this.eventLogFor(sessionId).append({ type, data, timestamp }, eventCriticality(type));
  }

  /** Set the next sequence number for a recovered session's event log. */
  setEventLogNextSeq(sessionId: string, seq: number): void {
    this.eventLogFor(sessionId).setNextSeq(seq);
  }

  /** The session's event log, with its directory, created on first use. */
  private eventLogFor(sessionId: string): EventLog {
    let log = this.eventLogs.get(sessionId);
    if (!log) {
      const dir = join(this.sessionsDir, sessionId);
      mkdirSync(dir, { recursive: true });
      log = new EventLog({ filePath: join(dir, "events.jsonl") });
      this.eventLogs.set(sessionId, log);
    }
    return log;
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
    this.owned.delete(sessionId);
    rmSync(join(this.sessionsDir, sessionId), { recursive: true, force: true });
  }

  /** Clean up: flush all logs, give up every claim. */
  destroy(): void {
    for (const log of this.eventLogs.values()) {
      log.destroy();
    }
    this.eventLogs.clear();
    this.releaseAll();
  }

  /** Check if a session directory exists on disk. */
  hasSessionOnDisk(sessionId: string): boolean {
    return existsSync(join(this.sessionsDir, sessionId, "meta.json"));
  }
}

// ── Startup ──────────────────────────────────────────────────────────

export interface DiskPersistenceStartup {
  /** The adapter to use, or undefined when the state directory is unusable. */
  persistence?: SessionPersistence;
  recovered: RecoveredSession[];
  pruned: number;
}

/**
 * Open the state directory and read back what is in it.
 *
 * Every server that shares the directory does this: the sessions of the others are read
 * along with its own, and what each may act on is decided per session by its owner.json.
 *
 * Serving MCP requests needs no disk state, so every step is best-effort: a failure is
 * reported on stderr and hands back a server that runs in memory only.
 */
export function startDiskPersistence(stateDir?: string): DiskPersistenceStartup {
  let persistence: SessionPersistence | undefined;
  try {
    persistence = new SessionPersistence(stateDir);
    // Prune first: a directory retention deletes must not come back in `recovered`,
    // where SessionManager would list it and write the session back to disk.
    const pruned = persistence.prune();
    return { persistence, recovered: persistence.recoverSessions(), pruned };
  } catch (err) {
    console.error(
      "[codex-mcp] WARNING: STATE_DIR unusable — running without disk persistence:",
      err
    );
    persistence?.destroy();
    return { recovered: [], pruned: 0 };
  }
}
