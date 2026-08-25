/**
 * Type definitions for codex-mcp
 *
 * Shared constants are defined as tuples so both Zod schemas and
 * TypeScript types can derive from the same source of truth.
 */

// ── Constants ──────────────────────────────────────────────────────

export const APPROVAL_POLICIES = ["untrusted", "on-failure", "on-request", "never"] as const;
export type ApprovalPolicy = (typeof APPROVAL_POLICIES)[number];

export const SANDBOX_MODES = ["read-only", "workspace-write", "danger-full-access"] as const;
export type SandboxMode = (typeof SANDBOX_MODES)[number];

export const PERSONALITIES = ["none", "friendly", "pragmatic"] as const;
export type Personality = (typeof PERSONALITIES)[number];

export const EFFORT_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export const SUMMARY_MODES = ["auto", "concise", "detailed", "none"] as const;
export type SummaryMode = (typeof SUMMARY_MODES)[number];

export const SESSION_ACTIONS = [
  "list",
  "get",
  "cancel",
  "interrupt",
  "fork",
  "clean",
  "clean_background_terminals",
] as const;
export type SessionAction = (typeof SESSION_ACTIONS)[number];

export const CHECK_ACTIONS = ["poll", "respond_permission", "respond_user_input"] as const;
export type CheckAction = (typeof CHECK_ACTIONS)[number];

export const RESPONSE_MODES = ["minimal", "delta_compact", "full"] as const;
export type ResponseMode = (typeof RESPONSE_MODES)[number];

export interface PollOptions {
  includeEvents?: boolean;
  includeActions?: boolean;
  includeResult?: boolean;
  /** Omit delta-heavy streaming events while still advancing the cursor past them. */
  skipDeltas?: boolean;
  /** Shortcut for result-centric polling: omit events, keep actions, always include result. */
  finalOnly?: boolean;
  maxBytes?: number;
  /** Long-poll: wait up to this many ms for new events before returning. Max 120000. */
  waitMs?: number;
}

export const APPROVAL_TYPES = ["command", "fileChange"] as const;
export type ApprovalType = (typeof APPROVAL_TYPES)[number];

export const COMMAND_DECISIONS = [
  "accept",
  "acceptForSession",
  "acceptWithExecpolicyAmendment",
  "applyNetworkPolicyAmendment",
  "decline",
  "cancel",
] as const;
export type CommandDecision = (typeof COMMAND_DECISIONS)[number];

export const FILE_CHANGE_DECISIONS = ["accept", "acceptForSession", "decline", "cancel"] as const;
export type FileChangeDecision = (typeof FILE_CHANGE_DECISIONS)[number];

export const ALL_DECISIONS = [
  "accept",
  "acceptForSession",
  "acceptWithExecpolicyAmendment",
  "applyNetworkPolicyAmendment",
  "decline",
  "cancel",
] as const;
export type ApprovalDecision = (typeof ALL_DECISIONS)[number];

export interface NetworkPolicyAmendment {
  action: "allow" | "deny";
  host: string;
}

// ── Session Types ──────────────────────────────────────────────────

export type SessionStatus = "running" | "idle" | "waiting_approval" | "error" | "cancelled";

export type InteractionState = "working" | "waiting_input" | "finished";

export type RecommendedNextAction = "poll" | "respond_permission" | "respond_user_input" | "none";

export type ExecutionMode = "background" | "foreground";

export type ExecutionFallbackReason = "wait_for_result_timeout" | "interactive_poll_required";

export type ProgressPhase =
  | "starting"
  | "running"
  | "reasoning"
  | "acting"
  | "waiting_approval"
  | "finished"
  | "error"
  | "cancelled";

export interface ProgressTokens {
  input?: number;
  output?: number;
  total?: number;
}

export interface ProgressInfo {
  phase: ProgressPhase;
  lastEventAt: string;
  activeTurnId?: string;
  pendingActionCount: number;
  lastMethod?: string;
  percent?: number;
  tokens?: ProgressTokens;
}

export interface ExecutionInfo {
  requested: ExecutionMode;
  effective: ExecutionMode;
  waitForResultMs?: number;
  fallbackReason?: ExecutionFallbackReason;
}

export type SessionEventType =
  | "output"
  | "progress"
  | "approval_request"
  | "approval_result"
  | "result"
  | "error";

export interface SessionEvent {
  id: number;
  type: SessionEventType;
  data: unknown;
  timestamp: string;
  pinned: boolean;
}

export interface EventBuffer {
  events: SessionEvent[];
  maxSize: number;
  hardMaxSize: number;
  nextId: number;
}

/** Pending approval/user-input request */
export interface PendingRequest {
  requestId: string;
  /** "command" | "fileChange" | "user_input" */
  kind: ApprovalType | "user_input";
  /** Raw params from app-server */
  params: unknown;
  /** itemId from app-server (for correlation) */
  itemId: string;
  threadId: string;
  turnId: string;
  reason?: string;
  approvalId?: string;
  commandActions?: unknown[] | null;
  proposedExecpolicyAmendment?: string[] | null;
  availableDecisions?: unknown[] | null;
  additionalPermissions?: unknown;
  networkApprovalContext?: unknown;
  proposedNetworkPolicyAmendments?: unknown[] | null;
  createdAt: string;
  resolved: boolean;
  decision?: string;
  timeoutHandle?: ReturnType<typeof setTimeout>;
  /** JSON-RPC response resolver */
  respond?: (result: unknown) => void;
}

/** Internal session info (full) */
export interface SessionInfo {
  sessionId: string;
  threadId?: string;
  activeTurnId?: string;
  lastAgentMessageText?: string;
  /** Most recent poll cursor consumed by this session. */
  lastEventCursor: number;
  status: SessionStatus;
  createdAt: string;
  lastActiveAt: string;
  cancelledAt?: string;
  cancelledReason?: string;
  approvalTimeoutMs?: number;
  cwd: string;
  model?: string;
  profile?: string;
  approvalPolicy?: ApprovalPolicy;
  sandbox?: SandboxMode;
  config?: Record<string, unknown>;
  eventBuffer: EventBuffer;
  pendingRequests: Map<string, PendingRequest>;
  lastResult?: TurnResult;
  progressState?: Omit<ProgressInfo, "phase" | "pendingActionCount" | "activeTurnId">;
}

/** Public session info (redacted) */
export interface PublicSessionInfo {
  sessionId: string;
  status: SessionStatus;
  createdAt: string;
  lastActiveAt: string;
  cancelledAt?: string;
  cancelledReason?: string;
  model?: string;
  approvalPolicy?: ApprovalPolicy;
  sandbox?: SandboxMode;
  pendingRequestCount: number;
}

/** Sensitive session info */
export interface SensitiveSessionInfo extends PublicSessionInfo {
  threadId?: string;
  cwd: string;
  profile?: string;
  config?: Record<string, unknown>;
}

// ── Result Types ───────────────────────────────────────────────────

export interface TurnResult {
  turnId: string;
  /** Stable final assistant text for this turn, derived from turn output or the last completed agent message. */
  text?: string;
  /** Raw backend turn.output value when present. */
  output?: string;
  structuredOutput?: unknown;
  /** Raw turn object from app-server notifications/responses (shape depends on schema version). */
  turn?: unknown;
  /** Turn status string if available (e.g. "completed" | "failed" | "interrupted"). */
  status?: string;
  /** Raw turn error object if available. */
  turnError?: unknown;
  error?: string;
  completedAt: string;
}

export interface SessionStartResult {
  sessionId: string;
  threadId: string;
  status: "running" | "idle";
  pollInterval: number;
  compatWarnings?: string[];
  progress?: ProgressInfo;
  execution?: ExecutionInfo;
  interactionState?: InteractionState;
  recommendedNextAction?: RecommendedNextAction;
}

export interface CheckResult {
  sessionId: string;
  status: SessionStatus;
  pollInterval?: number;
  progress?: ProgressInfo;
  interactionState?: InteractionState;
  recommendedNextAction?: RecommendedNextAction;
  events: Array<{
    id: number;
    type: SessionEventType;
    data: unknown;
    timestamp: string;
  }>;
  nextCursor: number;
  cursorResetTo?: number;
  actions?: Array<{
    type: "approval" | "user_input";
    requestId: string;
    kind: "command" | "fileChange" | "user_input";
    params: unknown;
    itemId: string;
    reason?: string;
    approvalId?: string;
    commandActions?: unknown[] | null;
    proposedExecpolicyAmendment?: string[] | null;
    availableDecisions?: unknown[] | null;
    additionalPermissions?: unknown;
    networkApprovalContext?: unknown;
    proposedNetworkPolicyAmendments?: unknown[] | null;
    createdAt: string;
  }>;
  result?: TurnResult;
  compatWarnings?: string[];
  truncated?: boolean;
  truncatedFields?: string[];
}

// ── Error Types ────────────────────────────────────────────────────

export enum ErrorCode {
  INVALID_ARGUMENT = "INVALID_ARGUMENT",
  SESSION_NOT_FOUND = "SESSION_NOT_FOUND",
  SESSION_BUSY = "SESSION_BUSY",
  SESSION_NOT_RUNNING = "SESSION_NOT_RUNNING",
  REQUEST_NOT_FOUND = "REQUEST_NOT_FOUND",
  TIMEOUT = "TIMEOUT",
  CANCELLED = "CANCELLED",
  APP_SERVER_START_FAILED = "APP_SERVER_START_FAILED",
  THREAD_FORK_RESUME_FAILED = "THREAD_FORK_RESUME_FAILED",
  PROTOCOL_PARSE_ERROR = "PROTOCOL_PARSE_ERROR",
  WRITE_QUEUE_DROPPED = "WRITE_QUEUE_DROPPED",
  EXEC_NOT_SUPPORTED = "EXEC_NOT_SUPPORTED",
  INTERNAL = "INTERNAL",
}

// ── Defaults ───────────────────────────────────────────────────────

export const DEFAULT_EFFORT_LEVEL: EffortLevel = "low";
/**
 * Minimum recommended polling interval (ms) when session status is "running".
 * MCP callers should treat this as a floor and can wait longer for larger tasks.
 */
export const DEFAULT_POLL_INTERVAL = 120_000;
/**
 * Polling interval (ms) while waiting for approval/user-input actions.
 * Kept short so callers can unblock pending actions before approval timeout.
 */
export const WAITING_APPROVAL_POLL_INTERVAL = 1000;
/** Public codex_check default for action="poll" when maxEvents is omitted. */
export const POLL_DEFAULT_MAX_EVENTS = 1;
/** Public codex_check lower bound for action="poll" to avoid no-op loops. */
export const POLL_MIN_MAX_EVENTS = 1;
/** Public codex_check default for action="respond_*" when maxEvents is omitted. */
export const RESPOND_DEFAULT_MAX_EVENTS = 0;
/**
 * Internal SessionManager fallback for direct poll helpers.
 * Not used as codex_check external default.
 */
export const DEFAULT_MAX_EVENTS = 200;
export const DEFAULT_EVENT_BUFFER_SIZE = 1000;
export const DEFAULT_EVENT_BUFFER_HARD_SIZE = 2000;
export const DEFAULT_APPROVAL_TIMEOUT_MS = 60_000;
export const DEFAULT_IDLE_CLEANUP_MS = 30 * 60 * 1000;
export const DEFAULT_RUNNING_CLEANUP_MS = 4 * 60 * 60 * 1000;
export const DEFAULT_TERMINAL_CLEANUP_MS = 5 * 60 * 1000;
export const CLEANUP_INTERVAL_MS = 60_000;
