/**
 * The vocabulary a thread and a turn are both configured with: the approval,
 * sandbox and reasoning settings either one carries, and the environments and
 * reviewers either one names.
 *
 * Derived from `codex app-server generate-json-schema`.
 */

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

/**
 * Multi-agent delegation instructions. The schema marks every use of this
 * `@deprecated Ignored` — reasoning effort `ultra` drives the behaviour now.
 */
export type MultiAgentMode = "explicitRequestOnly" | "proactive" | { custom: string };

/** One execution environment offered to a thread or a turn. */
export interface TurnEnvironmentParams {
  environmentId: string;
  cwd: string;
  /** Environment-native workspace roots. Omitted defaults to `cwd`. */
  runtimeWorkspaceRoots?: string[] | null;
}

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
