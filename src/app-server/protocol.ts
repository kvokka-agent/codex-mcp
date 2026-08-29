/**
 * codex app-server JSON-RPC protocol types
 *
 * Derived from `codex app-server generate-json-schema`.
 * Wire format for stdio communication with codex app-server subprocess.
 */

// fallow-ignore-file duplicate-export -- `ApprovalPolicy`, `SandboxMode` and
// `Personality` name the same three unions in `src/types.ts`, and the two have
// separate sources of truth: this file follows `codex app-server
// generate-json-schema`, `src/types.ts` follows the tuples the zod enums of
// `src/server.ts` are built from. No barrel re-exports either set, and every
// consumer outside this file imports from `src/types.js`, so the ambiguity the
// rule guards against has nowhere to arise.

// fallow-ignore-file unused-type -- this file is the wire model, and its consumer
// reads it by name rather than by import: `tests/protocol-schema.test.ts` walks
// `checker.getExportsOfModule(protocol.ts)` and holds each exported type against
// the `codex-schema/` definition its `MODELLED_TYPES` map names. Dropping the
// `export` keyword takes a type out of that table and out of the conformance
// check with it.

// ── JSON-RPC Base ──────────────────────────────────────────────────

export type RequestId = string | number;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: RequestId;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: RequestId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

// ── Initialize ─────────────────────────────────────────────────────

export interface InitializeParams {
  clientInfo: { name: string; version: string; title?: string };
  capabilities?: {
    /** Opt into the experimental API methods and fields. Default false. */
    experimentalApi?: boolean;
    /** Exact notification method names the server suppresses for this connection. */
    optOutNotificationMethods?: string[];
    /** MCP extension settings, keyed by extension name — for example `openai/form`. */
    extensions?: Record<string, unknown> | null;
    /** Legacy opt-in for the `openai/form` MCP extension; `extensions` replaces it. */
    mcpServerOpenaiFormElicitation?: boolean;
    /**
     * Opt into `attestation/generate` requests for the upstream
     * `x-oai-attestation` header. Default false, and left false here: this
     * server has no attestation signer to answer with.
     */
    requestAttestation?: boolean;
  };
}

export interface InitializeResult {
  userAgent: string;
}

// ── Shared enums / aliases ─────────────────────────────────────────

/**
 * The string branch of `AskForApproval`, as a list a reader can hold a response
 * field against.
 */
export const APPROVAL_POLICY_PRESETS = ["untrusted", "on-request", "never"] as const;
export type ApprovalPolicy = (typeof APPROVAL_POLICY_PRESETS)[number];

/**
 * Object branch of the schema's `AskForApproval` union: names each approval
 * channel instead of naming a policy preset.
 */
export interface AskForApprovalGranular {
  granular: {
    mcp_elicitations: boolean;
    rules: boolean;
    sandbox_approval: boolean;
    /**
     * Turns on the `item/permissions/requestApproval` server request.
     * Default false, and this server leaves it there — it models no answer to
     * that request.
     */
    request_permissions?: boolean;
    /** Ask before a skill runs. Default false. */
    skill_approval?: boolean;
  };
}

/** Schema `AskForApproval`: a policy preset string, or the `granular` object. */
export type AskForApproval = ApprovalPolicy | AskForApprovalGranular;
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type Personality = "none" | "friendly" | "pragmatic";
/**
 * A non-empty effort value the model advertises. The schema stopped enumerating
 * these, so a closed union here would refuse an effort a newer model accepts.
 */
export type ReasoningEffort = string;
export type ReasoningSummary = "auto" | "concise" | "detailed" | "none";

// ── Thread Management ──────────────────────────────────────────────

/**
 * The `function` variant of the schema's `DynamicToolSpec` and of its
 * `DynamicToolNamespaceTool`, which carry the same shape.
 */
export interface FunctionDynamicToolSpec {
  type: "function";
  name: string;
  description: string;
  inputSchema: unknown;
  /** Withhold the schema from the model until the tool is first called. Default false. */
  deferLoading?: boolean;
}

/** One tool of a `namespace` spec; the schema allows the function variant only. */
export type DynamicToolNamespaceTool = FunctionDynamicToolSpec;

/**
 * A tool the client offers the thread. The `type` discriminator is required and
 * has no default, so a spec without it is refused.
 */
export type DynamicToolSpec =
  | FunctionDynamicToolSpec
  | {
      type: "namespace";
      name: string;
      description: string;
      tools: DynamicToolNamespaceTool[];
    };

/**
 * Every reviewer the schema's `ApprovalsReviewer` enum names, which is what a
 * thread answer can carry.
 */
export const ANSWERED_APPROVALS_REVIEWERS = ["user", "auto_review", "guardian_subagent"] as const;

/**
 * Where approval requests are routed for review. Absent means the schema
 * default `user`. `auto_review` hands the decision to a subagent;
 * `guardian_subagent` is the legacy spelling of it, which this server never
 * sends and a backend can still answer with.
 */
export type ApprovalsReviewer = (typeof ANSWERED_APPROVALS_REVIEWERS)[number];

/** Persisted thread history contract. */
export type ThreadHistoryMode = "legacy" | "paginated";

/**
 * Multi-agent delegation instructions. The schema marks every use of this
 * `@deprecated Ignored` — reasoning effort `ultra` drives the behaviour now.
 */
export type MultiAgentMode = "explicitRequestOnly" | "proactive" | { custom: string };

/** What made the client start this thread. */
export type ThreadStartSource = "startup" | "clear";

/** Client-supplied analytics classification of a thread; free-form string. */
export type ThreadSource = string;

/** Where a selected capability root resolves. The schema gives one variant. */
export type CapabilityRootLocation = {
  type: "environment";
  environmentId: string;
  /** Absolute path for the root in the selected environment. */
  path: string;
};

/** A root the hosting platform selected, exposing one or more capabilities. */
export interface SelectedCapabilityRoot {
  /** Stable identifier supplied by the capability selection platform. */
  id: string;
  location: CapabilityRootLocation;
}

/** One execution environment offered to a thread or a turn. */
export interface TurnEnvironmentParams {
  environmentId: string;
  cwd: string;
  /** Environment-native workspace roots. Omitted defaults to `cwd`. */
  runtimeWorkspaceRoots?: string[] | null;
}

/** thread/start — all fields optional */
export interface ThreadStartParams {
  cwd?: string | null;
  model?: string | null;
  modelProvider?: string | null;
  approvalPolicy?: AskForApproval | null;
  /**
   * v2 schema: sandbox mode string enum ("read-only" | "workspace-write" | "danger-full-access")
   * (Not the SandboxPolicy object used by turn/start's sandboxPolicy.)
   */
  sandbox?: SandboxMode | null;
  personality?: Personality | null;
  ephemeral?: boolean | null;
  /** Caller identity recorded on the thread; free-form string chosen by the client. */
  serviceName?: string | null;
  baseInstructions?: string | null;
  developerInstructions?: string | null;
  config?: Record<string, unknown> | null;
  dynamicTools?: DynamicToolSpec[] | null;
  experimentalRawEvents?: boolean;
  mockExperimentalField?: string | null;
  /**
   * Let a provider with an authoritative model catalogue swap an unavailable
   * requested model for its default. Omitted leaves the unavailable model an error.
   */
  allowProviderModelFallback?: boolean;
  approvalsReviewer?: ApprovalsReviewer | null;
  /**
   * Sticky environments for the thread. Omitted selects the default
   * environment; an empty array disables environment access for every turn that
   * names none; a non-empty array makes its first entry the current environment.
   */
  environments?: TurnEnvironmentParams[] | null;
  historyMode?: ThreadHistoryMode | null;
  /** @deprecated The schema marks this ignored; set `effort: "ultra"` instead. */
  multiAgentMode?: MultiAgentMode | null;
  /** Named permissions profile id. Cannot be combined with `sandbox`. */
  permissions?: string | null;
  /**
   * Project the thread belongs to. A durable thread persists the assignment;
   * an ephemeral one exposes it only in live responses.
   */
  projectId?: string | null;
  /** Replaces the thread's runtime workspace roots. Every path must be absolute. */
  runtimeWorkspaceRoots?: string[] | null;
  selectedCapabilityRoots?: SelectedCapabilityRoot[] | null;
  serviceTier?: string | null;
  sessionStartSource?: ThreadStartSource | null;
  threadSource?: ThreadSource | null;
}

/**
 * What `thread/start`, `thread/fork` and `thread/resume` answer with — the
 * settings the thread runs with, which are not the settings the request asked
 * for. On `codex-cli 0.150.1` a `thread/start` naming neither model nor
 * provider answered `"model":"gpt-5.6-luna","modelProvider":"myproxy"`.
 *
 * The three responses carry the same block (v2/ThreadStartResponse.json,
 * v2/ThreadForkResponse.json, v2/ThreadResumeResponse.json). Modelled here are
 * the id and the settings a session reports; the rest of the block —
 * `instructionSources`, `runtimeWorkspaceRoots`, `serviceTier`,
 * `multiAgentMode` and the resume cursors — has no reader.
 */
export interface ThreadSettingsResult {
  thread: { id: string };
  model: string;
  modelProvider: string;
  cwd: string;
  approvalPolicy: AskForApproval;
  /** The policy object, not the `sandbox` mode string `thread/start` takes. */
  sandbox: SandboxPolicy;
  /** Optional on the response, and null for a model advertising no effort. */
  reasoningEffort?: ReasoningEffort | null;
  /** Who the thread routes its approval requests to, whatever the call named. */
  approvalsReviewer: ApprovalsReviewer;
  /**
   * The profile that produced the active permissions. Null where Codex names
   * none, and the only field saying which profile derived `sandbox`.
   */
  activePermissionProfile?: ActivePermissionProfile | null;
}

/**
 * The permissions profile a thread runs under, as a thread answer names it
 * (schema definition `ActivePermissionProfile`).
 */
export interface ActivePermissionProfile {
  /**
   * An id of `default_permissions`, a built-in such as `:workspace`, or a
   * user-defined `[permissions.<id>]` profile.
   */
  id: string;
  /** The parent id of the profile's `extends`, null where it names no parent. */
  extends?: string | null;
}

/** thread/start response — schema v2/ThreadStartResponse.json. */
export type ThreadStartResult = ThreadSettingsResult;

export interface ThreadForkParams {
  threadId: string;
  approvalPolicy?: AskForApproval | null;
  baseInstructions?: string | null;
  developerInstructions?: string | null;
  model?: string | null;
  modelProvider?: string | null;
  sandbox?: SandboxMode | null;
  cwd?: string | null;
  config?: Record<string, unknown> | null;
  /** [UNSTABLE] Rollout path to fork from; when set it replaces `threadId`. */
  path?: string | null;
  approvalsReviewer?: ApprovalsReviewer | null;
  /**
   * Fork before this turn, dropping it and every later one. Cannot be combined
   * with `lastTurnId`.
   */
  beforeTurnId?: string | null;
  /** Fork through this turn, inclusive. The turn named must not be in progress. */
  lastTurnId?: string | null;
  /**
   * Carry the source thread's goal into the fork without starting its automatic
   * continuation; the next explicit turn owns the goal. Default false.
   */
  deferGoalContinuation?: boolean;
  ephemeral?: boolean;
  /**
   * Answer with thread metadata and fork state only, leaving `thread.turns`
   * unpopulated. Default false.
   */
  excludeTurns?: boolean;
  /** Named permissions profile id. Cannot be combined with `sandbox`. */
  permissions?: string | null;
  /** Replaces the thread's runtime workspace roots. Every path must be absolute. */
  runtimeWorkspaceRoots?: string[] | null;
  serviceTier?: string | null;
  threadSource?: ThreadSource | null;
}

/** thread/fork response — schema v2/ThreadForkResponse.json. */
export type ThreadForkResult = ThreadSettingsResult;

/** How much of each turn a `thread/resume` answer carries back. */
export type TurnItemsView = "notLoaded" | "summary" | "full";

/** The `thread/turns/list` page a resume can bootstrap the client with. */
export interface ThreadResumeInitialTurnsPageParams {
  /** Page size. Omitted leaves the server's default. */
  limit?: number | null;
  /** Omitted defaults to `desc` — newest turn first. */
  sortDirection?: "asc" | "desc" | null;
  /** Omitted defaults to `summary`. */
  itemsView?: TurnItemsView | null;
}

export interface ThreadResumeParams {
  threadId: string;
  approvalPolicy?: AskForApproval | null;
  baseInstructions?: string | null;
  developerInstructions?: string | null;
  model?: string | null;
  modelProvider?: string | null;
  sandbox?: SandboxMode | null;
  personality?: Personality | null;
  cwd?: string | null;
  config?: Record<string, unknown> | null;
  /** [UNSTABLE] Rollout path to resume from; it must match a running thread's. */
  path?: string | null;
  history?: unknown[] | null;
  approvalsReviewer?: ApprovalsReviewer | null;
  /**
   * Answer with thread metadata and resume state only, leaving `thread.turns`
   * unpopulated. Default false.
   */
  excludeTurns?: boolean;
  /**
   * Include a first page of turns in the resume answer, sparing the client a
   * `thread/turns/list` round trip.
   */
  initialTurnsPage?: ThreadResumeInitialTurnsPageParams | null;
  /** Named permissions profile id. Cannot be combined with `sandbox`. */
  permissions?: string | null;
  /** Replaces the thread's runtime workspace roots. Every path must be absolute. */
  runtimeWorkspaceRoots?: string[] | null;
  serviceTier?: string | null;
}

/** thread/resume response — schema v2/ThreadResumeResponse.json. */
export type ThreadResumeResult = ThreadSettingsResult;

/**
 * thread/backgroundTerminals/clean — schema v2/ThreadBackgroundTerminalsCleanParams.json.
 * The response is `{"type":"object"}` with no properties, so the call says
 * nothing about what it cleaned.
 */
export interface ThreadBackgroundTerminalsCleanParams {
  threadId: string;
}

/** thread/backgroundTerminals/list — schema v2/ThreadBackgroundTerminalsListParams.json. */
export interface ThreadBackgroundTerminalsListParams {
  threadId: string;
  /** Opaque cursor a previous page answered with. */
  cursor?: string | null;
  /** Page size. Codex picks one when this is absent. */
  limit?: number | null;
}

/** One entry of the list answer — schema definition `ThreadBackgroundTerminal`. */
export interface ThreadBackgroundTerminal {
  command: string;
  cwd: string;
  itemId: string;
  processId: string;
  osPid?: number | null;
  cpuPercent?: number | null;
  rssKb?: number | null;
}

/** thread/backgroundTerminals/list response — schema v2/ThreadBackgroundTerminalsListResponse.json. */
export interface ThreadBackgroundTerminalsListResult {
  data: ThreadBackgroundTerminal[];
  /** Null when the page is the last one. */
  nextCursor?: string | null;
}

/** thread/backgroundTerminals/terminate — schema v2/ThreadBackgroundTerminalsTerminateParams.json. */
export interface ThreadBackgroundTerminalsTerminateParams {
  threadId: string;
  processId: string;
}

/**
 * thread/backgroundTerminals/terminate response — schema
 * v2/ThreadBackgroundTerminalsTerminateResponse.json. `terminated` is the one
 * per-process measurement the protocol offers.
 */
export interface ThreadBackgroundTerminalsTerminateResult {
  terminated: boolean;
}

// ── Permission profiles ────────────────────────────────────────────

/** permissionProfile/list — schema v2/PermissionProfileListParams.json. */
export interface PermissionProfileListParams {
  /** Working directory whose project config layers are resolved. */
  cwd?: string | null;
  /** Opaque cursor from a previous call. */
  cursor?: string | null;
  /** Page size. Omitted answers the full result set. */
  limit?: number | null;
}

/** One profile of a `permissionProfile/list` page. */
export interface PermissionProfileSummary {
  /** Available permission profile identifier, such as `:read-only`. */
  id: string;
  /** Whether the effective requirements allow selecting this profile. */
  allowed: boolean;
  description?: string | null;
}

/** permissionProfile/list response — schema v2/PermissionProfileListResponse.json. */
export interface PermissionProfileListResult {
  data: PermissionProfileSummary[];
  /** Cursor for the next page. Null means the listing is exhausted. */
  nextCursor?: string | null;
}

/** thread/delete — schema v2/ThreadDeleteParams.json. The response is empty. */
export interface ThreadDeleteParams {
  threadId: string;
}

// ── SandboxPolicy ──────────────────────────────────────────────────

/** The `type` discriminators of `SandboxPolicy`, in the order the schema lists them. */
export const SANDBOX_POLICY_TYPES = [
  "dangerFullAccess",
  "readOnly",
  "externalSandbox",
  "workspaceWrite",
] as const;

export type SandboxPolicy =
  | { type: "dangerFullAccess" }
  | { type: "readOnly"; networkAccess?: boolean }
  | { type: "externalSandbox"; networkAccess?: "restricted" | "enabled" }
  | {
      type: "workspaceWrite";
      /** Absolute paths. Default `[]`, which leaves only the thread cwd writable. */
      writableRoots?: string[];
      /** Default false. */
      networkAccess?: boolean;
      excludeSlashTmp?: boolean;
      excludeTmpdirEnvVar?: boolean;
    };

/** Map user-facing sandbox mode string to protocol SandboxPolicy */
export function toSandboxPolicy(mode: SandboxMode | string): SandboxPolicy | undefined {
  switch (mode) {
    case "read-only":
      return { type: "readOnly" };
    case "workspace-write":
      return { type: "workspaceWrite" };
    case "danger-full-access":
      return { type: "dangerFullAccess" };
    default:
      return undefined;
  }
}

// ── Turn Management ────────────────────────────────────────────────

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

// ── Event Notification Params ──────────────────────────────────────

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

// ── Protocol Method Constants ──────────────────────────────────────

export const Methods = {
  // Client → Server
  INITIALIZE: "initialize",
  THREAD_START: "thread/start",
  THREAD_RESUME: "thread/resume",
  THREAD_FORK: "thread/fork",
  THREAD_BACKGROUND_TERMINALS_CLEAN: "thread/backgroundTerminals/clean",
  THREAD_BACKGROUND_TERMINALS_LIST: "thread/backgroundTerminals/list",
  THREAD_BACKGROUND_TERMINALS_TERMINATE: "thread/backgroundTerminals/terminate",
  THREAD_DELETE: "thread/delete",
  PERMISSION_PROFILE_LIST: "permissionProfile/list",
  TURN_START: "turn/start",
  TURN_INTERRUPT: "turn/interrupt",
  TURN_STEER: "turn/steer",

  // Server → Client requests
  COMMAND_APPROVAL: "item/commandExecution/requestApproval",
  FILE_CHANGE_APPROVAL: "item/fileChange/requestApproval",
  USER_INPUT_REQUEST: "item/tool/requestUserInput",
  DYNAMIC_TOOL_CALL: "item/tool/call",
  AUTH_TOKEN_REFRESH: "account/chatgptAuthTokens/refresh",
  LEGACY_PATCH_APPROVAL: "applyPatchApproval",
  LEGACY_EXEC_APPROVAL: "execCommandApproval",

  // Server → Client notifications
  ERROR: "error",
  THREAD_STARTED: "thread/started",
  THREAD_STATUS_CHANGED: "thread/status/changed",
  THREAD_CLOSED: "thread/closed",
  THREAD_COMPACTED: "thread/compacted",
  THREAD_ARCHIVED: "thread/archived",
  THREAD_UNARCHIVED: "thread/unarchived",
  THREAD_NAME_UPDATED: "thread/name/updated",
  THREAD_TOKEN_USAGE_UPDATED: "thread/tokenUsage/updated",
  TURN_STARTED: "turn/started",
  TURN_COMPLETED: "turn/completed",
  TURN_DIFF_UPDATED: "turn/diff/updated",
  TURN_PLAN_UPDATED: "turn/plan/updated",
  ITEM_STARTED: "item/started",
  ITEM_COMPLETED: "item/completed",
  AGENT_MESSAGE_DELTA: "item/agentMessage/delta",
  COMMAND_OUTPUT_DELTA: "item/commandExecution/outputDelta",
  COMMAND_TERMINAL_INTERACTION: "item/commandExecution/terminalInteraction",
  FILE_CHANGE_OUTPUT_DELTA: "item/fileChange/outputDelta",
  REASONING_TEXT_DELTA: "item/reasoning/textDelta",
  REASONING_SUMMARY_DELTA: "item/reasoning/summaryTextDelta",
  REASONING_SUMMARY_PART_ADDED: "item/reasoning/summaryPartAdded",
  PLAN_DELTA: "item/plan/delta",
  MCP_TOOL_PROGRESS: "item/mcpToolCall/progress",
  AUTO_APPROVAL_REVIEW_STARTED: "item/autoApprovalReview/started",
  AUTO_APPROVAL_REVIEW_COMPLETED: "item/autoApprovalReview/completed",
  AUTO_APPROVAL_REVIEW_STRICT_REQUIRED: "autoApprovalReview/strictReviewRequired",
  MODEL_REROUTED: "model/rerouted",
  FUZZY_FILE_SEARCH_SESSION_UPDATED: "fuzzyFileSearch/sessionUpdated",
  FUZZY_FILE_SEARCH_SESSION_COMPLETED: "fuzzyFileSearch/sessionCompleted",
  WINDOWS_WORLD_WRITABLE_WARNING: "windows/worldWritableWarning",
  ACCOUNT_LOGIN_COMPLETED: "account/login/completed",
  DEPRECATION_NOTICE: "deprecationNotice",
  CONFIG_WARNING: "configWarning",
  WARNING: "warning",
  GUARDIAN_WARNING: "guardianWarning",
  MODEL_SAFETY_BUFFERING_UPDATED: "model/safetyBuffering/updated",
  HOOK_STARTED: "hook/started",
  HOOK_COMPLETED: "hook/completed",
} as const;
