/**
 * Starting, steering and interrupting a turn, and the four requests the server
 * sends back mid-turn: the two approvals, the user-input question and the
 * dynamic tool call, plus the auth refresh it asks the client for.
 *
 * Derived from `codex app-server generate-json-schema`.
 */

// fallow-ignore-file unused-type -- the wire model's consumer reads it by name
// rather than by import: `tests/protocol-schema.test.ts` walks
// `checker.getExportsOfModule` over `src/app-server/wire/index.ts` and holds each
// exported type against the `codex-schema/` definition its `MODELLED_TYPES` map
// names. Dropping the `export` keyword takes a type out of that table and out of
// the conformance check with it.

import type {
  ApprovalsReviewer,
  AskForApproval,
  MultiAgentMode,
  Personality,
  ReasoningEffort,
  ReasoningSummary,
  SandboxPolicy,
  TurnEnvironmentParams,
} from "./common.js";

export interface TextElement {
  byteRange: { start: number; end: number };
  placeholder?: string | null;
}

/** How much of an image the model is given. Absent leaves the server's choice. */
export type ImageDetail = "auto" | "low" | "high" | "original";

export type UserInput =
  | { type: "text"; text: string; text_elements?: TextElement[] }
  | { type: "image"; url: string; detail?: ImageDetail | null }
  | { type: "localImage"; path: string; detail?: ImageDetail | null }
  | { type: "audio"; url: string }
  | { type: "localAudio"; path: string }
  | { type: "skill"; name: string; path: string }
  | { type: "mention"; name: string; path: string };

export interface CollaborationMode {
  mode: "plan" | "default";
  settings: {
    model: string;
    developer_instructions?: string | null;
    reasoning_effort?: ReasoningEffort | null;
  };
}

/** One context fragment a client hands the turn, keyed by an opaque source id. */
export interface AdditionalContextEntry {
  /** `untrusted` marks content the model must not treat as instructions. */
  kind: "untrusted" | "application";
  value: string;
}

export interface TurnStartParams {
  threadId: string;
  input: UserInput[];
  model?: string | null;
  approvalPolicy?: AskForApproval | null;
  sandboxPolicy?: SandboxPolicy | null;
  personality?: Personality | null;
  effort?: ReasoningEffort | null;
  summary?: ReasoningSummary | null;
  cwd?: string | null;
  outputSchema?: Record<string, unknown>;
  collaborationMode?: CollaborationMode | null;
  additionalContext?: Record<string, AdditionalContextEntry> | null;
  approvalsReviewer?: ApprovalsReviewer | null;
  /** Client-chosen id for the user message this turn starts from. */
  clientUserMessageId?: string | null;
  /**
   * Environments for this turn onward. Omitted keeps the thread's sticky
   * environments; empty disables environment access for the turn.
   */
  environments?: TurnEnvironmentParams[] | null;
  /** @deprecated The schema marks this ignored; set `effort: "ultra"` instead. */
  multiAgentMode?: MultiAgentMode | null;
  /** Named permissions profile id. Cannot be combined with `sandboxPolicy`. */
  permissions?: string | null;
  /**
   * Flattened into the `x-codex-turn-metadata` client metadata of the upstream
   * ResponsesAPI request. `session_id`, `thread_id`, `turn_id` and `window_id`
   * are reserved and cannot be overridden here.
   */
  responsesapiClientMetadata?: Record<string, string> | null;
  /** Replaces the thread's runtime workspace roots. Every path must be absolute. */
  runtimeWorkspaceRoots?: string[] | null;
  serviceTier?: string | null;
}

/** turn/start response — schema v2/TurnStartResponse.json. */
export interface TurnStartResult {
  turn: { id: string };
}

export interface TurnInterruptParams {
  threadId: string;
  turnId: string;
}

export interface TurnSteerParams {
  threadId: string;
  /** The request fails unless this names the turn currently running. */
  expectedTurnId: string;
  input: UserInput[];
  additionalContext?: Record<string, AdditionalContextEntry> | null;
  /** Client-chosen id for the user message this steer carries. */
  clientUserMessageId?: string | null;
  /** Flattened into the upstream `x-codex-turn-metadata` client metadata. */
  responsesapiClientMetadata?: Record<string, string> | null;
}

/**
 * turn/steer response — schema v2/TurnSteerResponse.json.
 *
 * `turnId` is the turn that was already running, not a new one. Measured on
 * codex-cli 0.150.1: a steer sent 2s into an 8s turn answered the running turn's
 * id, and no `turn/started` or `turn/completed` followed it.
 */
export interface TurnSteerResult {
  turnId: string;
}

// ── Approval Requests (server → client) ────────────────────────────

export interface CommandApprovalParams {
  /**
   * Optional per-callback approval id.
   * Present for subcommand approvals (execve intercept), null/absent for regular approvals.
   */
  approvalId?: string | null;
  itemId: string;
  threadId: string;
  turnId: string;
  command?: string | null;
  cwd?: string | null;
  reason?: string | null;
  commandActions?: unknown[] | null;
  proposedExecpolicyAmendment?: string[] | null;
  additionalPermissions?: unknown;
  availableDecisions?: unknown;
  networkApprovalContext?: unknown;
  proposedNetworkPolicyAmendments?: unknown;
  /** Unix milliseconds when the approval request started. */
  startedAtMs: number;
  /** Environment the command runs in. Absent means the thread's own. */
  environmentId?: string | null;
  /**
   * `writeStdin` is input for a terminal already running, not a new command.
   * Absent means `command` — an older server sends no kind at all.
   */
  kind?: "command" | "writeStdin";
}

export type CommandApprovalDecision =
  | "accept"
  | "acceptForSession"
  | { acceptWithExecpolicyAmendment: { execpolicy_amendment: string[] } }
  | {
      applyNetworkPolicyAmendment: {
        network_policy_amendment: { action: "allow" | "deny"; host: string };
      };
    }
  | "decline"
  | "cancel";

export interface CommandApprovalResponse {
  decision: CommandApprovalDecision;
}

export interface FileChangeApprovalParams {
  itemId: string;
  threadId: string;
  turnId: string;
  grantRoot?: string | null;
  reason?: string | null;
  /** Unix milliseconds when the approval request started. */
  startedAtMs: number;
}

export type FileChangeApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";

export interface FileChangeApprovalResponse {
  decision: FileChangeApprovalDecision;
}

// ── User Input Request (server → client) ───────────────────────────

export interface UserInputRequestParams {
  itemId: string;
  threadId: string;
  turnId: string;
  /** False means the turn goes on without an answer; true means it waits. */
  isBlocking: boolean;
  /** @deprecated The schema points at `isBlocking` to decide whether to block. */
  autoResolutionMs?: number | null;
  questions: Array<{
    id: string;
    header: string;
    question: string;
    isOther?: boolean;
    isSecret?: boolean;
    options?: Array<{ label: string; description: string }> | null;
  }>;
}

export interface UserInputRequestResponse {
  answers: Record<string, { answers: string[] }>;
}

// ── Dynamic Tool Call (server → client) ────────────────────────────

export interface DynamicToolCallParams {
  threadId: string;
  turnId: string;
  callId: string;
  tool: string;
  arguments: unknown;
  /** Namespace the tool was declared under; absent for a top-level tool. */
  namespace?: string | null;
}

export interface DynamicToolCallResponse {
  success: boolean;
  contentItems: Array<
    | { type: "inputText"; text: string }
    | { type: "inputImage"; imageUrl: string }
    | { type: "inputAudio"; audioUrl: string }
  >;
}

// ── Auth Refresh Request (server → client) ─────────────────────────

export interface ChatgptAuthTokensRefreshParams {
  reason: "unauthorized";
  previousAccountId?: string | null;
}

export interface ChatgptAuthTokensRefreshResponse {
  accessToken: string;
  chatgptAccountId: string;
  chatgptPlanType?: string | null;
}
