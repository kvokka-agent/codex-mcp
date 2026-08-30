/**
 * Starting, forking, resuming and deleting a thread, and the background
 * terminals and permission profiles a thread owns.
 *
 * Derived from `codex app-server generate-json-schema`.
 */
import type {
  ApprovalsReviewer,
  AskForApproval,
  MultiAgentMode,
  Personality,
  ReasoningEffort,
  SandboxMode,
  SandboxPolicy,
  TurnEnvironmentParams,
} from "./common.js";

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

/** Persisted thread history contract. */
export type ThreadHistoryMode = "legacy" | "paginated";

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
