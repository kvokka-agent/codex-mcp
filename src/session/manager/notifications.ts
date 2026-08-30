/** Where each notification of a thread and its turns is acted on. */
import { Methods } from "../../app-server/protocol.js";
import type { SessionEventType, SessionInfo } from "../../types.js";
import { redactPaths } from "../../utils/redact.js";
import { stripActivityMarkers, stripActivityMarkersFromTurn } from "../activity-marker.js";
import type { SessionRuntime } from "./core.js";
import { recordEvent, scannerOf } from "./events.js";
import {
  onAgentMessageDelta,
  onAutoApprovalReviewCompleted,
  onCommandOutputDelta,
  onHookNotification,
  onSafetyBufferingUpdated,
  onWarningNotification,
} from "./notifications-stream.js";
import { parseStructuredOutput, sessionStatusForThreadStatus } from "./progress.js";
import { isRecord, normalizeOptionalString } from "./read.js";
import { persistResult, persistSessionIfChanged } from "./store.js";
import { turnIdOfCompleted } from "./turn-params.js";

/**
 * The notifications that go into the event log as progress and move nothing else.
 *
 * None of them is a failure, so they stay out of the "error" type and leave the
 * session status alone.
 */
const PLAIN_PROGRESS_METHODS = new Set<string>([
  Methods.THREAD_ARCHIVED,
  Methods.THREAD_UNARCHIVED,
  Methods.THREAD_NAME_UPDATED,
  Methods.THREAD_TOKEN_USAGE_UPDATED,
  Methods.FUZZY_FILE_SEARCH_SESSION_UPDATED,
  Methods.FUZZY_FILE_SEARCH_SESSION_COMPLETED,
  Methods.WINDOWS_WORLD_WRITABLE_WARNING,
  Methods.ACCOUNT_LOGIN_COMPLETED,
  Methods.COMMAND_TERMINAL_INTERACTION,
  Methods.FILE_CHANGE_OUTPUT_DELTA,
  Methods.REASONING_TEXT_DELTA,
  Methods.REASONING_SUMMARY_DELTA,
  Methods.REASONING_SUMMARY_PART_ADDED,
  Methods.PLAN_DELTA,
  Methods.MCP_TOOL_PROGRESS,
  Methods.AUTO_APPROVAL_REVIEW_STARTED,
  Methods.AUTO_APPROVAL_REVIEW_STRICT_REQUIRED,
  Methods.TURN_DIFF_UPDATED,
  Methods.TURN_PLAN_UPDATED,
  Methods.MODEL_REROUTED,
  Methods.THREAD_CLOSED,
  Methods.THREAD_COMPACTED,
  Methods.DEPRECATION_NOTICE,
  Methods.CONFIG_WARNING,
]);

/** `thread/started` — the notification that carries the real thread id. */
function onThreadStarted(
  runtime: SessionRuntime,
  session: SessionInfo,
  method: string,
  p: Record<string, unknown>
): void {
  const thread = isRecord(p.thread) ? p.thread : undefined;
  const notifiedThreadId =
    normalizeOptionalString(p.threadId) ?? normalizeOptionalString(thread?.id);
  if (notifiedThreadId && notifiedThreadId !== session.threadId) {
    session.threadId = notifiedThreadId;
    persistSessionIfChanged(runtime, session);
  }
  // Thread.status is a ThreadStatus union object whose variant is named
  // by `type` — "notLoaded" | "idle" | "systemError" | "active"
  // (codex-schema/v2/ThreadStartedNotification.json → Thread.status →
  // ThreadStatus), the same shape `thread/status/changed` carries.
  const threadStatus = isRecord(thread?.status) ? thread.status : undefined;
  recordEvent(session, "progress", {
    method,
    ...p,
    threadId: notifiedThreadId,
    status: normalizeOptionalString(threadStatus?.type),
  });
}

/** `turn/started` — the notification that opens a turn and clears the last activity. */
function onTurnStarted(session: SessionInfo, method: string, p: Record<string, unknown>): void {
  const turnObj = p.turn as Record<string, unknown> | undefined;
  const status = normalizeOptionalString(turnObj?.status);
  session.activeTurnId = normalizeOptionalString(turnObj?.id);
  // The new turn has not said what it is doing yet, and the line the
  // previous one left would read as if it had.
  scannerOf(session).reset();
  if (session.progressState) {
    session.progressState.activity = undefined;
    session.progressState.activityAt = undefined;
    session.progressState.activityFromHook = undefined;
  }
  recordEvent(session, "progress", {
    method,
    ...p,
    turnId: session.activeTurnId,
    status,
  });
}

/** `turn/completed` — the notification that writes `lastResult`. */
function onTurnCompleted(
  runtime: SessionRuntime,
  session: SessionInfo,
  method: string,
  p: Record<string, unknown>
): void {
  const turnObj = p.turn as Record<string, unknown> | undefined;
  const completedTurnId = turnIdOfCompleted(session, turnObj);
  const finalText = session.lastAgentMessageText;
  const askedForSchema = runtime.schemaConstrainedTurns.delete(session.sessionId);
  session.status = "idle";
  session.activeTurnId = undefined;
  session.lastResult = {
    turnId: completedTurnId,
    outcome: "completed",
    text: finalText,
    structuredOutput: askedForSchema ? parseStructuredOutput(finalText) : undefined,
    // The turn record carries the assistant text a second time, in
    // `items[].text`, and that copy has seen no stripping.
    turn: stripActivityMarkersFromTurn(p.turn),
    status: turnObj?.status as string | undefined,
    turnError: turnObj?.error,
    completedAt: new Date().toISOString(),
  };
  recordEvent(session, "result", {
    method,
    ...p,
    turnId: completedTurnId,
    status: normalizeOptionalString(turnObj?.status),
  });
  // Persist idle status + result to disk
  persistSessionIfChanged(runtime, session);
  persistResult(runtime, session);
}

/** `error` — a failure, or a reconnect when the server says it will retry. */
function onErrorNotification(
  runtime: SessionRuntime,
  session: SessionInfo,
  method: string,
  p: Record<string, unknown>
): void {
  const willRetry = p.willRetry as boolean;
  if (!willRetry) {
    session.status = "error";
  }
  const data: Record<string, unknown> = { method, ...p };
  // The notification carries `[error, threadId, turnId, willRetry]` and
  // no text of its own (codex-schema/v2/ErrorNotification.json).
  // ErrorNotification.error is a TurnError object whose `message` carries the
  // text; a bare string arrives from builds predating that shape.
  if (typeof data.error === "string") {
    data.error = redactPaths(data.error);
  } else if (isRecord(data.error) && typeof data.error.message === "string") {
    data.error = { ...data.error, message: redactPaths(data.error.message) };
  }
  if (willRetry) {
    recordEvent(session, "progress", {
      ...data,
      method: "codex-mcp/reconnect",
      sourceMethod: method,
      phase: "retrying",
    });
    return;
  }
  recordEvent(session, "error", data);
  // Persist error status to disk
  persistSessionIfChanged(runtime, session);
}

/** `thread/status/changed` — the notification that moves the session status. */
function onThreadStatusChanged(
  runtime: SessionRuntime,
  session: SessionInfo,
  method: string,
  p: Record<string, unknown>
): void {
  const threadStatus = isRecord(p.status) ? p.status : undefined;
  const statusType = normalizeOptionalString(threadStatus?.type);
  const activeFlags = Array.isArray(threadStatus?.activeFlags)
    ? (threadStatus.activeFlags as unknown[])
    : undefined;
  const nextStatus = sessionStatusForThreadStatus(session, statusType);
  const statusChanged = nextStatus !== undefined && nextStatus !== session.status;
  if (statusChanged) session.status = nextStatus;
  const failed = session.status === "error" && statusChanged;
  recordEvent(session, failed ? "error" : "progress", {
    method,
    ...p,
    statusType,
    activeFlags,
  });
  if (statusChanged) persistSessionIfChanged(runtime, session);
}

/** `item/started`, `item/completed` and `rawResponseItem/completed`. */
function onItemNotification(
  session: SessionInfo,
  method: string,
  p: Record<string, unknown>
): void {
  const item = p.item as Record<string, unknown> | undefined;
  const itemType = item && typeof item.type === "string" ? item.type : undefined;
  const status = normalizeOptionalString(item?.status);
  // `item/started` and `item/completed` carry the same ThreadItem; only the
  // completed one carries the finished text.
  const completedItem = method === Methods.ITEM_COMPLETED;
  // AgentMessageThreadItem carries `id`, `text` and an optional `phase`
  // and no status (codex-schema/v2/ItemCompletedNotification.json), so
  // the notification method is what marks the message finished. `phase`
  // is not required either: providers emit it inconsistently, and the
  // last completed message of a turn is its answer.
  if (itemType === "agentMessage" && completedItem && typeof item?.text === "string") {
    // The markers were lifted out of the deltas that built this text; what
    // stays is the answer the caller reads.
    session.lastAgentMessageText = stripActivityMarkers(item.text);
    scannerOf(session).reset();
  }
  // Keep user/agent message-like items as output; everything else is
  // progress. A PlanThreadItem (`type: "plan"`, EXPERIMENTAL, reaching
  // this server now that the client asks for `experimentalApi`) states
  // what the agent means to do rather than what it answers, and it
  // stays progress like the `item/plan/delta` that builds it.
  const eventType: SessionEventType =
    itemType === "agentMessage" || itemType === "userMessage" ? "output" : "progress";
  recordEvent(session, eventType, {
    method,
    ...p,
    item: p.item,
    status,
  });
}

/** How one notification is acted on, whatever it moves. */
type NotificationHandler = (
  runtime: SessionRuntime,
  session: SessionInfo,
  method: string,
  p: Record<string, unknown>
) => void;

/**
 * The notifications a cancelled session no longer acts on: its turn is over, and
 * a `turn/completed` still in flight would put it back to idle.
 */
const LIVE_TURN_HANDLERS: Record<string, NotificationHandler> = {
  [Methods.TURN_STARTED]: (_runtime, session, method, p) => onTurnStarted(session, method, p),
  [Methods.TURN_COMPLETED]: onTurnCompleted,
  [Methods.ERROR]: onErrorNotification,
};

const NOTIFICATION_HANDLERS: Record<string, NotificationHandler> = {
  [Methods.THREAD_STARTED]: onThreadStarted,
  [Methods.THREAD_STATUS_CHANGED]: onThreadStatusChanged,
  [Methods.AGENT_MESSAGE_DELTA]: onAgentMessageDelta,
  [Methods.ITEM_STARTED]: (_runtime, session, method, p) => onItemNotification(session, method, p),
  [Methods.ITEM_COMPLETED]: (_runtime, session, method, p) =>
    onItemNotification(session, method, p),
  [Methods.COMMAND_OUTPUT_DELTA]: (_runtime, session, method, p) =>
    onCommandOutputDelta(session, method, p),
  [Methods.WARNING]: onWarningNotification,
  [Methods.GUARDIAN_WARNING]: onWarningNotification,
  [Methods.MODEL_SAFETY_BUFFERING_UPDATED]: onSafetyBufferingUpdated,
  [Methods.HOOK_STARTED]: onHookNotification,
  [Methods.HOOK_COMPLETED]: onHookNotification,
  [Methods.AUTO_APPROVAL_REVIEW_COMPLETED]: (_runtime, session, method, p) =>
    onAutoApprovalReviewCompleted(session, method, p),
};

/** Route one notification to the handler that acts on it. */
export function handleNotification(
  runtime: SessionRuntime,
  session: SessionInfo,
  method: string,
  p: Record<string, unknown>
): void {
  if (PLAIN_PROGRESS_METHODS.has(method)) {
    recordEvent(session, "progress", { method, ...p });
    return;
  }
  const liveTurn = LIVE_TURN_HANDLERS[method];
  if (liveTurn) {
    if (session.status !== "cancelled") liveTurn(runtime, session, method, p);
    return;
  }
  // A method in neither table — account, config — has no session-side meaning.
  NOTIFICATION_HANDLERS[method]?.(runtime, session, method, p);
}
