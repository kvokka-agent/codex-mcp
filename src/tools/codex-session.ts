/**
 * codex_session tool — manage sessions
 * (list/get/resume/cancel/interrupt/fork/clean/clean_background_terminals).
 */
import type { SessionManager } from "../session/manager.js";
import { ErrorCode, type CleanableStatus, type SessionAction } from "../types.js";

export interface CodexSessionParams {
  action: SessionAction;
  sessionId?: string;
  includeSensitive?: boolean;
  statuses?: CleanableStatus[];
  olderThanMs?: number;
  dryRun?: boolean;
  includeDisk?: boolean;
}

export async function executeCodexSession(
  args: CodexSessionParams,
  sessionManager: SessionManager
): Promise<unknown> {
  switch (args.action) {
    case "list":
      return { sessions: sessionManager.listAllSessions() };

    case "resume":
      if (!args.sessionId) {
        return {
          error: `Error [${ErrorCode.INVALID_ARGUMENT}]: sessionId required for 'resume'`,
          isError: true,
        };
      }
      return await sessionManager.resumeSession(args.sessionId);

    case "get":
      if (!args.sessionId) {
        return {
          error: `Error [${ErrorCode.INVALID_ARGUMENT}]: sessionId required for 'get'`,
          isError: true,
        };
      }
      return sessionManager.getSession(args.sessionId, args.includeSensitive);

    case "cancel":
      if (!args.sessionId) {
        return {
          error: `Error [${ErrorCode.INVALID_ARGUMENT}]: sessionId required for 'cancel'`,
          isError: true,
        };
      }
      await sessionManager.cancelSession(args.sessionId);
      return { success: true, message: `Session ${args.sessionId} cancelled` };

    case "interrupt":
      if (!args.sessionId) {
        return {
          error: `Error [${ErrorCode.INVALID_ARGUMENT}]: sessionId required for 'interrupt'`,
          isError: true,
        };
      }
      await sessionManager.interruptSession(args.sessionId);
      return { success: true, message: `Session ${args.sessionId} interrupted` };

    case "fork":
      if (!args.sessionId) {
        return {
          error: `Error [${ErrorCode.INVALID_ARGUMENT}]: sessionId required for 'fork'`,
          isError: true,
        };
      }
      return await sessionManager.forkSession(args.sessionId);

    case "clean":
      return await sessionManager.cleanSessions({
        statuses: args.statuses,
        olderThanMs: args.olderThanMs,
        dryRun: args.dryRun,
        includeDisk: args.includeDisk,
      });

    case "clean_background_terminals":
      if (!args.sessionId) {
        return {
          error: `Error [${ErrorCode.INVALID_ARGUMENT}]: sessionId required for 'clean_background_terminals'`,
          isError: true,
        };
      }
      await sessionManager.cleanBackgroundTerminals(args.sessionId);
      return {
        success: true,
        message: `Background terminals cleaned for session ${args.sessionId}`,
      };

    default:
      return {
        error: `Error [${ErrorCode.INVALID_ARGUMENT}]: Unknown action '${args.action}'`,
        isError: true,
      };
  }
}
