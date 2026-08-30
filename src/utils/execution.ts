import type {
  InteractionState,
  ProgressInfo,
  RecommendedNextAction,
  SessionStartResult,
  SessionStatus,
} from "../types/index.js";

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

/**
 * The phase a status forces on the progress reported with it. A status not named here
 * leaves the phase the session itself reported.
 */
const PHASE_FOR_STATUS: Partial<Record<SessionStatus, ProgressInfo["phase"]>> = {
  idle: "finished",
  error: "error",
  cancelled: "cancelled",
  abandoned: "abandoned",
  waiting_approval: "waiting_approval",
};

/**
 * How many answers the caller still owes the session.
 *
 * A session waiting for approval owes at least what the caller counted for it, so the
 * higher of the two stands; a running one owes what its progress holds; a session that
 * reached an end owes nothing, whatever its progress was left holding.
 */
function pendingActionCountForStatus(
  status: SessionStatus,
  progress: ProgressInfo,
  pendingActionCount: number | undefined
): number {
  if (status === "waiting_approval") {
    return Math.max(progress.pendingActionCount, pendingActionCount ?? 0);
  }
  if (status === "running") return progress.pendingActionCount;
  return 0;
}

export function coerceProgressForStatus(
  status: SessionStatus,
  progress: ProgressInfo | undefined,
  options?: { completedAt?: string; pendingActionCount?: number }
): ProgressInfo | undefined {
  if (!progress) return undefined;

  return {
    ...progress,
    phase: PHASE_FOR_STATUS[status] ?? progress.phase,
    lastEventAt: options?.completedAt ?? progress.lastEventAt,
    pendingActionCount: pendingActionCountForStatus(status, progress, options?.pendingActionCount),
  };
}

/**
 * What `startedTurnResult` asks of the session manager. It is declared here
 * rather than imported so `utils/` stays below `session/` in the import graph.
 */
interface ProgressSource {
  getProgress?: (sessionId: string) => ProgressInfo;
}

/**
 * The answer `codex` and `codex_reply` hand back once a turn is under way:
 * `running`, carrying whatever progress the manager already holds.
 *
 * `getProgress` is probed before it is called — a caller may pass a manager
 * stand-in that carries no such method — and the started result's own progress
 * is what stands in when it does not.
 */
export function startedTurnResult(
  sessionManager: ProgressSource,
  startResult: SessionStartResult
): SessionStartResult {
  const observed =
    typeof sessionManager.getProgress === "function"
      ? sessionManager.getProgress(startResult.sessionId)
      : undefined;
  return {
    ...startResult,
    progress: coerceProgressForStatus("running", observed ?? startResult.progress),
    interactionState: interactionStateForStatus("running"),
    recommendedNextAction: recommendedNextActionForStatus("running"),
  };
}
