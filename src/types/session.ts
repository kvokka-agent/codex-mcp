/** What the server holds about one session, and what a read of it answers. */

import type {
  ApprovalsReviewer as AnsweredApprovalsReviewer,
  AskForApproval,
  SandboxPolicy,
} from "../app-server/wire/index.js";
import type {
  ApprovalPolicy,
  ApprovalsReviewer,
  EffortLevel,
  Personality,
  SandboxMode,
  SummaryMode,
} from "./enums.js";

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

/**
 * The settings Codex answered the session's thread call with: what the session
 * runs with, whatever the call asked for.
 *
 * A field is absent when the answer did not carry it in the shape
 * `codex-schema/v2/ThreadStartResponse.json` gives it. Absent means unknown —
 * the argument the call sent is never copied in to stand for the answer, and
 * the session reports that argument under its own field.
 */
export interface EffectiveSettings {
  model?: string;
  modelProvider?: string;
  /** The response omits it for a model that advertises no reasoning effort. */
  reasoningEffort?: EffortLevel;
  /** A policy preset, or the granular object naming each approval channel. */
  approvalPolicy?: AskForApproval;
  /** The sandbox policy object the thread runs under, as Codex answered it. */
  sandbox?: SandboxPolicy;
  cwd?: string;
  /**
   * Who Codex routes this thread's approval requests to. The legacy spelling
   * `guardian_subagent` is carried through as answered.
   */
  approvalsReviewer?: AnsweredApprovalsReviewer;
  /**
   * The profile that produced the active permissions, which is what says where
   * `sandbox` came from. Absent where the answer named none.
   */
  activePermissionProfile?: EffectivePermissionProfile;
}

/**
 * The permission profile a session reports, read off the answer's
 * `activePermissionProfile`.
 */
export interface EffectivePermissionProfile {
  /** A built-in such as `:workspace`, or a `[permissions.<id>]` profile of the user's config. */
  id: string;
  /** The parent this profile extends. The answer's null names none, and is reported as absent. */
  extends?: string;
}

/** The effective settings a redacted view carries: `cwd` is a path and stays out. */
export type PublicEffectiveSettings = Omit<EffectiveSettings, "cwd">;

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

type ApprovalType = "command" | "fileChange";

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
  /**
   * Named permission profile of this thread, from a `[permissions.<id>]` table
   * of the user's Codex config. It replaces `sandbox`, which cannot be combined
   * with it, and the same profile is restored on a fork and on a resume.
   */
  permissions?: string;
  /**
   * Who reviews the approval requests of this thread. Thread state: `thread/start`
   * sets it, and `thread/fork` and `thread/resume` carry it so a forked or
   * resumed session keeps the reviewer it ran under.
   */
  approvalsReviewer?: ApprovalsReviewer;
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
  /**
   * What Codex answered the last `thread/start`, `thread/fork` or
   * `thread/resume` of this session with. Absent until one answers something
   * readable, and each answer replaces the whole block: two answers merged
   * would report a set of settings that never ran together.
   */
  effective?: EffectiveSettings;
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
  /**
   * The permission profile id the call named in place of a sandbox. It names a
   * permission level the same way `sandbox` does, so it is reported beside it.
   */
  permissions?: string;
  /** Who the call asked to review its approval requests. */
  approvalsReviewer?: ApprovalsReviewer;
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
  /**
   * The settings Codex answered with, which are what the session runs with.
   * `model`, `approvalPolicy`, `sandbox`, `permissions` and `approvalsReviewer`
   * above are what the call asked for.
   */
  effective?: PublicEffectiveSettings;
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
  /** The full block, `cwd` included. */
  effective?: EffectiveSettings;
}
