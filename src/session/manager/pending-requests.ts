/** The requests a session holds open, and how each one is closed. */
import type { PendingRequest, SessionInfo } from "../../types.js";
import type { SessionRuntime } from "./core.js";
import { recordEvent } from "./events.js";
import { notifyWaiters } from "./waiters.js";

/** The answer that closes an unanswered request of a session that is going away. */
export function respondCancelled(req: PendingRequest): void {
  if (!req.respond) return;
  if (req.kind === "command") req.respond({ decision: "cancel" });
  else if (req.kind === "fileChange") req.respond({ decision: "cancel" });
  else if (req.kind === "user_input") req.respond({ answers: {} });
}

export function clearSessionPendingRequests(session: SessionInfo): void {
  const entries = Array.from(session.pendingRequests.entries());
  session.pendingRequests.clear();
  for (const [, req] of entries) {
    if (req.timeoutHandle) clearTimeout(req.timeoutHandle);
    // Best-effort: send cancel response so the backend isn't left waiting.
    if (!req.resolved && req.respond) {
      try {
        respondCancelled(req);
      } catch {
        // Client already exited — response delivery is best-effort
      }
    }
    req.resolved = true;
  }
}

export function setTerminalErrorResult(session: SessionInfo, message: string): void {
  const completedAt = new Date().toISOString();
  const failedTurnId = session.activeTurnId ?? "";
  session.activeTurnId = undefined;
  session.lastResult = {
    turnId: failedTurnId,
    outcome: "error",
    status: "error",
    error: message,
    completedAt,
  };
  recordEvent(session, "result", {
    status: "error",
    turnId: failedTurnId,
    error: message,
    completedAt,
  });
}

export function createUnrefTimeout(
  handler: () => void,
  timeoutMs: number
): ReturnType<typeof setTimeout> {
  const timer = setTimeout(handler, timeoutMs);
  if (typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as { unref: () => void }).unref();
  }
  return timer;
}

/**
 * Drop an answered request and give the session back the status it runs on.
 *
 * The waiters are woken last, so the poll they return to reads the session as
 * it now stands rather than as it was while the request was open.
 */
export function settlePendingRequest(
  runtime: SessionRuntime,
  session: SessionInfo,
  requestId: string
): void {
  // Remove resolved request to prevent unbounded growth
  session.pendingRequests.delete(requestId);

  // Restore status if no more pending requests
  if (session.pendingRequests.size === 0 && session.status === "waiting_approval") {
    session.status = "running";
  }

  // Wake any long-poll waiters so they see the status transition
  notifyWaiters(runtime, session.sessionId);
}

// ── User Input Response ──────────────────────────────────────────
