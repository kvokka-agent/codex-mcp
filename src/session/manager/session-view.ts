/** A session as a caller reads it, and the one string a long poll wakes on. */
import type { OwnerState, RecoveredSession } from "../../persistence/index.js";
import {
  APPROVAL_POLICIES,
  APPROVALS_REVIEWERS,
  type LastTurnInfo,
  type PublicSessionInfo,
  SANDBOX_MODES,
  type SensitiveSessionInfo,
  type SessionInfo,
  type SessionOwnership,
  type SessionStatus,
  type SessionWarning,
} from "../../types/index.js";
import { normalizeOptionalString, readOneOf } from "./read.js";
import {
  publicEffectiveSettings,
  readEffectiveSettings,
  statusOfRecovered,
} from "./session-decode.js";

/** How a listing names the server holding a session, or nothing when none does. */
export function ownershipOf(owner: OwnerState): SessionOwnership | undefined {
  if (owner.kind === "self") return { pid: owner.owner.pid, state: "self" };
  if (owner.kind === "held") return { pid: owner.owner.pid, state: "other" };
  return undefined;
}

/** A session this server does not hold, as a listing reports it. */
export function publicInfoOfRecovered(rec: RecoveredSession): PublicSessionInfo {
  return {
    sessionId: rec.sessionId,
    status: statusOfRecovered(rec),
    createdAt: normalizeOptionalString(rec.meta.createdAt) ?? "",
    lastActiveAt: normalizeOptionalString(rec.meta.lastActiveAt) ?? "",
    cancelledAt: normalizeOptionalString(rec.meta.cancelledAt),
    cancelledReason: normalizeOptionalString(rec.meta.cancelledReason),
    model: normalizeOptionalString(rec.meta.model),
    approvalPolicy: readOneOf(APPROVAL_POLICIES, rec.meta.approvalPolicy),
    sandbox: readOneOf(SANDBOX_MODES, rec.meta.sandbox),
    permissions: normalizeOptionalString(rec.meta.permissions),
    approvalsReviewer: readOneOf(APPROVALS_REVIEWERS, rec.meta.approvalsReviewer),
    pendingRequestCount: 0,
    activity: rec.lastActivity,
    owner: ownershipOf(rec.owner),
    effective: publicEffectiveSettings(readEffectiveSettings(rec.meta.effective)),
  };
}

/** A copy of what the backend said about this session, oldest first. */
export function warningsOf(session: SessionInfo): SessionWarning[] {
  return (session.warnings ?? []).map((warning) => ({ ...warning }));
}

export const TERMINAL_SESSION_STATUSES = new Set<SessionStatus>(["idle", "error", "cancelled"]);

/**
 * The thread said idle before the turn it was running was recorded.
 *
 * `thread/status/changed` arrives one notification ahead of `turn/completed` —
 * measured on codex app-server 0.149.1, `events.jsonl` seq 71 then 72 — and the
 * result is written by the second of them. A poll answered in between hands the
 * caller a terminal status with no `result`, which reads as a turn that finished
 * and said nothing. `TURN_COMPLETED` clears `activeTurnId`, so an active one
 * under an idle status is exactly that gap.
 */
export function awaitsTurnRecord(session: SessionInfo): boolean {
  return session.status === "idle" && session.activeTurnId !== undefined;
}

/**
 * The session state a long-poll caller acts on, as one string: status, open
 * actions and the finished turn's result.
 */
export function signalOf(session: SessionInfo): string {
  const openRequests = Array.from(session.pendingRequests.values())
    .filter((req) => !req.resolved)
    .map((req) => req.requestId)
    .sort()
    .join(",");
  return [
    // The status a waiter is woken by, which is the one the turn's record backs.
    awaitsTurnRecord(session) ? "running" : session.status,
    openRequests,
    session.lastResult?.completedAt ?? "",
    session.progressState?.activityAt ?? "",
    // Each new warning moves this; the backend repeating one does not.
    String(session.warningSeq ?? 0),
  ].join("|");
}

export function toPublicInfo(session: SessionInfo, owner?: SessionOwnership): PublicSessionInfo {
  return {
    sessionId: session.sessionId,
    status: session.status,
    createdAt: session.createdAt,
    lastActiveAt: session.lastActiveAt,
    cancelledAt: session.cancelledAt,
    cancelledReason: session.cancelledReason,
    model: session.model,
    approvalPolicy: session.approvalPolicy,
    sandbox: session.sandbox,
    permissions: session.permissions,
    approvalsReviewer: session.approvalsReviewer,
    pendingRequestCount: Array.from(session.pendingRequests.values()).filter((r) => !r.resolved)
      .length,
    activity: session.progressState?.activity,
    lastTurn: lastTurnInfo(session),
    owner,
    effective: publicEffectiveSettings(session.effective),
  };
}

/**
 * What the session's last turn came to, read off the result the session kept.
 *
 * A cancel that follows a finished turn keeps that result (`performCancelSession`),
 * so this survives closing the session while `status` does not.
 */
function lastTurnInfo(session: SessionInfo): LastTurnInfo | undefined {
  const result = session.lastResult;
  if (!result) return undefined;
  return {
    turnId: result.turnId,
    outcome: result.outcome,
    status: result.status,
    completedAt: result.completedAt,
    error: result.error,
  };
}

export function toSensitiveInfo(
  session: SessionInfo,
  owner?: SessionOwnership
): SensitiveSessionInfo {
  return {
    ...toPublicInfo(session, owner),
    threadId: session.threadId,
    cwd: session.cwd,
    profile: session.profile,
    config: session.config,
    effective: session.effective,
  };
}
