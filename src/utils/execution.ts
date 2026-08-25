import type {
  CheckResult,
  ExecutionFallbackReason,
  ExecutionInfo,
  InteractionState,
  ProgressInfo,
  RecommendedNextAction,
  SessionStatus,
} from "../types.js";
import type { SessionManager } from "../session/manager.js";

const TERMINAL_STATUSES = new Set<SessionStatus>(["idle", "error", "cancelled"]);

export function interactionStateForStatus(status: SessionStatus): InteractionState {
  if (status === "waiting_approval") return "waiting_input";
  if (TERMINAL_STATUSES.has(status)) return "finished";
  return "working";
}

export function recommendedNextActionForStatus(
  status: SessionStatus,
  actionTypes: Array<"approval" | "user_input"> = []
): RecommendedNextAction {
  if (status === "waiting_approval") {
    if (actionTypes.includes("user_input")) return "respond_user_input";
    if (actionTypes.includes("approval")) return "respond_permission";
  }
  if (TERMINAL_STATUSES.has(status)) return "none";
  return "poll";
}

export function buildExecutionInfo(
  waitForResultMs: number | undefined,
  status: SessionStatus,
  fallbackReason?: ExecutionFallbackReason
): ExecutionInfo {
  const requested = waitForResultMs && waitForResultMs > 0 ? "foreground" : "background";
  const effective =
    requested === "foreground" && TERMINAL_STATUSES.has(status) ? "foreground" : "background";
  return {
    requested,
    effective,
    waitForResultMs: waitForResultMs && waitForResultMs > 0 ? waitForResultMs : undefined,
    fallbackReason: effective === "background" ? fallbackReason : undefined,
  };
}

export function coerceProgressForStatus(
  status: SessionStatus,
  progress: ProgressInfo | undefined,
  options?: { completedAt?: string; pendingActionCount?: number }
): ProgressInfo | undefined {
  if (!progress) return undefined;

  let phase = progress.phase;
  if (status === "idle") phase = "finished";
  else if (status === "error") phase = "error";
  else if (status === "cancelled") phase = "cancelled";
  else if (status === "waiting_approval") phase = "waiting_approval";

  return {
    ...progress,
    phase,
    lastEventAt: options?.completedAt ?? progress.lastEventAt,
    pendingActionCount:
      status === "waiting_approval"
        ? Math.max(progress.pendingActionCount, options?.pendingActionCount ?? 0)
        : status === "running"
          ? progress.pendingActionCount
          : 0,
  };
}

export async function waitForCodexSessionForegroundResult(
  sessionManager: SessionManager,
  sessionId: string,
  waitForResultMs: number,
  signal?: AbortSignal
): Promise<{
  status: SessionStatus;
  result?: CheckResult["result"];
  completedAt?: string;
  pendingActionTypes?: Array<"approval" | "user_input">;
  fallbackReason?: ExecutionFallbackReason;
}> {
  const deadline = Date.now() + Math.min(waitForResultMs, 300_000);

  while (Date.now() < deadline) {
    let status: SessionStatus;
    try {
      status = sessionManager.getSession(sessionId).status;
    } catch {
      status = "error";
    }

    if (TERMINAL_STATUSES.has(status)) {
      const finalResult = sessionManager.getLastResult(sessionId);
      return {
        status,
        result: finalResult,
        completedAt: finalResult?.completedAt ?? new Date().toISOString(),
      };
    }

    if (status === "waiting_approval") {
      return {
        status,
        pendingActionTypes: sessionManager.getPendingActionTypes(sessionId),
        fallbackReason: "interactive_poll_required",
      };
    }

    const remainingMs = Math.min(deadline - Date.now(), 5_000);
    if (remainingMs <= 0) break;
    try {
      await sessionManager.waitForChange(sessionId, remainingMs, signal);
    } catch {
      break;
    }
  }

  let status: SessionStatus = "running";
  try {
    status = sessionManager.getSession(sessionId).status;
  } catch {
    status = "error";
  }
  return { status, fallbackReason: "wait_for_result_timeout" };
}
