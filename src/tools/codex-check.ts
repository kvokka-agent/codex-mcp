/**
 * codex_check tool — report session status and answer what it waits for.
 */
import type { SessionManager } from "../session/manager.js";
import {
  ALL_DECISIONS,
  type ApprovalDecision,
  type CheckAction,
  type CheckResult,
  ErrorCode,
  MAX_LONG_POLL_WAIT_MS,
  type NetworkPolicyAmendment,
  type SessionSignal,
} from "../types.js";
import { PollWindow } from "../utils/poll-window.js";
import {
  activityLine,
  heartbeatIntervalMs,
  type ProgressReporter,
} from "../utils/progress-notifier.js";

export interface CodexCheckParams {
  action: CheckAction;
  sessionId: string;
  /** poll: block up to this many ms for a change the caller acts on. */
  waitMs?: number;
  // respond_permission params
  requestId?: string;
  decision?: ApprovalDecision;
  execpolicy_amendment?: string[];
  network_policy_amendment?: NetworkPolicyAmendment;
  denyMessage?: string;
  // respond_user_input params
  answers?: Record<string, { answers: string[] }>;
}

export type CodexCheckReturn =
  | CheckResult
  | { error: string; isError: true }
  | Promise<CheckResult | { error: string; isError: true }>;

/** What the tool answers with instead of a status when the arguments do not hold. */
type CheckRejection = { error: string; isError: true };

export function executeCodexCheck(
  args: CodexCheckParams,
  sessionManager: SessionManager,
  requestSignal?: AbortSignal,
  pollWindow: PollWindow = new PollWindow(),
  progress?: ProgressReporter,
  heartbeatMs: number = heartbeatIntervalMs()
): CodexCheckReturn {
  switch (args.action) {
    case "poll":
      return pollAction(args, sessionManager, requestSignal, pollWindow, progress, heartbeatMs);

    case "respond_permission":
      return respondPermission(args, sessionManager);

    case "respond_user_input":
      return respondUserInput(args, sessionManager);

    default:
      return {
        error: `Error [${ErrorCode.INVALID_ARGUMENT}]: Unknown action '${args.action}'`,
        isError: true,
      };
  }
}

function pollAction(
  args: CodexCheckParams,
  sessionManager: SessionManager,
  requestSignal: AbortSignal | undefined,
  pollWindow: PollWindow,
  progress: ProgressReporter | undefined,
  heartbeatMs: number
): CodexCheckReturn {
  if (
    args.requestId !== undefined ||
    args.decision !== undefined ||
    args.execpolicy_amendment !== undefined ||
    args.network_policy_amendment !== undefined ||
    args.denyMessage !== undefined ||
    args.answers !== undefined
  ) {
    return {
      error: `Error [${ErrorCode.INVALID_ARGUMENT}]: requestId/decision/execpolicy_amendment/network_policy_amendment/denyMessage/answers are only valid for respond_* actions`,
      isError: true,
    };
  }

  const waitMs = args.waitMs;
  const budgetMs = pollWindow.budgetMs();
  if (typeof waitMs === "number" && waitMs > 0 && budgetMs > 0) {
    return pollWithWait(
      sessionManager,
      args.sessionId,
      Math.min(waitMs, MAX_LONG_POLL_WAIT_MS, budgetMs),
      requestSignal,
      pollWindow,
      progress,
      heartbeatMs
    );
  }

  return sessionManager.pollStatus(args.sessionId);
}

function rejectExecpolicyAmendment(args: CodexCheckParams): CheckRejection | undefined {
  if (args.decision === "acceptWithExecpolicyAmendment") {
    if (!args.execpolicy_amendment || args.execpolicy_amendment.length === 0) {
      return {
        error: `Error [${ErrorCode.INVALID_ARGUMENT}]: execpolicy_amendment required for acceptWithExecpolicyAmendment`,
        isError: true,
      };
    }
  } else if (args.execpolicy_amendment !== undefined) {
    return {
      error: `Error [${ErrorCode.INVALID_ARGUMENT}]: execpolicy_amendment is only valid with decision='acceptWithExecpolicyAmendment'`,
      isError: true,
    };
  }
  return undefined;
}

function rejectNetworkPolicyAmendment(args: CodexCheckParams): CheckRejection | undefined {
  if (args.decision === "applyNetworkPolicyAmendment") {
    if (!args.network_policy_amendment) {
      return {
        error: `Error [${ErrorCode.INVALID_ARGUMENT}]: network_policy_amendment required for applyNetworkPolicyAmendment`,
        isError: true,
      };
    }
    if (
      args.network_policy_amendment.action !== "allow" &&
      args.network_policy_amendment.action !== "deny"
    ) {
      return {
        error: `Error [${ErrorCode.INVALID_ARGUMENT}]: network_policy_amendment.action must be 'allow' or 'deny'`,
        isError: true,
      };
    }
    if (!args.network_policy_amendment.host) {
      return {
        error: `Error [${ErrorCode.INVALID_ARGUMENT}]: network_policy_amendment.host required for applyNetworkPolicyAmendment`,
        isError: true,
      };
    }
  } else if (args.network_policy_amendment !== undefined) {
    return {
      error: `Error [${ErrorCode.INVALID_ARGUMENT}]: network_policy_amendment is only valid with decision='applyNetworkPolicyAmendment'`,
      isError: true,
    };
  }
  return undefined;
}

function respondPermission(
  args: CodexCheckParams,
  sessionManager: SessionManager
): CheckResult | CheckRejection {
  if (!args.requestId || !args.decision) {
    return {
      error: `Error [${ErrorCode.INVALID_ARGUMENT}]: requestId and decision required for respond_permission`,
      isError: true,
    };
  }
  if (args.answers !== undefined) {
    return {
      error: `Error [${ErrorCode.INVALID_ARGUMENT}]: answers is only valid for respond_user_input`,
      isError: true,
    };
  }
  const badExecpolicy = rejectExecpolicyAmendment(args);
  if (badExecpolicy) return badExecpolicy;

  const badNetworkPolicy = rejectNetworkPolicyAmendment(args);
  if (badNetworkPolicy) return badNetworkPolicy;

  if (!ALL_DECISIONS.includes(args.decision)) {
    return {
      error: `Error [${ErrorCode.INVALID_ARGUMENT}]: Unknown decision '${args.decision}'`,
      isError: true,
    };
  }
  try {
    sessionManager.resolveApproval(args.sessionId, args.requestId, args.decision, {
      execpolicy_amendment: args.execpolicy_amendment,
      network_policy_amendment: args.network_policy_amendment,
      denyMessage: args.denyMessage,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: message, isError: true };
  }
  return sessionManager.pollStatus(args.sessionId);
}

function respondUserInput(
  args: CodexCheckParams,
  sessionManager: SessionManager
): CheckResult | CheckRejection {
  if (!args.requestId || !args.answers) {
    return {
      error: `Error [${ErrorCode.INVALID_ARGUMENT}]: requestId and answers required for respond_user_input`,
      isError: true,
    };
  }
  if (
    args.decision !== undefined ||
    args.execpolicy_amendment !== undefined ||
    args.network_policy_amendment !== undefined ||
    args.denyMessage !== undefined
  ) {
    return {
      error: `Error [${ErrorCode.INVALID_ARGUMENT}]: decision/execpolicy_amendment/network_policy_amendment/denyMessage are only valid for respond_permission`,
      isError: true,
    };
  }
  try {
    sessionManager.resolveUserInput(args.sessionId, args.requestId, args.answers);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: message, isError: true };
  }
  return sessionManager.pollStatus(args.sessionId);
}

/**
 * Hold the call until the session moves, and answer with where it stands.
 *
 * A status change, a new action to answer, the end of the turn and a new line
 * saying what Codex is doing each return at once; the delta and token-counter
 * traffic in between returns nothing, and a window in which none of them
 * happened returns the status it started with, because the client will not hold
 * the call any longer. `waitedMs` on the answer says which of the two it was.
 *
 * The same lines also travel out of the call while it is still held, as
 * `notifications/progress`, together with a heartbeat repeating the standing
 * line and how long it has stood.
 */
async function pollWithWait(
  sessionManager: SessionManager,
  sessionId: string,
  waitMs: number,
  signal: AbortSignal | undefined,
  pollWindow: PollWindow,
  progress?: ProgressReporter,
  heartbeatMs = 0
): Promise<CheckResult> {
  const startedAt = Date.now();
  const deadline = startedAt + waitMs;
  const state = sessionManager.getSessionSignal(sessionId);

  const stopReporting = startReporting(sessionManager, sessionId, startedAt, heartbeatMs, progress);
  try {
    await waitForSessionToMove(sessionManager, sessionId, state, deadline, signal);

    if (signal?.aborted) {
      recordClientCut(pollWindow, Date.now() - startedAt, signal);
    }

    return { ...sessionManager.pollStatus(sessionId), waitedMs: Date.now() - startedAt };
  } finally {
    stopReporting();
  }
}

/**
 * Wait while the session still stands where `from` found it, up to `deadline`.
 */
async function waitForSessionToMove(
  sessionManager: SessionManager,
  sessionId: string,
  from: SessionSignal,
  deadline: number,
  signal: AbortSignal | undefined
): Promise<void> {
  let state = from;
  const baseline = state.key;

  while (!state.awaitsCaller && state.key === baseline && !signal?.aborted) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;

    // waitForChange registers its notifier synchronously, so no state change can
    // land between the read above and the registration: a notification either
    // preceded the read (and is in `state`) or wakes this waiter.
    try {
      await sessionManager.waitForChange(sessionId, remainingMs, signal);
    } catch (err: unknown) {
      // Timeout, abort and notification all resolve; the only rejection is a
      // session whose waiter slots are full. Looping on that re-rejects with no
      // delay and burns the rest of the wait window, so the long poll degrades
      // to one immediate read and lets the caller retry later.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[codex-mcp] Long-poll wait refused for session '${sessionId}': ${message}`);
      break;
    }

    state = sessionManager.getSessionSignal(sessionId);
  }
}

/**
 * The client cut this call, so the SDK drops whatever the handler returns rather
 * than sending it. The answer is not lost with it: every later check of a
 * terminal session carries the result again.
 */
function recordClientCut(pollWindow: PollWindow, heldMs: number, signal: AbortSignal): void {
  const ceilingBefore = pollWindow.ceilingMs();
  pollWindow.recordCut(heldMs, signal.reason);
  if (pollWindow.ceilingMs() !== ceilingBefore) {
    console.error(
      `[codex-mcp] The MCP client cut a long poll after ${heldMs}ms; polls now answer within ${pollWindow.budgetMs()}ms.`
    );
  }
}

/**
 * Tell the client what the turn is doing for as long as the call is held: the
 * line it is on now, each new line as it arrives, and that line again every
 * `heartbeatMs` with how long it has stood.
 *
 * The heartbeat is what a person watching a long turn reads, and it is also
 * what keeps a client's idle watchdog from ending a call that has said nothing.
 * A caller that sent no progress token is told nothing and needs no timer.
 */
function startReporting(
  sessionManager: SessionManager,
  sessionId: string,
  startedAt: number,
  heartbeatMs: number,
  progress?: ProgressReporter
): () => void {
  if (!progress) return () => {};

  const reportStanding = (): void => {
    try {
      progress.report(activityLine(sessionManager.getProgress(sessionId), Date.now() - startedAt));
    } catch (err: unknown) {
      // The session went out from under the held call. The poll itself reports
      // that, and a line invented here would say the turn is still alive.
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[codex-mcp] Progress heartbeat stopped for session '${sessionId}': ${message}`
      );
    }
  };

  // The line the session is already on, so a caller that starts polling
  // mid-turn reads what is happening now rather than waiting for the change.
  reportStanding();
  const stopListening = sessionManager.onActivity(sessionId, (activity) =>
    progress.report(activity)
  );
  if (heartbeatMs <= 0) return stopListening;

  const timer = setInterval(reportStanding, heartbeatMs);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    stopListening();
  };
}
