import type {
  InteractionState,
  ProgressInfo,
  RecommendedNextAction,
  SessionStatus,
} from "../types.js";

const TERMINAL_STATUSES = new Set<SessionStatus>(["idle", "error", "cancelled", "abandoned"]);

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
  else if (status === "abandoned") phase = "abandoned";
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
