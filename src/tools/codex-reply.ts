/**
 * codex_reply tool — continue an existing session.
 *
 * Like `codex`, it returns as soon as the turn is under way; the turn is
 * followed with `codex_check(action="poll", waitMs=…)`.
 */
import type { SessionManager } from "../session/manager/session-manager.js";
import type {
  ApprovalPolicy,
  ApprovalsReviewer,
  EffortLevel,
  Personality,
  SandboxMode,
  SessionStartResult,
  SummaryMode,
} from "../types.js";
import { startedTurnResult } from "../utils/execution.js";

export interface CodexReplyParams {
  sessionId: string;
  prompt: string;
  model?: string;
  approvalPolicy?: ApprovalPolicy;
  approvalsReviewer?: ApprovalsReviewer;
  permissions?: string;
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
    approvalsReviewer: args.approvalsReviewer,
    permissions: args.permissions,
    effort: args.effort,
    summary: args.summary,
    personality: args.personality,
    sandbox: args.sandbox,
    cwd: args.cwd,
    outputSchema: args.outputSchema,
  });

  return startedTurnResult(sessionManager, startResult);
}
