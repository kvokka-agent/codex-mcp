/** Cancelling a session, dropping it, and the timer sweep that does both. */
import {
  type CleanableStatus,
  DEFAULT_IDLE_CLEANUP_MS,
  DEFAULT_RUNNING_CLEANUP_MS,
  DEFAULT_TERMINAL_CLEANUP_MS,
  type PendingRequest,
  type SessionInfo,
  type SessionStatus,
} from "../../types.js";
import type { SessionRuntime } from "./core.js";
import { recordEvent } from "./events.js";
import { clearSessionPendingRequests, respondCancelled } from "./pending-requests.js";
import {
  evictSession,
  getSessionOrThrow,
  persistResult,
  persistSessionIfChanged,
} from "./store.js";
import { notifyWaiters } from "./waiters.js";

const TTL_WARNING_THRESHOLD_MS = 60_000;

/**
 * What `clean` removes when the caller names no statuses.
 *
 * `abandoned` is not among them: a session nobody holds is what somebody looking
 * for interrupted work is about to resume, so removing it takes a caller asking
 * for it by name.
 */
const DEFAULT_CLEANABLE_STATUSES: CleanableStatus[] = ["idle", "error", "cancelled"];

export async function cancelSession(
  runtime: SessionRuntime,
  sessionId: string,
  reason?: string
): Promise<void> {
  const existing = runtime.cancellationInFlight.get(sessionId);
  if (existing) {
    await existing;
    return;
  }

  const cancellation = performCancelSession(runtime, sessionId, reason);
  runtime.cancellationInFlight.set(sessionId, cancellation);
  try {
    await cancellation;
  } finally {
    runtime.cancellationInFlight.delete(sessionId);
  }
}

async function performCancelSession(
  runtime: SessionRuntime,
  sessionId: string,
  reason?: string
): Promise<void> {
  const session = getSessionOrThrow(runtime, sessionId);

  // Idempotent: already cancelled
  if (session.status === "cancelled") return;

  const client = runtime.clients.get(sessionId);

  session.status = "cancelled";
  const now = new Date().toISOString();
  session.cancelledAt = now;
  session.lastActiveAt = now;
  session.cancelledReason = reason ?? "Cancelled by user";

  // Persist cancelled status to disk
  persistSessionIfChanged(runtime, session);

  cancelPendingRequests(session);

  recordEvent(session, "progress", {
    message: "Session cancelled",
    cancelledReason: session.cancelledReason,
  });

  const cancelledTurnId = session.activeTurnId ?? "";
  session.activeTurnId = undefined;
  // A turn that already ended left its answer in `lastResult`, and a turn that starts
  // clears it — so a result here belongs to a finished turn and the cancel keeps it.
  // Overwriting it left result.json saying "cancelled" for a session that had answered,
  // and the answer was gone from disk. The cancellation is in meta.json's
  // `cancelledAt`/`cancelledReason` and in the event log below.
  if (!session.lastResult) {
    session.lastResult = {
      turnId: cancelledTurnId,
      outcome: "cancelled",
      status: "cancelled",
      error: session.cancelledReason,
      completedAt: new Date().toISOString(),
    };
    persistResult(runtime, session);
  }
  recordEvent(session, "result", {
    status: "cancelled",
    reason: session.cancelledReason,
    turnId: cancelledTurnId,
  });
  // Wake long-poll waiters so they see the cancellation immediately
  notifyWaiters(runtime, sessionId);

  if (client) {
    await client.destroy();
    runtime.clients.delete(sessionId);
  }
}

/** Answer every request the cancelled session still holds open, so nothing waits on it. */
function cancelPendingRequests(session: SessionInfo): void {
  // Resolve and clear all pending requests (avoid leaving hanging server-initiated requests)
  for (const [reqId, req] of session.pendingRequests) {
    closePendingRequest(session.sessionId, reqId, req);
    session.pendingRequests.delete(reqId);
  }
}

/** Answer one open request of a session going away, reporting an answer that did not land. */
function closePendingRequest(sessionId: string, reqId: string, req: PendingRequest): void {
  if (req.timeoutHandle) clearTimeout(req.timeoutHandle);
  if (req.resolved || !req.respond) return;
  req.resolved = true;
  try {
    respondCancelled(req);
  } catch (err) {
    console.error(
      `[codex-mcp] Failed to respond pending request during cancel: session=${sessionId} request=${reqId} kind=${req.kind} error=${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/** Which sessions `clean` takes, and whether it also removes their directories. */
export interface CleanSessionsOptions {
  statuses?: CleanableStatus[];
  olderThanMs?: number;
  dryRun?: boolean;
  includeDisk?: boolean;
}

/** What `clean` matched, what it removed, and what it could not. */
export interface CleanSessionsResult {
  matchedSessionIds: string[];
  removedSessionIds: string[];
  removedCount: number;
  diskSessionsRemoved: number;
  dryRun: boolean;
  /** Set when a session directory removal was asked for and failed; names the sessions. */
  message?: string;
}

export async function cleanSessions(
  runtime: SessionRuntime,
  options?: CleanSessionsOptions
): Promise<CleanSessionsResult> {
  const statuses = new Set<string>(options?.statuses ?? DEFAULT_CLEANABLE_STATUSES);
  const olderThanMs = options?.olderThanMs;
  const dryRun = options?.dryRun ?? false;
  const includeDisk = options?.includeDisk ?? true;
  const now = Date.now();
  const matchedSessionIds = matchCleanableSessions(runtime, statuses, olderThanMs, now);

  if (dryRun) {
    return {
      matchedSessionIds,
      removedSessionIds: [],
      removedCount: 0,
      diskSessionsRemoved: 0,
      dryRun: true,
    };
  }

  const { removedSessionIds, diskSessionsRemoved, diskFailures } = evictMatchedSessions(
    runtime,
    matchedSessionIds,
    includeDisk
  );

  return {
    matchedSessionIds,
    removedSessionIds,
    removedCount: removedSessionIds.length,
    diskSessionsRemoved,
    dryRun: false,
    // Without this, a failed removal reports the same numbers as `includeDisk: false`
    // and the caller reads a directory that is still there as cleaned.
    ...(diskFailures.length > 0 ? { message: stillOnDiskMessage(diskFailures) } : {}),
  };
}

/** The sessions `clean` removes: those in one of `statuses` and idle for long enough. */
function matchCleanableSessions(
  runtime: SessionRuntime,
  statuses: Set<string>,
  olderThanMs: number | undefined,
  now: number
): string[] {
  const matchedSessionIds: string[] = [];
  for (const [sessionId, session] of Array.from(runtime.sessions.entries())) {
    if (!statuses.has(session.status)) continue;
    if (!isOlderThan(session.lastActiveAt, olderThanMs, now)) continue;
    matchedSessionIds.push(sessionId);
  }
  return matchedSessionIds;
}

/** Drop each matched session, counting what went and naming what stayed on disk. */
function evictMatchedSessions(
  runtime: SessionRuntime,
  matchedSessionIds: string[],
  includeDisk: boolean
): { removedSessionIds: string[]; diskSessionsRemoved: number; diskFailures: string[] } {
  let diskSessionsRemoved = 0;
  const removedSessionIds: string[] = [];
  const diskFailures: string[] = [];
  for (const sessionId of matchedSessionIds) {
    const evicted = evictSession(runtime, sessionId, includeDisk);
    if (evicted.deleted) {
      removedSessionIds.push(sessionId);
    }
    if (evicted.diskRemoved) {
      diskSessionsRemoved++;
    }
    if (evicted.diskError) {
      diskFailures.push(`${sessionId} (${evicted.diskError})`);
    }
  }
  return { removedSessionIds, diskSessionsRemoved, diskFailures };
}

/** Drop everything the runtime holds. The facade's cleanup timer is its own. */
export function destroy(runtime: SessionRuntime): void {
  runtime.cancellationInFlight.clear();

  // Clear all pending request timers
  for (const [, session] of runtime.sessions) {
    clearSessionPendingRequests(session);
  }

  for (const [id, client] of runtime.clients) {
    client.destroy().catch((err) => {
      console.error(
        `[codex-mcp] Failed to destroy app-server client during manager.destroy(): session=${id} error=${err instanceof Error ? err.message : String(err)}`
      );
    });
    runtime.clients.delete(id);
  }
  runtime.sessions.clear();
  runtime.lastNotifiedSignal.clear();
  runtime.eventPersistFailed.clear();
  try {
    runtime.persistence?.flushAll();
  } catch {
    /* best-effort */
  }
}

// ── Private ──────────────────────────────────────────────────────

export function cleanupSessions(runtime: SessionRuntime): void {
  const now = Date.now();
  for (const [id, session] of runtime.sessions) {
    const lastActive = new Date(session.lastActiveAt).getTime();
    if (Number.isNaN(lastActive)) {
      // Invalid timestamp — clean up immediately
      runtime.ttlWarningEmitted.delete(id);
      requestCancellation(runtime, id, "Invalid timestamp");
      continue;
    }
    const age = now - lastActive;

    const expiredReason = expiryReasonForAge(session.status, age);
    if (expiredReason !== undefined) {
      runtime.ttlWarningEmitted.delete(id);
      requestCancellation(runtime, id, expiredReason);
    } else if (isRetentionExpired(session.status, age)) {
      evictSession(runtime, id, true);
    } else {
      warnBeforeExpiry(runtime, id, session, age);
    }
  }
}

/** Say once, on the session's own event log, that its TTL is about to run out. */
function warnBeforeExpiry(
  runtime: SessionRuntime,
  id: string,
  session: SessionInfo,
  age: number
): void {
  // Check if this session is within the TTL warning window.
  const ttlMs = ttlForStatus(session.status);
  if (ttlMs === undefined || runtime.ttlWarningEmitted.has(id)) return;
  const timeUntilExpiry = ttlMs - age;
  if (timeUntilExpiry <= TTL_WARNING_THRESHOLD_MS && timeUntilExpiry > 0) {
    runtime.ttlWarningEmitted.add(id);
    recordEvent(session, "progress", {
      method: "codex-mcp/ttl_warning",
      type: "ttl_warning",
      ttlRemainingMs: timeUntilExpiry,
      sessionId: id,
    });
  }
}

function requestCancellation(runtime: SessionRuntime, sessionId: string, reason: string): void {
  if (runtime.cancellationInFlight.has(sessionId)) return;
  cancelSession(runtime, sessionId, reason).catch((err) => {
    console.error(
      `[codex-mcp] Failed to cancel session during cleanup: session=${sessionId} reason=${reason} error=${err instanceof Error ? err.message : String(err)}`
    );
  });
}

/**
 * Whether a session last active at `lastActiveAt` has been still for `olderThanMs`.
 *
 * A caller that names no age wants every session of the named statuses, and a
 * `lastActiveAt` no clock can read dates the session nowhere, so it is left alone.
 */
function isOlderThan(lastActiveAt: string, olderThanMs: number | undefined, now: number): boolean {
  if (typeof olderThanMs !== "number" || olderThanMs <= 0) return true;
  const lastActive = new Date(lastActiveAt).getTime();
  if (!Number.isFinite(lastActive)) return false;
  return now - lastActive >= olderThanMs;
}

/** Names the sessions whose directory removal was asked for and failed. */
function stillOnDiskMessage(diskFailures: string[]): string {
  return (
    `${diskFailures.length} session director${diskFailures.length === 1 ? "y is" : "ies are"} ` +
    `still on disk: ${diskFailures.join(", ")}`
  );
}

/** Why cleanup cancels a session of this status and age, or nothing while it has time left. */
function expiryReasonForAge(status: SessionStatus, age: number): string | undefined {
  if (status === "idle" && age > DEFAULT_IDLE_CLEANUP_MS) return "Idle timeout";
  if (status === "waiting_approval" && age > DEFAULT_RUNNING_CLEANUP_MS) return "Approval timeout";
  if (status === "running" && age > DEFAULT_RUNNING_CLEANUP_MS) return "Running timeout";
  return undefined;
}

/** A finished session that has stood longer than a finished session is kept. */
function isRetentionExpired(status: SessionStatus, age: number): boolean {
  return (status === "cancelled" || status === "error") && age > DEFAULT_TERMINAL_CLEANUP_MS;
}

/** How long a session of this status lives without activity, or nothing when it does not expire. */
function ttlForStatus(status: SessionStatus): number | undefined {
  if (status === "idle") return DEFAULT_IDLE_CLEANUP_MS;
  if (status === "running" || status === "waiting_approval") return DEFAULT_RUNNING_CLEANUP_MS;
  return undefined;
}
