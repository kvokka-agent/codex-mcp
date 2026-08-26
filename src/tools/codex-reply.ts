/**
 * codex_reply tool — continue an existing session.
 */
import type { SessionManager } from "../session/manager.js";
import type {
  ApprovalPolicy,
  ExecutionInfo,
  EffortLevel,
  InteractionState,
  ProgressInfo,
  Personality,
  RecommendedNextAction,
  SandboxMode,
  SessionStatus,
  SessionStartResult,
  SummaryMode,
} from "../types.js";
import { WAITING_APPROVAL_POLL_INTERVAL } from "../types.js";
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

export interface CodexReplyParams {
  sessionId: string;
  prompt: string;
  model?: string;
  approvalPolicy?: ApprovalPolicy;
  effort?: EffortLevel;
  summary?: SummaryMode;
  personality?: Personality;
  sandbox?: SandboxMode;
  cwd?: string;
  outputSchema?: Record<string, unknown>;
  waitForResult?: number;
}

export type CodexReplyResult =
  | (SessionStartResult & {
      execution?: ExecutionInfo;
      interactionState?: InteractionState;
      recommendedNextAction?: RecommendedNextAction;
    })
  | {
      sessionId: string;
      threadId: string;
      status: SessionStatus;
      pollInterval?: number;
      result?: import("../types.js").TurnResult;
      completedAt?: string;
      compatWarnings?: string[];
      progress?: ProgressInfo;
      execution?: ExecutionInfo;
      interactionState?: InteractionState;
      recommendedNextAction?: RecommendedNextAction;
    };

export async function executeCodexReply(
  args: CodexReplyParams,
  sessionManager: SessionManager,
  requestSignal?: AbortSignal
): Promise<CodexReplyResult> {
  const startResult = await sessionManager.replyToSession(args.sessionId, args.prompt, {
    model: args.model,
    approvalPolicy: args.approvalPolicy,
    effort: args.effort,
    summary: args.summary,
    personality: args.personality,
    sandbox: args.sandbox,
    cwd: args.cwd,
    outputSchema: args.outputSchema,
  });

  const waitMs = args.waitForResult;
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

  if (!waitMs || waitMs <= 0) {
    return baseResult;
  }

  const foreground = await waitForCodexSessionForegroundResult(
    sessionManager,
    startResult.sessionId,
    waitMs,
    requestSignal
  );
  return {
    sessionId: startResult.sessionId,
    threadId: startResult.threadId,
    status: foreground.status,
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
    result: foreground.result,
    completedAt: foreground.completedAt,
    execution: buildExecutionInfo(waitMs, foreground.status, foreground.fallbackReason),
    interactionState: interactionStateForStatus(foreground.status),
    recommendedNextAction: recommendedNextActionForStatus(
      foreground.status,
      foreground.pendingActionTypes ?? []
    ),
  };
}
