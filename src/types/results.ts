/** What a tool call answers. */

import type {
  InteractionState,
  ProgressInfo,
  RecommendedNextAction,
  SessionStatus,
  SessionWarning,
  TurnResult,
} from "./session.js";

/** One background terminal, and what the call did to it. */
export interface BackgroundTerminalOutcome {
  processId: string;
  /**
   * The rest of what `thread/backgroundTerminals/list` answered about it. Absent
   * for `terminate_background_terminal`, which names a process and lists nothing.
   */
  itemId?: string;
  command?: string;
  cwd?: string;
  osPid?: number | null;
  cpuPercent?: number | null;
  rssKb?: number | null;
  /** What `thread/backgroundTerminals/terminate` answered. Absent when that call failed. */
  terminated?: boolean;
  /** Why the terminate call failed, when it did. */
  error?: string;
  /** Absent from the listing taken after the pass. Absent when that listing failed. */
  gone?: boolean;
}

/** What a background-terminal call of `codex_session` measured. */
export interface BackgroundTerminalsReport {
  threadId: string;
  /** Every terminal the call acted on. */
  terminals: BackgroundTerminalOutcome[];
  /** The listing taken after the pass. Absent when that listing failed. */
  survivors?: BackgroundTerminalOutcome[];
  /** The listing stopped at the page bound with a cursor still to follow. */
  truncated?: boolean;
  /** `thread/backgroundTerminals/clean` swept the thread; it reports nothing about what it swept. */
  cleanCalled?: boolean;
  /** The listing failed at this stage, so what stands afterwards is unknown. */
  listError?: { stage: "before" | "after"; message: string };
}

/**
 * What a steer came to.
 *
 * `turn/steer` adds input to the turn that is already running rather than
 * starting one, so `turnId` names that turn and `status` is the status the
 * session was already on.
 */
export interface SteerResult {
  sessionId: string;
  threadId: string;
  /** The turn the steer joined — the running one, which Codex answered with. */
  turnId: string;
  status: SessionStatus;
  /** What happened, in the terms a caller expecting a new turn needs to read. */
  message: string;
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
