/** What a session reports about the turn it is running. */
import { Methods } from "../../app-server/protocol.js";
import {
  DEFAULT_POLL_INTERVAL,
  type ProgressInfo,
  type ProgressPhase,
  type ProgressTokens,
  type SessionInfo,
  type SessionStatus,
  WAITING_APPROVAL_POLL_INTERVAL,
} from "../../types.js";
import { isRecord } from "./read.js";

const REASONING_PROGRESS_METHODS = new Set<string>([
  Methods.REASONING_TEXT_DELTA,
  Methods.REASONING_SUMMARY_DELTA,
  Methods.REASONING_SUMMARY_PART_ADDED,
  Methods.PLAN_DELTA,
]);

const ACTING_PROGRESS_METHODS = new Set<string>([
  Methods.COMMAND_OUTPUT_DELTA,
  Methods.COMMAND_TERMINAL_INTERACTION,
  Methods.FILE_CHANGE_OUTPUT_DELTA,
  Methods.MCP_TOOL_PROGRESS,
  Methods.TURN_DIFF_UPDATED,
  Methods.TURN_PLAN_UPDATED,
]);

export function pollIntervalForStatus(status: SessionStatus): number | undefined {
  if (status === "waiting_approval") return WAITING_APPROVAL_POLL_INTERVAL;
  if (status === "running") return DEFAULT_POLL_INTERVAL;
  return undefined; // terminal states don't need polling
}

export function buildProgressInfo(session: SessionInfo): ProgressInfo {
  return {
    phase: deriveProgressPhase(session),
    lastEventAt: session.progressState?.lastEventAt ?? session.lastActiveAt,
    activeTurnId: session.activeTurnId,
    pendingActionCount: countPendingRequests(session),
    // Every counter the wire carries is merged into progressState as it arrives —
    // by `thread/tokenUsage/updated` and by the restore path. Re-reading the
    // finished turn here would let those older counters win over a later update.
    tokens: session.progressState?.tokens,
    activity: session.progressState?.activity,
    activitySince: session.progressState?.activityAt,
    activityStandingMs: standingMs(session.progressState?.activityAt),
  };
}

/** How long ago an ISO instant was, or undefined when there is none to measure. */
function standingMs(since: string | undefined): number | undefined {
  if (since === undefined) return undefined;
  const at = Date.parse(since);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, Date.now() - at);
}

/**
 * Session status a `thread/status/changed` notification asks for, or undefined
 * when the notification carries nothing the manager should act on.
 *
 * The pending request map decides `waiting_approval`, never the notification:
 * the status change and the approval request that goes with it are two separate
 * messages, so either one can arrive first. A wait announced while the manager
 * holds no request would park the session on an action no caller can answer,
 * and an `idle` arriving while a request is still open would hide that action.
 * Codex owns the `idle` and `systemError` edges the turn lifecycle cannot see;
 * `active` never pulls a finished session back into `running`.
 */
export function sessionStatusForThreadStatus(
  session: SessionInfo,
  statusType: string | undefined
): SessionStatus | undefined {
  if (session.status === "cancelled" || session.status === "error") return undefined;
  const waitingOnCaller = countPendingRequests(session) > 0;
  switch (statusType) {
    case "active":
      return waitingOnCaller ? "waiting_approval" : undefined;
    case "idle":
      return waitingOnCaller ? undefined : "idle";
    case "systemError":
      return "error";
    default:
      // "notLoaded" and whatever a newer codex adds: no session-side meaning.
      return undefined;
  }
}

export function countPendingRequests(session: SessionInfo): number {
  let count = 0;
  for (const req of session.pendingRequests.values()) {
    if (!req.resolved) count++;
  }
  return count;
}

function deriveProgressPhase(session: SessionInfo): ProgressPhase {
  if (session.status === "waiting_approval") return "waiting_approval";
  if (session.status === "cancelled") return "cancelled";
  if (session.status === "error") return "error";
  if (session.status === "idle") return "finished";
  if (!session.activeTurnId) return "starting";

  const lastMethod = session.progressState?.lastMethod;
  if (typeof lastMethod === "string") {
    if (REASONING_PROGRESS_METHODS.has(lastMethod)) return "reasoning";
    if (ACTING_PROGRESS_METHODS.has(lastMethod)) return "acting";
  }
  return "running";
}

export function recordProgressObservation(
  session: SessionInfo,
  method: string,
  params: Record<string, unknown>
): void {
  const next = session.progressState ?? { lastEventAt: new Date().toISOString() };
  next.lastEventAt = new Date().toISOString();
  if (method !== Methods.THREAD_TOKEN_USAGE_UPDATED) {
    next.lastMethod = method;
  }
  mergeProgressTokens(session, extractTokens(params));
  session.progressState = next;
}

function mergeProgressTokens(session: SessionInfo, tokens?: ProgressTokens): void {
  if (!tokens) return;
  const next = session.progressState ?? { lastEventAt: new Date().toISOString() };
  next.tokens = mergeTokens(next.tokens, tokens);
  session.progressState = next;
}

function mergeTokens(base?: ProgressTokens, extra?: ProgressTokens): ProgressTokens | undefined {
  if (!base && !extra) return undefined;
  return {
    input: laterToken(extra, base, "input"),
    output: laterToken(extra, base, "output"),
    total: laterToken(extra, base, "total"),
  };
}

/** The counter the update named, or the standing one where the update named none. */
function laterToken(
  extra: ProgressTokens | undefined,
  base: ProgressTokens | undefined,
  key: keyof ProgressTokens
): number | undefined {
  return extra?.[key] ?? base?.[key];
}

/**
 * Structured output of a finished turn: its final assistant message read as JSON.
 *
 * `turn/start` takes an `outputSchema` that constrains the final assistant
 * message (codex-schema/v2/TurnStartParams.json) and the protocol returns the
 * constrained value in no field of its own — the message text is it. Text that
 * is not a JSON object or array yields nothing.
 */
export function parseStructuredOutput(text?: string): unknown {
  if (typeof text !== "string") return undefined;
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * The record that carries the token counters.
 *
 * `thread/tokenUsage/updated` nests them under `tokenUsage.total` and
 * `tokenUsage.last` (codex-schema/v2/ThreadTokenUsageUpdatedNotification.json),
 * and the cumulative count wins over the last turn's. Other payloads keep the
 * counters in `usage` or in the record itself.
 */
function tokenCounterSource(value: Record<string, unknown>): Record<string, unknown> {
  const tokenUsage = isRecord(value.tokenUsage) ? value.tokenUsage : undefined;
  if (tokenUsage) {
    const nested = pickRecord(tokenUsage, ["total", "last"]);
    if (nested) return nested;
  }
  return isRecord(value.usage) ? value.usage : value;
}

function pickRecord(
  source: Record<string, unknown>,
  keys: string[]
): Record<string, unknown> | undefined {
  for (const key of keys) {
    const value = source[key];
    if (isRecord(value)) return value;
  }
  return undefined;
}

export function extractTokens(value: unknown): ProgressTokens | undefined {
  if (!isRecord(value)) return undefined;

  const source = tokenCounterSource(value);
  const input = pickNumber(source, [
    "inputTokens",
    "input_tokens",
    "promptTokens",
    "prompt_tokens",
  ]);
  const output = pickNumber(source, [
    "outputTokens",
    "output_tokens",
    "completionTokens",
    "completion_tokens",
  ]);
  const total = pickNumber(source, [
    "totalTokens",
    "total_tokens",
    "tokenCount",
    "token_count",
    "total",
  ]);

  if (typeof input !== "number" && typeof output !== "number" && typeof total !== "number") {
    return undefined;
  }

  return { input, output, total };
}

function pickNumber(source: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}
