/**
 * The value sets shared across the server: each is a tuple, so a zod schema
 * and a TypeScript type derive from the same source.
 */

export const APPROVAL_POLICIES = ["untrusted", "on-request", "never"] as const;
export type ApprovalPolicy = (typeof APPROVAL_POLICIES)[number];

export const SANDBOX_MODES = ["read-only", "workspace-write", "danger-full-access"] as const;
export type SandboxMode = (typeof SANDBOX_MODES)[number];

export const PERSONALITIES = ["none", "friendly", "pragmatic"] as const;
export type Personality = (typeof PERSONALITIES)[number];

/**
 * Who decides an approval request the turn raises.
 *
 * `user` routes it to the caller, which answers through `codex_check`.
 * `auto_review` hands it to a Codex subagent that gathers context and applies a
 * risk-based decision framework. The schema also accepts `guardian_subagent`,
 * the legacy spelling of `auto_review`; this server neither publishes nor sends
 * it.
 */
export const APPROVALS_REVIEWERS = ["user", "auto_review"] as const;
export type ApprovalsReviewer = (typeof APPROVALS_REVIEWERS)[number];

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
  "steer",
  "fork",
  "clean",
  "clean_background_terminals",
  "terminate_background_terminal",
] as const;
export type SessionAction = (typeof SESSION_ACTIONS)[number];

export const CHECK_ACTIONS = ["poll", "respond_permission", "respond_user_input"] as const;
export type CheckAction = (typeof CHECK_ACTIONS)[number];

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
