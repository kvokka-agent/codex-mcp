/**
 * codex_reply tool — continue an existing session.
 *
 * Like `codex`, it returns as soon as the turn is under way; the turn is
 * followed with `codex_check(action="poll", waitMs=…)`.
 */
import type { SessionManager } from "../session/manager.js";
import type {
  ApprovalPolicy,
  EffortLevel,
  Personality,
  ProgressInfo,
  SandboxMode,
  SessionStartResult,
  SummaryMode,
} from "../types.js";
import {
  coerceProgressForStatus,
  interactionStateForStatus,
  recommendedNextActionForStatus,
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
}

export type CodexReplyResult = SessionStartResult;

export async function executeCodexReply(
  args: CodexReplyParams,
  sessionManager: SessionManager
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

  return {
    ...startResult,
    progress: coerceProgressForStatus(
      "running",
      safeGetProgress(sessionManager, startResult.sessionId) ?? startResult.progress
    ),
    interactionState: interactionStateForStatus("running"),
    recommendedNextAction: recommendedNextActionForStatus("running"),
  };
}
