/**
 * codex_session tool — manage sessions (list/get/resume/cancel/interrupt/steer/
 * fork/clean/clean_background_terminals/terminate_background_terminal).
 */
import type { SessionManager } from "../session/manager/session-manager.js";
import { type CleanableStatus, ErrorCode, type SessionAction } from "../types/index.js";

export interface CodexSessionParams {
  action: SessionAction;
  sessionId?: string;
  includeSensitive?: boolean;
  statuses?: CleanableStatus[];
  olderThanMs?: number;
  dryRun?: boolean;
  includeDisk?: boolean;
  processId?: string;
  prompt?: string;
}

/** What an action that works on one session answers when the caller named none. */
function missingSessionId(action: SessionAction): { error: string; isError: true } {
  return {
    error: `Error [${ErrorCode.INVALID_ARGUMENT}]: sessionId required for '${action}'`,
    isError: true,
  };
}

/** The two background-terminal actions. Both answer `backgroundTerminals`. */
async function backgroundTerminalAction(
  args: CodexSessionParams,
  sessionManager: SessionManager
): Promise<unknown> {
  if (!args.sessionId) return missingSessionId(args.action);
  if (args.action === "clean_background_terminals") {
    return {
      sessionId: args.sessionId,
      backgroundTerminals: await sessionManager.cleanBackgroundTerminals(args.sessionId),
    };
  }
  if (!args.processId) {
    return {
      error: `Error [${ErrorCode.INVALID_ARGUMENT}]: processId required for '${args.action}'`,
      isError: true,
    };
  }
  return {
    sessionId: args.sessionId,
    backgroundTerminals: await sessionManager.terminateBackgroundTerminal(
      args.sessionId,
      args.processId
    ),
  };
}

export async function executeCodexSession(
  args: CodexSessionParams,
  sessionManager: SessionManager
): Promise<unknown> {
  switch (args.action) {
    case "list":
      return { sessions: sessionManager.listAllSessions() };

    case "resume":
      if (!args.sessionId) return missingSessionId(args.action);
      return await sessionManager.resumeSession(args.sessionId);

    case "get":
      if (!args.sessionId) return missingSessionId(args.action);
      return sessionManager.getSession(args.sessionId, args.includeSensitive);

    case "cancel":
      if (!args.sessionId) return missingSessionId(args.action);
      await sessionManager.cancelSession(args.sessionId);
      return { success: true, message: `Session ${args.sessionId} cancelled` };

    case "interrupt":
      if (!args.sessionId) return missingSessionId(args.action);
      await sessionManager.interruptSession(args.sessionId);
      return { success: true, message: `Session ${args.sessionId} interrupted` };

    case "steer": {
      if (!args.sessionId) return missingSessionId(args.action);
      if (!args.prompt) {
        return {
          error: `Error [${ErrorCode.INVALID_ARGUMENT}]: prompt required for '${args.action}'`,
          isError: true,
        };
      }
      return await sessionManager.steerSession(args.sessionId, args.prompt);
    }

    case "fork":
      if (!args.sessionId) return missingSessionId(args.action);
      return await sessionManager.forkSession(args.sessionId);

    case "clean":
      return await sessionManager.cleanSessions({
        statuses: args.statuses,
        olderThanMs: args.olderThanMs,
        dryRun: args.dryRun,
        includeDisk: args.includeDisk,
      });

    case "clean_background_terminals":
    case "terminate_background_terminal":
      return await backgroundTerminalAction(args, sessionManager);

    default:
      return {
        error: `Error [${ErrorCode.INVALID_ARGUMENT}]: Unknown action '${args.action}'`,
        isError: true,
      };
  }
}
