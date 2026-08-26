/**
 * codex tool — start a new Codex agent session.
 */
import type { SessionManager } from "../session/manager.js";
import type {
  ExecutionInfo,
  InteractionState,
  ProgressInfo,
  RecommendedNextAction,
  SessionStatus,
  SessionStartResult,
  TurnResult,
} from "../types.js";
import { DEFAULT_EFFORT_LEVEL, WAITING_APPROVAL_POLL_INTERVAL } from "../types.js";
import type { CodexToolParams } from "../utils/config.js";
import { extractSpawnOptions } from "../utils/config.js";
import { resolveAndValidateCwd } from "../utils/cwd.js";
import {
  buildExecutionInfo,
  coerceProgressForStatus,
  interactionStateForStatus,
  recommendedNextActionForStatus,
  waitForCodexSessionForegroundResult,
} from "../utils/execution.js";

function safeGetProgress(
  sessionManager: SessionManager,
  sessionId: string
): ProgressInfo | undefined {
  return typeof (sessionManager as SessionManager & { getProgress?: unknown }).getProgress ===
    "function"
    ? (
        sessionManager as SessionManager & { getProgress: (id: string) => ProgressInfo }
      ).getProgress(sessionId)
    : undefined;
}

export type CodexCompletedResult = {
  sessionId: string;
  threadId: string;
  result: TurnResult | undefined;
  status: SessionStatus;
  completedAt?: string;
  pollInterval?: number;
  compatWarnings?: string[];
  progress?: ProgressInfo;
  execution?: ExecutionInfo;
  interactionState?: InteractionState;
  recommendedNextAction?: RecommendedNextAction;
};

export async function executeCodex(
  args: CodexToolParams,
  sessionManager: SessionManager,
  serverCwd: string,
  requestSignal?: AbortSignal
): Promise<SessionStartResult | CodexCompletedResult> {
  const cwd = resolveAndValidateCwd(args.cwd, serverCwd);
  const spawnOpts = extractSpawnOptions(args);
  const effort = args.effort ?? DEFAULT_EFFORT_LEVEL;

  const startResult = await sessionManager.createSession(
    args.prompt,
    cwd,
    spawnOpts,
    effort,
    args.advanced
  );

  const waitMs = args.advanced?.waitForResult;
  const baseResult: SessionStartResult & {
    execution?: ExecutionInfo;
    interactionState?: InteractionState;
    recommendedNextAction?: RecommendedNextAction;
  } = {
    ...startResult,
    progress: coerceProgressForStatus(
      "running",
      safeGetProgress(sessionManager, startResult.sessionId) ?? startResult.progress
    ),
    execution: buildExecutionInfo(waitMs, "running"),
    interactionState: interactionStateForStatus("running"),
    recommendedNextAction: recommendedNextActionForStatus("running"),
  };

  if (!waitMs || waitMs <= 0) return baseResult;

  const foreground = await waitForCodexSessionForegroundResult(
    sessionManager,
    startResult.sessionId,
    waitMs,
    requestSignal
  );
  return {
    sessionId: startResult.sessionId,
    threadId: startResult.threadId,
    result: foreground.result,
    status: foreground.status,
    completedAt: foreground.completedAt,
    compatWarnings: startResult.compatWarnings,
    progress: coerceProgressForStatus(
      foreground.status,
      safeGetProgress(sessionManager, startResult.sessionId) ?? startResult.progress,
      {
        completedAt: foreground.completedAt,
        pendingActionCount: foreground.pendingActionTypes?.length ?? 0,
      }
    ),
    pollInterval:
      foreground.status === "waiting_approval"
        ? WAITING_APPROVAL_POLL_INTERVAL
        : foreground.status === "running"
          ? startResult.pollInterval
          : undefined,
    execution: buildExecutionInfo(waitMs, foreground.status, foreground.fallbackReason),
    interactionState: interactionStateForStatus(foreground.status),
    recommendedNextAction: recommendedNextActionForStatus(
      foreground.status,
      foreground.pendingActionTypes ?? []
    ),
  };
}
