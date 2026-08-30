/** Everything a caller reads off a session without moving it. */
import type {
  CheckResult,
  PendingAction,
  ProgressInfo,
  PublicSessionInfo,
  SensitiveSessionInfo,
  SessionSignal,
  TurnResult,
} from "../../types.js";
import {
  interactionStateForStatus,
  recommendedNextActionForStatus,
} from "../../utils/execution.js";
import type { SessionRuntime } from "./core.js";
import { addActivityListener } from "./events.js";
import { buildProgressInfo, countPendingRequests, pollIntervalForStatus } from "./progress.js";
import {
  awaitsTurnRecord,
  publicInfoOfRecovered,
  signalOf,
  TERMINAL_SESSION_STATUSES,
  toPublicInfo,
  toSensitiveInfo,
  warningsOf,
} from "./session-view.js";
import { getSessionOrThrow, ownershipOfSession, scanDisk } from "./store.js";

/** The sessions this server holds in memory. */
export function listSessions(runtime: SessionRuntime): PublicSessionInfo[] {
  return Array.from(runtime.sessions.values()).map((session) =>
    toPublicInfo(session, ownershipOfSession(runtime, session.sessionId))
  );
}

/**
 * Every session of the state directory: the ones this server drives, the ones
 * another running server drives, and the ones nobody holds.
 *
 * The directory is read on each call rather than at startup, because the
 * picture changes underneath: a server that died a minute ago left sessions
 * this one can resume, and a server that started a minute ago holds sessions
 * this one must not touch.
 */
export function listAllSessions(runtime: SessionRuntime): PublicSessionInfo[] {
  const byId = new Map<string, PublicSessionInfo>();
  for (const rec of scanDisk(runtime)) {
    byId.set(rec.sessionId, publicInfoOfRecovered(rec));
  }
  for (const session of runtime.sessions.values()) {
    // A session with a live client here is this server's, and memory is ahead
    // of the file. One without a client was adopted or given up, and the
    // directory carries whatever has happened to it since.
    if (runtime.clients.has(session.sessionId) || !byId.has(session.sessionId)) {
      byId.set(
        session.sessionId,
        toPublicInfo(session, ownershipOfSession(runtime, session.sessionId))
      );
    }
  }
  return Array.from(byId.values()).sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
}

/**
 * Count currently active sessions for lightweight runtime observability.
 * "Active" here means the session can still be interacted with.
 */
export function getActiveSessionCount(runtime: SessionRuntime): number {
  let count = 0;
  for (const session of runtime.sessions.values()) {
    if (
      session.status === "running" ||
      session.status === "waiting_approval" ||
      session.status === "idle"
    ) {
      count++;
    }
  }
  return count;
}

/**
 * The model Codex starts a thread on when the request names none.
 *
 * It is read off the answer to a `thread/start` this server sent with no
 * model, so it is a model Codex reported running rather than one guessed from
 * the sessions in memory. Null until such a start has been answered — where
 * every start names a model, `CODEX_MCP_DEFAULT_MODEL` included, nothing here
 * measures the default and it stays unknown.
 */
export function getCodexDefaultModel(runtime: SessionRuntime): string | null {
  return runtime.codexDefaultModel;
}

export function getSession(
  runtime: SessionRuntime,
  sessionId: string,
  includeSensitive = false
): PublicSessionInfo | SensitiveSessionInfo {
  const session = getSessionOrThrow(runtime, sessionId);
  const owner = ownershipOfSession(runtime, sessionId);
  return includeSensitive ? toSensitiveInfo(session, owner) : toPublicInfo(session, owner);
}

export function getLastResult(runtime: SessionRuntime, sessionId: string): TurnResult | undefined {
  return getSessionOrThrow(runtime, sessionId).lastResult;
}

export function getProgress(runtime: SessionRuntime, sessionId: string): ProgressInfo {
  return buildProgressInfo(getSessionOrThrow(runtime, sessionId));
}

/**
 * Hear each new activity line of a session for as long as the returned function
 * is not called.
 *
 * It is what a caller holding a tool call open reports upward as the line
 * arrives, before the poll it is holding answers.
 */
export function onActivity(
  runtime: SessionRuntime,
  sessionId: string,
  listener: (activity: string) => void
): () => void {
  return addActivityListener(getSessionOrThrow(runtime, sessionId), listener);
}

export function getPendingActionTypes(
  runtime: SessionRuntime,
  sessionId: string
): Array<"approval" | "user_input"> {
  const session = getSessionOrThrow(runtime, sessionId);
  const actionTypes = new Set<"approval" | "user_input">();
  for (const req of session.pendingRequests.values()) {
    if (req.resolved) continue;
    actionTypes.add(req.kind === "user_input" ? "user_input" : "approval");
  }
  return Array.from(actionTypes);
}

/**
 * Where the session stands and what it waits for.
 *
 * The turn's own events are not part of it: Codex writes the whole transcript
 * to its rollout log under `~/.codex/sessions/`, and repeating it here would
 * put the run through the caller's context a second time.
 */
export function pollStatus(runtime: SessionRuntime, sessionId: string): CheckResult {
  const session = getSessionOrThrow(runtime, sessionId);

  const actions: PendingAction[] = [];
  for (const req of session.pendingRequests.values()) {
    if (req.resolved) continue;
    actions.push({
      type: req.kind === "user_input" ? "user_input" : "approval",
      requestId: req.requestId,
      kind: req.kind,
      params: req.params,
      itemId: req.itemId,
      reason: req.reason,
      approvalId: req.approvalId,
      commandActions: req.commandActions,
      proposedExecpolicyAmendment: req.proposedExecpolicyAmendment,
      availableDecisions: req.availableDecisions,
      proposedNetworkPolicyAmendments: req.proposedNetworkPolicyAmendments,
      additionalPermissions: req.additionalPermissions,
      networkApprovalContext: req.networkApprovalContext,
      createdAt: req.createdAt,
    });
  }

  return {
    sessionId,
    status: session.status,
    pollInterval: pollIntervalForStatus(session.status),
    progress: buildProgressInfo(session),
    interactionState: interactionStateForStatus(session.status),
    recommendedNextAction: recommendedNextActionForStatus(
      session.status,
      Array.from(new Set(actions.map((action) => action.type)))
    ),
    actions,
    warnings: warningsOf(session),
    result: terminalTurnResult(runtime, sessionId),
  };
}

/**
 * The finished turn's answer, for as long as the session stands on it.
 *
 * Every check of a terminal session carries it, not the first one alone. A
 * caller that checks again — it retried, it lost the answer, its response was
 * dropped by a transport that cut the call — reads the answer back instead of
 * an empty result it then fills in from memory. Only the next turn replaces
 * it.
 */
function terminalTurnResult(
  runtime: SessionRuntime,
  sessionId: string
): TurnResult | undefined {
  const session = getSessionOrThrow(runtime, sessionId);
  if (!TERMINAL_SESSION_STATUSES.has(session.status)) return undefined;
  return session.lastResult;
}

/**
 * What a long-poll caller waits on: the status, the open actions and the
 * result of the turn.
 */
export function getSessionSignal(runtime: SessionRuntime, sessionId: string): SessionSignal {
  const session = getSessionOrThrow(runtime, sessionId);
  return {
    key: signalOf(session),
    awaitsCaller:
      countPendingRequests(session) > 0 ||
      (TERMINAL_SESSION_STATUSES.has(session.status) && !awaitsTurnRecord(session)),
  };
}

// ── Approval Response ────────────────────────────────────────────
