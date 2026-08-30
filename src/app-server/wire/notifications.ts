/**
 * What the server tells the client without being asked: the item and turn
 * deltas, the thread lifecycle, the approval auto-review, the warnings and the
 * hook runs.
 *
 * Derived from `codex app-server generate-json-schema`.
 */

// fallow-ignore-file unused-type -- the wire model's consumer reads it by name
// rather than by import: `tests/protocol-schema.test.ts` walks
// `checker.getExportsOfModule` over `src/app-server/wire/index.ts` and holds each
// exported type against the `codex-schema/` definition its `MODELLED_TYPES` map
// names. Dropping the `export` keyword takes a type out of that table and out of
// the conformance check with it.

export interface DeltaNotificationParams {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
}

export interface ReasoningDeltaParams {
  threadId: string;
  turnId: string;
  itemId: string;
  contentIndex: number;
  delta: string;
}

/**
 * item/started. Split from `item/completed` because the schema requires a
 * different timestamp on each, so one interface would have to claim a field
 * that notification never carries.
 */
export interface ItemStartedNotificationParams {
  threadId: string;
  turnId: string;
  item: unknown;
  /** Unix milliseconds when the item's lifecycle started. */
  startedAtMs: number;
}

/** item/completed. */
export interface ItemCompletedNotificationParams {
  threadId: string;
  turnId: string;
  item: unknown;
  /** Unix milliseconds when the item's lifecycle completed. */
  completedAtMs: number;
}

export interface ThreadStateNotificationParams {
  threadId: string;
}

export interface ThreadNameUpdatedNotificationParams {
  threadId: string;
  threadName?: string | null;
}

export interface TurnNotificationParams {
  threadId: string;
  turn: unknown;
}

export interface ErrorNotificationParams {
  threadId: string;
  turnId: string;
  error: unknown;
  willRetry: boolean;
}

export type ThreadActiveFlag = "waitingOnApproval" | "waitingOnUserInput";

export type ThreadStatus =
  | { type: "notLoaded" }
  | { type: "idle" }
  | { type: "systemError" }
  | { type: "active"; activeFlags: ThreadActiveFlag[] };

export interface ThreadStatusChangedNotificationParams {
  threadId: string;
  status: ThreadStatus;
}

/** thread/compacted — schema title ContextCompactedNotification. */
export interface ContextCompactedNotificationParams {
  threadId: string;
  turnId: string;
}

export interface TextPosition {
  /** 1-based line number. */
  line: number;
  /** 1-based column number (in Unicode scalar values). */
  column: number;
}

export interface TextRange {
  start: TextPosition;
  end: TextPosition;
}

// ── Approval auto-review (approvalsReviewer: auto_review) ──────────

/**
 * Lifecycle state of one approval auto-review.
 *
 * `inProgress` opens the review; the other four end it, and only `approved`
 * lets the action through.
 */
export type GuardianApprovalReviewStatus =
  | "inProgress"
  | "approved"
  | "denied"
  | "timedOut"
  | "aborted";

/**
 * The review object of an `item/autoApprovalReview/*` notification.
 *
 * The schema marks `GuardianApprovalReview` `[UNSTABLE]` — "This shape is
 * expected to change soon" — so only `status` is declared here and nothing in
 * this server reads deeper. `rationale`, `riskLevel` and `userAuthorization`
 * are on the wire and are not to be depended on.
 */
export interface GuardianApprovalReview {
  status: GuardianApprovalReviewStatus;
}

/** item/autoApprovalReview/started — schema ItemGuardianApprovalReviewStartedNotification. */
export interface AutoApprovalReviewStartedParams {
  /** `GuardianApprovalReviewAction`, left unread: it is `[UNSTABLE]` too. */
  action: unknown;
  review: GuardianApprovalReview;
  /** Stable identifier for this review. */
  reviewId: string;
  /** Unix milliseconds when the review started. */
  startedAtMs: number;
  /** The reviewed item, absent for a network-policy review, which targets no item. */
  targetItemId?: string | null;
  threadId: string;
  turnId: string;
}

/** item/autoApprovalReview/completed — schema ItemGuardianApprovalReviewCompletedNotification. */
export interface AutoApprovalReviewCompletedParams {
  /** `GuardianApprovalReviewAction`, left unread: it is `[UNSTABLE]` too. */
  action: unknown;
  /** Unix milliseconds when the review completed. */
  completedAtMs: number;
  /** What produced the terminal decision; the schema gives one value, `agent`. */
  decisionSource: "agent";
  review: GuardianApprovalReview;
  reviewId: string;
  startedAtMs: number;
  targetItemId?: string | null;
  threadId: string;
  turnId: string;
}

/** autoApprovalReview/strictReviewRequired — schema StrictReviewRequiredNotification. */
export interface StrictReviewRequiredParams {
  /** Unix milliseconds when the review started. */
  startedAtMs: number;
  threadId: string;
  turnId: string;
}

export interface DeprecationNoticeNotificationParams {
  summary: string;
  details?: string | null;
}

export interface ConfigWarningNotificationParams {
  summary: string;
  details?: string | null;
  path?: string | null;
  range?: TextRange | null;
}

/**
 * `warning` — free text the backend wants shown to the person, with no code and
 * no structure to branch on.
 */
export interface WarningNotificationParams {
  message: string;
  threadId?: string | null;
}

/** `guardianWarning` — the same free text from the approvals reviewer. */
export interface GuardianWarningNotificationParams {
  message: string;
  threadId: string;
}

/**
 * `model/safetyBuffering/updated` — the backend is holding the model's output
 * back, and `reasons` names why. `showBufferingUi` is the backend saying whether
 * the person is meant to be told.
 */
export interface ModelSafetyBufferingUpdatedNotificationParams {
  model: string;
  reasons: string[];
  showBufferingUi: boolean;
  threadId: string;
  turnId: string;
  useCases: string[];
  fasterModel?: string | null;
}

/** Which lifecycle point of a turn a hook is configured to run at. */
export type HookEventName =
  | "preToolUse"
  | "permissionRequest"
  | "postToolUse"
  | "preCompact"
  | "postCompact"
  | "sessionStart"
  | "sessionEnd"
  | "userPromptSubmit"
  | "subagentStart"
  | "subagentStop"
  | "stop"
  | "interrupt";

/** `blocked` and `stopped` are a hook holding the turn back; `failed` is one that broke. */
export type HookRunStatus = "running" | "completed" | "failed" | "blocked" | "stopped";

export type HookOutputEntryKind = "warning" | "stop" | "feedback" | "context" | "error";

/** One line a hook wrote for display, tagged with what kind of line it is. */
export interface HookOutputEntry {
  kind: HookOutputEntryKind;
  text: string;
}

/** Where the hook was configured. The schema defaults it to `unknown`. */
export type HookSource =
  | "system"
  | "user"
  | "project"
  | "mdm"
  | "sessionFlags"
  | "plugin"
  | "cloudRequirements"
  | "cloudManagedConfig"
  | "legacyManagedConfigFile"
  | "legacyManagedConfigMdm"
  | "unknown";

/** One run of one hook, as `hook/started` and `hook/completed` report it. */
export interface HookRunSummary {
  id: string;
  displayOrder: number;
  entries: HookOutputEntry[];
  eventName: HookEventName;
  executionMode: "sync" | "async";
  handlerType: "command" | "mcpTool" | "prompt" | "agent";
  scope: "thread" | "turn";
  /** Absolute, normalized path of the file the hook was configured in. */
  sourcePath: string;
  /** Unix milliseconds. */
  startedAt: number;
  status: HookRunStatus;
  /** The line the hook's author wrote for display. Null when they wrote none. */
  statusMessage?: string | null;
  completedAt?: number | null;
  durationMs?: number | null;
  source?: HookSource;
}

/**
 * `hook/started` and `hook/completed`, which carry the same shape. `turnId` is
 * absent for a hook whose `scope` is the thread.
 */
export interface HookNotificationParams {
  run: HookRunSummary;
  threadId: string;
  turnId?: string | null;
}

// ── Legacy Approval (deprecated) ───────────────────────────────────

export interface LegacyApprovalResponse {
  decision:
    | "approved"
    | "approved_for_session"
    | "denied"
    | "abort"
    | { approved_execpolicy_amendment: { proposed_execpolicy_amendment: string[] } };
}
