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

/** What one action answers, given the call and the manager it runs against. */
type SessionActionHandler = (
  args: CodexSessionParams,
  sessionManager: SessionManager
) => Promise<unknown> | unknown;

/** What an action that works on one session answers when the caller named none. */
function missingSessionId(action: SessionAction): { error: string; isError: true } {
  return {
    error: `Error [${ErrorCode.INVALID_ARGUMENT}]: sessionId required for '${action}'`,
    isError: true,
  };
}

/**
 * An action that works on one session: the guard answers the caller who named
 * no sessionId, so the manager is reached only with an id in hand.
 */
function onSession(
  run: (
    sessionId: string,
    args: CodexSessionParams,
    sessionManager: SessionManager
  ) => Promise<unknown> | unknown
): SessionActionHandler {
  return (args, sessionManager) =>
    args.sessionId ? run(args.sessionId, args, sessionManager) : missingSessionId(args.action);
}

/** `list` — every session of the state directory, not only the ones in memory. */
const listAction: SessionActionHandler = (_args, sessionManager) => ({
  sessions: sessionManager.listAllSessions(),
});

/** `resume` — the manager re-attaches to a session it already tracks. */
const resumeAction = onSession((sessionId, _args, sessionManager) =>
  sessionManager.resumeSession(sessionId)
);

/** `get` — one session as the manager holds it. */
const getAction = onSession((sessionId, args, sessionManager) =>
  sessionManager.getSession(sessionId, args.includeSensitive)
);

/** `cancel` — the session stops, and the answer names the session it stopped. */
const cancelAction = onSession(async (sessionId, _args, sessionManager) => {
  await sessionManager.cancelSession(sessionId);
  return { success: true, message: `Session ${sessionId} cancelled` };
});

/** `interrupt` — the running turn stops, the session stays. */
const interruptAction = onSession(async (sessionId, _args, sessionManager) => {
  await sessionManager.interruptSession(sessionId);
  return { success: true, message: `Session ${sessionId} interrupted` };
});

/** `steer` — a prompt joins the turn, so a call naming none is refused. */
const steerAction = onSession((sessionId, args, sessionManager) => {
  if (!args.prompt) {
    return {
      error: `Error [${ErrorCode.INVALID_ARGUMENT}]: prompt required for '${args.action}'`,
      isError: true,
    };
  }
  return sessionManager.steerSession(sessionId, args.prompt);
});

/** `fork` — a second session off the same thread. */
const forkAction = onSession((sessionId, _args, sessionManager) =>
  sessionManager.forkSession(sessionId)
);

/** `clean` — the sweep the caller's filters describe. */
const cleanAction: SessionActionHandler = (args, sessionManager) =>
  sessionManager.cleanSessions({
    statuses: args.statuses,
    olderThanMs: args.olderThanMs,
    dryRun: args.dryRun,
    includeDisk: args.includeDisk,
  });

/** The two background-terminal actions. Both answer `backgroundTerminals`. */
const backgroundTerminalAction = onSession(async (sessionId, args, sessionManager) => {
  if (args.action === "clean_background_terminals") {
    return {
      sessionId,
      backgroundTerminals: await sessionManager.cleanBackgroundTerminals(sessionId),
    };
  }
  if (!args.processId) {
    return {
      error: `Error [${ErrorCode.INVALID_ARGUMENT}]: processId required for '${args.action}'`,
      isError: true,
    };
  }
  return {
    sessionId,
    backgroundTerminals: await sessionManager.terminateBackgroundTerminal(
      sessionId,
      args.processId
    ),
  };
});

/** Every action the tool answers, and the branch that answers it. */
const sessionActions: Record<SessionAction, SessionActionHandler> = {
  list: listAction,
  resume: resumeAction,
  get: getAction,
  cancel: cancelAction,
  interrupt: interruptAction,
  steer: steerAction,
  fork: forkAction,
  clean: cleanAction,
  clean_background_terminals: backgroundTerminalAction,
  terminate_background_terminal: backgroundTerminalAction,
};

export async function executeCodexSession(
  args: CodexSessionParams,
  sessionManager: SessionManager
): Promise<unknown> {
  // A caller off the schema names an action the record has no key for, which
  // the key type alone does not admit: the lookup answers undefined there.
  const handler: SessionActionHandler | undefined = sessionActions[args.action];
  if (!handler) {
    return {
      error: `Error [${ErrorCode.INVALID_ARGUMENT}]: Unknown action '${args.action}'`,
      isError: true,
    };
  }
  return await handler(args, sessionManager);
}
