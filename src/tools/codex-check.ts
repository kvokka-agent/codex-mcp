/**
 * codex_check tool — report session status and answer what it waits for.
 */
import type { SessionManager } from "../session/manager.js";
import { PollWindow } from "../utils/poll-window.js";
import type { ProgressReporter } from "../utils/progress-notifier.js";
import {
  ALL_DECISIONS,
  ErrorCode,
  MAX_LONG_POLL_WAIT_MS,
  type NetworkPolicyAmendment,
  type ApprovalDecision,
  type CheckAction,
  type CheckResult,
} from "../types.js";

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

export function executeCodexCheck(
  args: CodexCheckParams,
  sessionManager: SessionManager,
  requestSignal?: AbortSignal,
  pollWindow: PollWindow = new PollWindow(),
  progress?: ProgressReporter
): CodexCheckReturn {
  switch (args.action) {
    case "poll": {
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
          progress
        );
      }

      return sessionManager.pollStatus(args.sessionId);
    }

    case "respond_permission": {
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

    case "respond_user_input": {
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

    default:
      return {
        error: `Error [${ErrorCode.INVALID_ARGUMENT}]: Unknown action '${args.action}'`,
        isError: true,
      };
  }
}

/**
 * Hold the call until the session state the caller acts on moves.
 *
 * A status change, a new action to answer and the end of the turn return at
 * once; the delta and token-counter traffic in between returns nothing, and a
 * window in which none of the three happened returns the status it started
 * with, because the client will not hold the call any longer.
 *
 * What the turn says it is doing travels out of the held call as it happens, as
 * `notifications/progress`. It does not end the wait: the caller answers
 * statuses and actions, and an activity line is neither.
 */
async function pollWithWait(
  sessionManager: SessionManager,
  sessionId: string,
  waitMs: number,
  signal: AbortSignal | undefined,
  pollWindow: PollWindow,
  progress?: ProgressReporter
): Promise<CheckResult> {
  const startedAt = Date.now();
  const deadline = startedAt + waitMs;
  let state = sessionManager.getSessionSignal(sessionId);
  const baseline = state.key;

  let stopReporting: (() => void) | undefined;
  if (progress) {
    // The line the session is already on, so a caller that starts polling
    // mid-turn reads what is happening now rather than waiting for the change.
    const current = sessionManager.getProgress(sessionId).activity;
    if (current !== undefined) progress.report(current);
    stopReporting = sessionManager.onActivity(sessionId, (activity) => progress.report(activity));
  }
  try {
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

    if (signal?.aborted) {
      // The client cut this call, so the SDK drops whatever the handler returns
      // rather than sending it. The answer is not lost with it: every later check
      // of a terminal session carries the result again.
      const heldMs = Date.now() - startedAt;
      const ceilingBefore = pollWindow.ceilingMs();
      pollWindow.recordCut(heldMs, signal.reason);
      if (pollWindow.ceilingMs() !== ceilingBefore) {
        console.error(
          `[codex-mcp] The MCP client cut a long poll after ${heldMs}ms; polls now answer within ${pollWindow.budgetMs()}ms.`
        );
      }
    }

    return sessionManager.pollStatus(sessionId);
  } finally {
    stopReporting?.();
  }
}
