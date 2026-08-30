/** The caller's answer to a request the session holds open. */
import type { UserInputRequestResponse } from "../../app-server/protocol.js";
import { ErrorCode, type PendingRequest, type SessionInfo } from "../../types.js";
import { assertApprovalDecision, buildApprovalResponse } from "./approval-decisions.js";
import { loggableAnswers, sendPendingRequestResponseOrThrow } from "./approval-io.js";
import type { ApprovalExtra, SessionRuntime } from "./core.js";
import { recordEvent } from "./events.js";
import { settlePendingRequest } from "./pending-requests.js";
import { getSessionOrThrow } from "./store.js";

/**
 * Send the caller's answer, and put the request back where it was if the send failed.
 *
 * A failed send leaves the app-server waiting, so the request has to become
 * answerable again: it goes back into the map unresolved, and the session back to
 * `waiting_approval` unless it was cancelled meanwhile.
 */
function sendPendingAnswer(
  session: SessionInfo,
  req: PendingRequest,
  requestId: string,
  response: unknown,
  decision?: string
): void {
  req.resolved = true;
  if (decision !== undefined) req.decision = decision;
  try {
    sendPendingRequestResponseOrThrow(req, response, session.sessionId, requestId);
  } catch (error) {
    req.resolved = false;
    if (decision !== undefined) req.decision = undefined;
    session.pendingRequests.set(requestId, req);
    if (session.status !== "cancelled") session.status = "waiting_approval";
    throw error;
  }
  if (req.timeoutHandle) clearTimeout(req.timeoutHandle);
}

export function resolveApproval(
  runtime: SessionRuntime,
  sessionId: string,
  requestId: string,
  decision: string,
  extra?: ApprovalExtra
): void {
  const session = getSessionOrThrow(runtime, sessionId);
  const req = session.pendingRequests.get(requestId);

  if (!req || req.resolved) {
    throw new Error(
      `Error [${ErrorCode.REQUEST_NOT_FOUND}]: Request '${requestId}' not found or already resolved`
    );
  }

  // Validate decision by kind (avoid sending invalid protocol payloads)
  assertApprovalDecision(req, requestId, decision, extra);

  // Build protocol response
  const response = buildApprovalResponse(req, decision, extra);

  if (!response) {
    throw new Error(
      `Error [${ErrorCode.INTERNAL}]: Failed to build approval response for request '${requestId}'`
    );
  }

  // Marked resolved while sending, to avoid duplicate timeout/response races.
  sendPendingAnswer(session, req, requestId, response, decision);

  // Push approval_result event
  recordEvent(session, "approval_result", {
    requestId,
    kind: req.kind,
    approvalId: req.approvalId,
    decision,
    denyMessage: extra?.denyMessage,
  });

  settlePendingRequest(runtime, session, requestId);
}

export function resolveUserInput(
  runtime: SessionRuntime,
  sessionId: string,
  requestId: string,
  answers: Record<string, { answers: string[] }>
): void {
  const session = getSessionOrThrow(runtime, sessionId);
  const req = session.pendingRequests.get(requestId);

  if (!req || req.resolved || req.kind !== "user_input") {
    throw new Error(
      `Error [${ErrorCode.REQUEST_NOT_FOUND}]: User input request '${requestId}' not found`
    );
  }

  sendPendingAnswer(session, req, requestId, { answers } as UserInputRequestResponse);

  recordEvent(session, "approval_result", {
    requestId,
    kind: "user_input",
    approvalId: req.approvalId,
    answers: loggableAnswers(req.params, answers),
  });

  settlePendingRequest(runtime, session, requestId);
}

// ── Cleanup ──────────────────────────────────────────────────────
