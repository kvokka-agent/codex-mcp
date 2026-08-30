/** The session index and what it writes to the state directory. */
import type { ICodexClient } from "../../app-server/client-interface.js";
import {
  describeOwner,
  ownerState,
  type RecoveredSession,
  readOwner,
} from "../../persistence/index.js";
import { ErrorCode, type SessionInfo, type SessionOwnership } from "../../types.js";
import type { PidDetails } from "../persistence.js";
import type { SessionRuntime } from "./core.js";
import { setEventSink } from "./events.js";
import { clearSessionPendingRequests } from "./pending-requests.js";
import { describeError, normalizeOptionalString } from "./read.js";
import { metaFingerprint, readEffectiveSettings, sessionOfRecovered } from "./session-decode.js";
import { ownershipOf } from "./session-view.js";
import { notifyWaiters, registerSession } from "./waiters.js";

/** Operation names of `reportPersistFailure`, which also key its one-line-per-session set. */
const PERSIST_OP_META = "session metadata";

const PERSIST_OP_RESULT = "turn result";

/**
 * Take into memory the sessions of this state directory that no other server holds.
 *
 * A session another running codex-mcp owns is left where it is: that server is
 * writing into the directory, and two servers on one Codex thread would each
 * answer half the turn. A session whose owner is gone is adopted, its stale
 * claim removed, and a turn that was running when the owner died becomes
 * `abandoned` — the work was cut off, and `resume` picks the thread back up.
 *
 * Every field comes from the recovered metadata, timestamps included: a session that
 * was cut off keeps the instant it was last active, so idle cleanup and the retention
 * policy — which both date a session by `lastActiveAt` — still measure its real age
 * after a restart instead of measuring the restart.
 */
export function ingestRecovered(runtime: SessionRuntime, recovered: RecoveredSession[]): void {
  for (const rec of recovered) {
    if (runtime.sessions.has(rec.sessionId)) continue; // skip duplicates
    takeRecovered(runtime, rec);
  }
}

/** Take one recovered session into memory, or say on stderr why it stays on disk. */
function takeRecovered(runtime: SessionRuntime, rec: RecoveredSession): void {
  if (rec.owner.kind === "held") {
    console.error(
      `[codex-mcp] Session ${rec.sessionId} is ${describeOwner(rec.owner)} — leaving it to that server`
    );
    return;
  }
  const createdAt = normalizeOptionalString(rec.meta.createdAt);
  const lastActiveAt = normalizeOptionalString(rec.meta.lastActiveAt);
  if (!createdAt || !lastActiveAt) {
    // Both timestamps decide when cleanup cancels the session and when retention drops
    // its directory. Reading the clock for a missing one would date every restart as
    // fresh activity and keep the directory for good, so the session stays out.
    console.error(
      `[codex-mcp] Skipping recovered session ${rec.sessionId}: meta.json records no ` +
        `${!createdAt ? "createdAt" : "lastActiveAt"}`
    );
    return;
  }
  const session = sessionOfRecovered(rec, createdAt, lastActiveAt);
  registerSession(runtime, session);
  // The owner is gone, so its claim on the session goes with it.
  if (rec.owner.kind === "gone") runtime.persistence?.release(rec.sessionId);
  // Resume event log sequence numbering
  if (rec.lastSeq >= 0) {
    runtime.persistence?.setEventLogNextSeq(rec.sessionId, rec.lastSeq + 1);
  }
  attachEventSink(runtime, session);
  // Record what the session now is, so the next reader sees `abandoned`
  // rather than a `running` status no process backs.
  if (session.status !== rec.meta.status) persistSessionIfChanged(runtime, session);
}

/** Take a new session into memory, claim it for this server, and open its directory. */
export function openNewSession(
  runtime: SessionRuntime,
  session: SessionInfo,
  client: ICodexClient
): void {
  const { sessionId } = session;
  registerSession(runtime, session);
  runtime.clients.set(sessionId, client);
  attachEventSink(runtime, session);

  // Persist session metadata to disk and claim the session for this server
  try {
    runtime.persistence?.writeSessionMeta(session);
    runtime.persistence?.claim(sessionId);
  } catch (err) {
    // The first write is what creates the session directory: without it nothing about
    // this session survives a restart, while the compat report still says
    // `diskPersistence: true`.
    reportPersistFailure(runtime, PERSIST_OP_META, sessionId, err);
  }
}

/**
 * Mirror this session's events into its events.jsonl.
 *
 * Persistence is best-effort: a write that fails is reported once per session and
 * leaves the session running, with its status and its result held in memory.
 */
export function attachEventSink(runtime: SessionRuntime, session: SessionInfo): void {
  const persistence = runtime.persistence;
  if (!persistence) return;
  const sessionId = session.sessionId;
  setEventSink(session, (type, data, timestamp) => {
    try {
      persistence.appendEvent(sessionId, type, data, timestamp);
    } catch (err) {
      if (runtime.eventPersistFailed.has(sessionId)) return;
      runtime.eventPersistFailed.add(sessionId);
      console.error(
        `[codex-mcp] Failed to persist events: session=${sessionId} error=${err instanceof Error ? err.message : String(err)}`
      );
    }
  });
}

/**
 * Report a persistence write that failed.
 *
 * The session goes on running from memory, so what the caller is told and what a
 * restart would find drift apart from here on: one stderr line per session and
 * operation says which write was lost and why, without a line per turn.
 */
function reportPersistFailure(
  runtime: SessionRuntime,
  operation: string,
  sessionId: string,
  err: unknown
): void {
  const key = `${operation}\0${sessionId}`;
  if (runtime.persistFailureReported.has(key)) return;
  runtime.persistFailureReported.add(key);
  console.error(
    `[codex-mcp] Failed to persist ${operation}: session=${sessionId} error=${describeError(err)}`
  );
}

/**
 * Write the session's metadata to disk when any of it changed.
 *
 * The comparison covers every field meta.json carries, so the thread id
 * reaches the file the moment Codex hands it over rather than at the next
 * status change — a session cut off inside its first turn is resumable only
 * if its thread id is already there.
 */
export function persistSessionIfChanged(runtime: SessionRuntime, session: SessionInfo): void {
  if (!runtime.persistence) return;
  const fingerprint = metaFingerprint(session);
  if (runtime.lastPersistedMeta.get(session.sessionId) === fingerprint) return;
  try {
    runtime.persistence.writeSessionMeta(session);
    runtime.lastPersistedMeta.set(session.sessionId, fingerprint);
  } catch (err) {
    reportPersistFailure(runtime, PERSIST_OP_META, session.sessionId, err);
  }
}

/**
 * Record whether the turn about to start constrains its final message with a
 * JSON Schema — `turn/completed` carries no schema of its own, so this is what
 * tells the completion handler to read the message as structured output.
 */
export function markTurnOutputSchema(
  runtime: SessionRuntime,
  sessionId: string,
  outputSchema?: Record<string, unknown>
): void {
  if (outputSchema && Object.keys(outputSchema).length > 0) {
    runtime.schemaConstrainedTurns.add(sessionId);
  } else {
    runtime.schemaConstrainedTurns.delete(sessionId);
  }
}

/**
 * Best-effort persist result to disk.
 */
export function persistResult(runtime: SessionRuntime, session: SessionInfo): void {
  if (!runtime.persistence || !session.lastResult) return;
  try {
    runtime.persistence.writeResult(session.sessionId, session.lastResult);
  } catch (err) {
    // A result that never reaches result.json comes back as `lastResult: null` after a
    // restart, which reads exactly like a turn that produced nothing.
    reportPersistFailure(runtime, PERSIST_OP_RESULT, session.sessionId, err);
  }
}

/** Read the state directory, reporting a scan that failed rather than serving an empty one. */
export function scanDisk(runtime: SessionRuntime): RecoveredSession[] {
  if (!runtime.persistence) return [];
  try {
    return runtime.persistence.recoverSessions();
  } catch (err) {
    console.error(`[codex-mcp] Failed to read the state directory: ${describeError(err)}`);
    return [];
  }
}

/** Who holds a session: this server while it drives it, else whatever owner.json says. */
export function ownershipOfSession(
  runtime: SessionRuntime,
  sessionId: string
): SessionOwnership | undefined {
  if (runtime.clients.has(sessionId)) return { pid: process.pid, state: "self" };
  if (!runtime.persistence) return undefined;
  return ownershipOf(ownerState(readOwner(runtime.persistence.sessionDir(sessionId))));
}

/**
 * Put the settings Codex just answered on the session.
 *
 * An answer carrying nothing readable leaves the last ones it gave in place:
 * those are still settings Codex named, and a half of one answer merged into
 * another would report a set that never ran together.
 */
export function recordEffectiveSettings(session: SessionInfo, answer: unknown): void {
  session.effective = readEffectiveSettings(answer) ?? session.effective;
}

/** Keep the answer to a start that named no model: that answer is the default. */
export function recordCodexDefaultModel(
  runtime: SessionRuntime,
  requestedModel: string | undefined,
  answered?: string
): void {
  if (requestedModel === undefined && answered !== undefined) {
    runtime.codexDefaultModel = answered;
  }
}

export function getSessionOrThrow(runtime: SessionRuntime, sessionId: string): SessionInfo {
  const session = runtime.sessions.get(sessionId);
  if (!session) {
    throw new Error(`Error [${ErrorCode.SESSION_NOT_FOUND}]: Session '${sessionId}' not found`);
  }
  return session;
}

export function getClientOrThrow(runtime: SessionRuntime, sessionId: string): ICodexClient {
  const client = runtime.clients.get(sessionId);
  if (!client) {
    throw new Error(`Error [${ErrorCode.SESSION_NOT_FOUND}]: No client for session '${sessionId}'`);
  }
  return client;
}

/**
 * The session, its client and the thread it runs on, or the error saying why the
 * call cannot reach it. `cancelled` and `noThread` are the sentences the caller
 * reads, so each call names its own action.
 */
export function threadTarget(
  runtime: SessionRuntime,
  sessionId: string,
  messages: { cancelled: string; noThread: string }
): { session: SessionInfo; client: ICodexClient; threadId: string } {
  const session = getSessionOrThrow(runtime, sessionId);

  // Status first: cancelSession drops the client, so a client lookup ahead of this
  // reports a cancelled session as SESSION_NOT_FOUND.
  if (session.status === "cancelled") {
    throw new Error(`Error [${ErrorCode.CANCELLED}]: ${messages.cancelled}`);
  }
  if (!session.threadId) {
    throw new Error(`Error [${ErrorCode.INTERNAL}]: ${messages.noThread}`);
  }

  return { session, client: getClientOrThrow(runtime, sessionId), threadId: session.threadId };
}

/** Write down the pid of every process the client spawns, for the orphan reaper. */
export function persistSpawnedPid(
  runtime: SessionRuntime,
  session: SessionInfo,
  pid: number,
  spawnedAt: string
): void {
  const { sessionId } = session;
  // spawnedAt is the instant the client spawned the process; the reaper
  // matches it against the start time the OS reports for that pid.
  const details: PidDetails & { spawnedAt?: string } = { model: session.model, spawnedAt };
  try {
    runtime.persistence?.writePidInfo(sessionId, pid, details);
  } catch (err) {
    // Every spawn that never reaches pid.json is a codex process the orphan reaper
    // cannot find on the next start, so each one is reported rather than the first.
    console.error(
      `[codex-mcp] Failed to persist pid.json — pid ${pid} will not be reaped after a ` +
        `restart: session=${sessionId} error=${describeError(err)}`
    );
  }
}

export function evictSession(
  runtime: SessionRuntime,
  sessionId: string,
  removeDisk: boolean
): {
  deleted: boolean;
  diskRemoved: boolean;
  /** Why the session directory is still on disk, when removal was asked for and failed. */
  diskError?: string;
} {
  const session = runtime.sessions.get(sessionId);
  if (!session) return { deleted: false, diskRemoved: false };

  clearSessionPendingRequests(session);
  runtime.clients
    .get(sessionId)
    ?.destroy()
    .catch((err) => {
      console.error(
        `[codex-mcp] Failed to destroy app-server client during cleanup: session=${sessionId} error=${err instanceof Error ? err.message : String(err)}`
      );
    });
  runtime.clients.delete(sessionId);
  const deleted = runtime.sessions.delete(sessionId);
  // After the removal: a waiter is woken by the session being gone, which is a
  // change it acts on, and its next read reports the session as not found.
  notifyWaiters(runtime, sessionId);
  runtime.lastPersistedMeta.delete(sessionId);
  runtime.ttlWarningEmitted.delete(sessionId);
  runtime.sessionNotifiers.delete(sessionId);
  runtime.lastNotifiedSignal.delete(sessionId);
  runtime.cancellationInFlight.delete(sessionId);
  runtime.eventPersistFailed.delete(sessionId);
  runtime.schemaConstrainedTurns.delete(sessionId);
  runtime.persistFailureReported.delete(`${PERSIST_OP_META}\0${sessionId}`);
  runtime.persistFailureReported.delete(`${PERSIST_OP_RESULT}\0${sessionId}`);
  let diskRemoved = false;
  let diskError: string | undefined;
  try {
    if (runtime.persistence) {
      if (removeDisk) {
        runtime.persistence.removeSession(sessionId);
        diskRemoved = true;
      } else {
        // Flush what the session buffered, drop its log handle, and give the
        // session back: this server no longer drives it.
        runtime.persistence.destroySessionLog(sessionId);
        runtime.persistence.release(sessionId);
      }
    }
  } catch (err) {
    // A directory that could not be removed still holds the session's paths and code
    // fragments, and `diskSessionsRemoved: 0` alone reads like disk removal was never
    // asked for — so the caller is told which sessions are still there.
    const detail = describeError(err);
    if (removeDisk) diskError = detail;
    console.error(
      `[codex-mcp] Failed to ${removeDisk ? "remove the session directory" : "close the event log"}: ` +
        `session=${sessionId} error=${detail}`
    );
  }

  return { deleted, diskRemoved, ...(diskError ? { diskError } : {}) };
}
