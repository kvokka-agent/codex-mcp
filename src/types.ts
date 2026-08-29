/**
 * Type definitions for codex-mcp
 *
 * Shared constants are defined as tuples so both Zod schemas and
 * TypeScript types can derive from the same source of truth.
 */

// ── Constants ──────────────────────────────────────────────────────

export const APPROVAL_POLICIES = ["untrusted", "on-request", "never"] as const;
export type ApprovalPolicy = (typeof APPROVAL_POLICIES)[number];

export const SANDBOX_MODES = ["read-only", "workspace-write", "danger-full-access"] as const;
export type SandboxMode = (typeof SANDBOX_MODES)[number];

export const PERSONALITIES = ["none", "friendly", "pragmatic"] as const;
export type Personality = (typeof PERSONALITIES)[number];

/**
 * The reasoning efforts every model of Codex CLI 0.150.1 answered `model/list`
 * with, least to most. The set belongs to the model, not to this server, so it
 * feeds the `effort` description and `codex-mcp:///server-info` and gates
 * nothing; the backend refuses an effort the chosen model does not advertise.
 */
export const ADVERTISED_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;

/** Any non-empty reasoning effort. `TurnStartParams.effort` carries it through. */
export type EffortLevel = string;

export const SUMMARY_MODES = ["auto", "concise", "detailed", "none"] as const;
export type SummaryMode = (typeof SUMMARY_MODES)[number];

export const SESSION_ACTIONS = [
  "list",
  "get",
  "resume",
  "cancel",
  "interrupt",
  "fork",
  "clean",
  "clean_background_terminals",
] as const;
export type SessionAction = (typeof SESSION_ACTIONS)[number];

export const CHECK_ACTIONS = ["poll", "respond_permission", "respond_user_input"] as const;
export type CheckAction = (typeof CHECK_ACTIONS)[number];

type ApprovalType = "command" | "fileChange";

export const COMMAND_DECISIONS = [
  "accept",
  "acceptForSession",
  "acceptWithExecpolicyAmendment",
  "applyNetworkPolicyAmendment",
  "decline",
  "cancel",
] as const;

export const FILE_CHANGE_DECISIONS = ["accept", "acceptForSession", "decline", "cancel"] as const;

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

/**
 * Where a session stands.
 *
 * `abandoned` is the honest end of a session whose server went away mid-turn:
 * the work was cut off, nobody holds it, and `codex_session(action="resume")`
 * picks the thread up where Codex left it. It is not `error` — nothing failed —
 * and not `cancelled` — nobody asked for it to stop.
 */
export type SessionStatus =
  | "running"
  | "idle"
  | "waiting_approval"
  | "error"
  | "cancelled"
  | "abandoned";

/** The statuses a session can be recovered from disk in and be listed under. */
export const SESSION_STATUSES = [
  "running",
  "idle",
  "waiting_approval",
  "error",
  "cancelled",
  "abandoned",
] as const;

/** The statuses `codex_session(action="clean")` accepts. */
export const CLEANABLE_STATUSES = ["idle", "error", "cancelled", "abandoned"] as const;
export type CleanableStatus = (typeof CLEANABLE_STATUSES)[number];

export type InteractionState = "working" | "waiting_input" | "finished";

export type RecommendedNextAction = "poll" | "respond_permission" | "respond_user_input" | "none";

/** What a long-poll waiter compares between two reads of a session. */
export interface SessionSignal {
  /** Two equal keys mean nothing the caller acts on happened in between. */
  key: string;
  /** The session waits on the caller: an open action, or a turn that ended. */
  awaitsCaller: boolean;
}

export type ProgressPhase =
  | "starting"
  | "running"
  | "reasoning"
  | "acting"
  | "waiting_approval"
  | "finished"
  | "error"
  | "cancelled"
  | "abandoned";

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
  tokens?: ProgressTokens;
  /**
   * What Codex said it is doing right now, in one line of its own words.
   *
   * Codex marks it in its output as `%%%ACTIVITY: ...%%%` on the instruction the
   * server puts on the thread, and the last line extracted overwrites the one
   * before it — a heading, not a percentage, and not a history.
   */
  activity?: string;
  /** When the standing activity line arrived. */
  activitySince?: string;
  /**
   * How long the session has been on that line, in milliseconds.
   *
   * A driver writes it out — "still compiling — 15 min" — and carries nothing
   * between rounds: the number is the server's, measured from when the line
   * arrived rather than summed from how many polls the driver has made.
   */
  activityStandingMs?: number;
}

/**
 * One thing the backend said about a turn that is producing no output.
 *
 * The message is free text this server did not write — a backend warning, a
 * named safety-buffering reason, a hook that blocked the turn — so it is
 * path-redacted before it leaves the process. It says why the session is quiet;
 * `progress.activity` says what the session is doing.
 */
export interface SessionWarning {
  /** The app-server method that carried it, so a caller can tell the kinds apart. */
  method: string;
  message: string;
  /** When it arrived. A repeat of the standing line refreshes this and adds no entry. */
  at: string;
}

export type SessionEventType =
  | "output"
  | "progress"
  | "activity"
  | "approval_request"
  | "approval_result"
  | "result"
  | "error";

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
  status: SessionStatus;
  createdAt: string;
  lastActiveAt: string;
  cancelledAt?: string;
  cancelledReason?: string;
  approvalTimeoutMs?: number;
  /** Absent when the session was recovered from a meta.json that recorded no cwd. */
  cwd?: string;
  model?: string;
  profile?: string;
  approvalPolicy?: ApprovalPolicy;
  sandbox?: SandboxMode;
  personality?: Personality;
  /** Reasoning effort of the session's turns: `turn/start` carries it on every turn, and a turn that omits it falls back to config.toml. */
  effort?: EffortLevel;
  /** Reasoning summary of the session's turns, carried per turn like `effort`. */
  summary?: SummaryMode;
  /** System instructions the thread was started with, reused when it is forked or resumed. */
  baseInstructions?: string;
  config?: Record<string, unknown>;
  pendingRequests: Map<string, PendingRequest>;
  lastResult?: TurnResult;
  progressState?: {
    lastEventAt: string;
    lastMethod?: string;
    tokens?: ProgressTokens;
    /** Last activity line extracted from the agent-message stream. */
    activity?: string;
    /** When that line arrived, which is how long the session has been on it. */
    activityAt?: string;
    /**
     * The standing line came from a hook, not from an activity marker.
     *
     * A marker overwrites a hook line and a hook line never overwrites a marker,
     * so the turn's own words win for as long as it writes any.
     */
    activityFromHook?: boolean;
  };
  /** The newest warnings, oldest first, capped at `MAX_SESSION_WARNINGS`. */
  warnings?: SessionWarning[];
  /** How many warnings this session has recorded, which is what wakes a long poll. */
  warningSeq?: number;
  /** Developer instructions the thread was started with, reused when it is forked or resumed. */
  developerInstructions?: string;
}

/** Which server holds a session, as a listing reports it. */
export interface SessionOwnership {
  pid: number;
  /** "self" for this server, "other" for another one that is still running. */
  state: "self" | "other";
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
  /**
   * The last line the session said it was doing. On an abandoned session it is
   * what the work was cut off in the middle of.
   */
  activity?: string;
  /**
   * How the last turn of this session ended.
   *
   * `status` says what the session is now, and closing a session that answered
   * leaves it `cancelled`; this says what the work came to, and no later close
   * touches it. Absent until a turn ends.
   */
  lastTurn?: LastTurnInfo;
  /** Absent when no server holds the session, which is what makes it resumable. */
  owner?: SessionOwnership;
}

/** The end of a turn, as the session reports it after the fact. */
export interface LastTurnInfo {
  turnId: string;
  /** Absent on a result restored from a server that recorded no outcome. */
  outcome?: TurnOutcome;
  /** The backend's own turn status, where it sent one. */
  status?: string;
  completedAt: string;
  /** What failed, on an outcome of `error` or `cancelled`. */
  error?: string;
}

/** Sensitive session info */
export interface SensitiveSessionInfo extends PublicSessionInfo {
  threadId?: string;
  cwd?: string;
  profile?: string;
  config?: Record<string, unknown>;
}

// ── Result Types ───────────────────────────────────────────────────

/** How a turn ended, as the server saw it end. */
export type TurnOutcome = "completed" | "error" | "cancelled";

export interface TurnResult {
  turnId: string;
  /**
   * How the turn ended, recorded where the server saw it end rather than read
   * back out of the turn record. Absent on a result restored from a server
   * that did not record one.
   */
  outcome?: TurnOutcome;
  /** Final assistant text for this turn: the last completed agent message. */
  text?: string;
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
  interactionState?: InteractionState;
  recommendedNextAction?: RecommendedNextAction;
}

/** One thing the caller must answer: an approval request or a question. */
export interface PendingAction {
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
}

/**
 * What `codex_check` answers with: where the session stands and what it waits for.
 *
 * The turn's own history — every reasoning, command and message event — stays in
 * Codex's rollout log under `~/.codex/sessions/`; this server never repeats it to
 * the caller.
 */
export interface CheckResult {
  sessionId: string;
  status: SessionStatus;
  pollInterval?: number;
  progress: ProgressInfo;
  interactionState: InteractionState;
  recommendedNextAction: RecommendedNextAction;
  /** What the caller must answer. Empty while the turn needs nothing. */
  actions: PendingAction[];
  /**
   * Why the turn is producing no output, newest last. Empty while nothing said so.
   *
   * A caller writes these out beside `progress.activity`: the activity line is
   * what the turn is doing, and a warning is what is standing in its way.
   */
  warnings: SessionWarning[];
  /** The final answer of the turn, carried by the first check that sees it. */
  result?: TurnResult;
  /**
   * How long the poll held the call before answering, in milliseconds.
   *
   * A long poll that answers with the state it started on held the call for the
   * whole window and nothing the caller acts on happened in it. Present on
   * `poll` with a `waitMs`, absent on every immediate answer.
   */
  waitedMs?: number;
}

// ── Error Types ────────────────────────────────────────────────────

export enum ErrorCode {
  INVALID_ARGUMENT = "INVALID_ARGUMENT",
  SESSION_NOT_FOUND = "SESSION_NOT_FOUND",
  SESSION_HELD_BY_OTHER_SERVER = "SESSION_HELD_BY_OTHER_SERVER",
  SESSION_BUSY = "SESSION_BUSY",
  SESSION_NOT_RUNNING = "SESSION_NOT_RUNNING",
  REQUEST_NOT_FOUND = "REQUEST_NOT_FOUND",
  TIMEOUT = "TIMEOUT",
  CANCELLED = "CANCELLED",
  APP_SERVER_START_FAILED = "APP_SERVER_START_FAILED",
  THREAD_FORK_RESUME_FAILED = "THREAD_FORK_RESUME_FAILED",
  PROTOCOL_PARSE_ERROR = "PROTOCOL_PARSE_ERROR",
  WRITE_QUEUE_DROPPED = "WRITE_QUEUE_DROPPED",
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
/**
 * The longest `codex_check(action="poll")` holds a call, whatever `waitMs` asks
 * for and whatever the client tolerates.
 *
 * The client's own tool-call ceiling is what normally ends a wait — `PollWindow`
 * reads it and cuts the window to fit. This bound is the one the server keeps
 * on its own, so a caller that asks for a day cannot pin a waiter slot of the
 * session for one.
 */
export const MAX_LONG_POLL_WAIT_MS = 3_600_000;
/**
 * How often a held poll tells the client what the turn is doing.
 *
 * Two things need it. A person watching reads the line under the call rather
 * than a spinner, and a client watchdog that ends a call which said nothing —
 * Claude Code 2.1.250 cuts a silent stdio call at 1,800,000ms,
 * `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` — counts a progress notification as the
 * server speaking. `CODEX_MCP_PROGRESS_HEARTBEAT_MS` overrides it; 0 sends
 * heartbeats no more.
 */
export const PROGRESS_HEARTBEAT_MS = 30_000;
export const DEFAULT_APPROVAL_TIMEOUT_MS = 60_000;
export const DEFAULT_IDLE_CLEANUP_MS = 30 * 60 * 1000;
export const DEFAULT_RUNNING_CLEANUP_MS = 4 * 60 * 60 * 1000;
export const DEFAULT_TERMINAL_CLEANUP_MS = 5 * 60 * 1000;
export const CLEANUP_INTERVAL_MS = 60_000;
