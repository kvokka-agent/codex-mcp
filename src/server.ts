/**
 * MCP Server definition — registers tools and handles requests.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerResources } from "./resources/register-resources.js";
import { SessionManager, type SessionManagerOptions } from "./session/manager.js";
import { executeCodex } from "./tools/codex.js";
import { executeCodexCheck } from "./tools/codex-check.js";
import { executeCodexReply } from "./tools/codex-reply.js";
import { executeCodexSession } from "./tools/codex-session.js";
import { executeCodexSetup } from "./tools/codex-setup.js";
import {
  ADVERTISED_EFFORT_LEVELS,
  ALL_DECISIONS,
  APPROVAL_POLICIES,
  APPROVALS_REVIEWERS,
  CHECK_ACTIONS,
  CLEANABLE_STATUSES,
  ErrorCode,
  MAX_LONG_POLL_WAIT_MS,
  PERSONALITIES,
  SANDBOX_MODES,
  SESSION_ACTIONS,
  SESSION_STATUSES,
  SUMMARY_MODES,
} from "./types.js";
import { PollWindow } from "./utils/poll-window.js";
import { progressReporterFor } from "./utils/progress-notifier.js";
import { redactPaths } from "./utils/redact.js";
import {
  resolveSessionDefaults,
  SESSION_DEFAULT_ENV,
  type SessionDefaults,
} from "./utils/session-defaults.js";
import { classifyTurnCompatibilityError, compatibilityErrorMessage } from "./utils/turn-compat.js";

declare const __PKG_VERSION__: string;
const SERVER_VERSION = typeof __PKG_VERSION__ !== "undefined" ? __PKG_VERSION__ : "0.0.0-dev";

function formatErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const compatibilityKind = classifyTurnCompatibilityError(err);
  if (compatibilityKind) {
    return compatibilityErrorMessage(compatibilityKind);
  }
  const m = /^Error \[([A-Z_]+)\]:\s*(.*)$/.exec(message);
  if (m) {
    const [, code, rest] = m;
    if (code === ErrorCode.INTERNAL) {
      return `Error [${ErrorCode.INTERNAL}]: ${redactPaths(rest)}`;
    }
    return message;
  }
  return `Error [${ErrorCode.INTERNAL}]: ${redactPaths(message)}`;
}

function toStructuredContent(value: unknown): Record<string, unknown> {
  // MCP structuredContent is object-shaped; wrap non-object payloads for compatibility.
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { value };
}

export interface ServerContext {
  server: McpServer;
  sessionManager: SessionManager;
}

/** Everything the five tool registrations read out of one server. */
interface ToolContext {
  server: McpServer;
  sessionManager: SessionManager;
  serverCwd: string;
  sessionDefaults: SessionDefaults;
  pollWindow: PollWindow;
}

/** The envelope MCP reads: the payload as text, as structured content, and whether it failed. */
function toolEnvelope(result: unknown, isError: boolean) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    structuredContent: toStructuredContent(result),
    isError,
  };
}

/**
 * Run a tool handler and answer in that envelope. A throw becomes the error
 * envelope; `isErrorOf` reads failure out of a payload that reports its own.
 */
async function runTool(run: () => unknown, isErrorOf: (result: unknown) => boolean = () => false) {
  try {
    const result = await run();
    return toolEnvelope(result, isErrorOf(result));
  } catch (err: unknown) {
    const message = formatErrorMessage(err);
    return {
      content: [{ type: "text" as const, text: message }],
      structuredContent: { error: message, isError: true },
      isError: true,
    };
  }
}

/** A payload that carries no `isError` did not fail. */
function payloadIsError(result: unknown): boolean {
  return typeof (result as { isError?: boolean }).isError === "boolean"
    ? (result as { isError: boolean }).isError
    : false;
}

const lastTurnSchema = z
  .object({
    turnId: z.string(),
    outcome: z.enum(["completed", "error", "cancelled"]).optional(),
    status: z.string().optional(),
    completedAt: z.string(),
    error: z.string().optional(),
  })
  .describe(
    "How the last turn ended. `status` says what the session is now, and a session closed after it answered reads `cancelled`; this says what the work came to, and closing the session does not touch it."
  );

/**
 * What Codex answered the session's thread call with. `cwd` is a path, so it
 * rides with the other sensitive fields of `get` and is absent everywhere else.
 */
const effectiveSettingsSchema = z
  .object({
    model: z.string().optional(),
    modelProvider: z.string().optional(),
    reasoningEffort: z.string().optional(),
    approvalPolicy: z
      .union([z.enum(APPROVAL_POLICIES), z.record(z.string(), z.unknown())])
      .optional(),
    sandbox: z.record(z.string(), z.unknown()).optional(),
    cwd: z.string().optional(),
  })
  .describe(
    "The settings Codex answered with, which are the ones the session runs with. A field is absent where the answer did not carry it."
  );

const publicSessionInfoSchema = z.object({
  sessionId: z.string(),
  status: z.enum(SESSION_STATUSES),
  createdAt: z.string(),
  lastActiveAt: z.string(),
  cancelledAt: z.string().optional(),
  cancelledReason: z.string().optional(),
  model: z.string().optional(),
  approvalPolicy: z.enum(APPROVAL_POLICIES).optional(),
  sandbox: z.enum(SANDBOX_MODES).optional(),
  pendingRequestCount: z.number().int(),
  activity: z
    .string()
    .optional()
    .describe("The last line the session said it was doing, in Codex's own words."),
  owner: z
    .object({ pid: z.number().int(), state: z.enum(["self", "other"]) })
    .optional()
    .describe(
      "The codex-mcp process holding the session. Absent means nobody holds it, which is what makes it resumable."
    ),
  lastTurn: lastTurnSchema.optional(),
  effective: effectiveSettingsSchema.optional(),
});

const errorOutputShape = {
  error: z.string().optional(),
  isError: z.boolean().optional(),
};

const interactionStateSchema = z.enum(["working", "waiting_input", "finished"]);
const nextActionSchema = z.enum(["poll", "respond_permission", "respond_user_input", "none"]);
const progressSchema = z.object({
  phase: z.enum([
    "starting",
    "running",
    "reasoning",
    "acting",
    "waiting_approval",
    "finished",
    "error",
    "cancelled",
  ]),
  lastEventAt: z.string(),
  activeTurnId: z.string().optional(),
  pendingActionCount: z.number().int(),
  tokens: z
    .object({
      input: z.number().optional(),
      output: z.number().optional(),
      total: z.number().optional(),
    })
    .optional(),
  activity: z
    .string()
    .optional()
    .describe("One line in Codex's own words saying what it is doing right now."),
  activitySince: z.string().optional().describe("ISO instant that line arrived."),
  activityStandingMs: z
    .number()
    .int()
    .optional()
    .describe(
      "How long the session has been on that line (ms). Report it as it stands — 'writing the migration — 15 min' — rather than counting your own polls."
    ),
});

const setupResultShape = {
  ready: z.boolean(),
  cwd: z.string(),
  executable: z.object({
    ok: z.boolean(),
    source: z.string(),
    command: z.string().optional(),
    isPath: z.boolean().optional(),
    detail: z.string(),
  }),
  auth: z.object({
    ok: z.boolean(),
    state: z.enum(["authenticated", "unauthenticated", "unknown"]),
    detail: z.string(),
  }),
  backend: z.object({
    ok: z.boolean(),
    cliVersion: z.string().nullable(),
    minimumCliVersion: z.string(),
    detail: z.string(),
  }),
  runtime: z.object({
    sameMachineRequired: z.boolean(),
    stateDir: z.string(),
  }),
  projectContext: z.object({
    hasUserConfig: z.boolean(),
    hasProjectConfig: z.boolean(),
  }),
  permissionProfiles: z
    .object({
      ok: z.boolean(),
      profiles: z
        .array(
          z.object({
            id: z.string(),
            allowed: z.boolean(),
            description: z.string().optional(),
          })
        )
        .optional(),
      detail: z.string(),
    })
    .describe(
      "The ids a `codex` call may pass as `permissions`. `profiles` is absent where the listing failed or was never run, which is not the same as a machine offering none."
    ),
  warnings: z.array(z.string()),
  nextSteps: z.array(z.string()),
};

const sessionStartOutputShape = {
  sessionId: z.string().optional(),
  threadId: z.string().optional(),
  status: z.enum(["running", "waiting_approval", "idle", "error", "cancelled"]).optional(),
  pollInterval: z
    .number()
    .int()
    .optional()
    .describe(
      "Recommended minimum delay before next poll (ms): running >=120000, waiting_approval ~=1000."
    ),
  compatWarnings: z.array(z.string()).optional(),
  progress: progressSchema.optional(),
  interactionState: interactionStateSchema.optional(),
  recommendedNextAction: nextActionSchema.optional(),
  ...errorOutputShape,
};

const sessionToolInputShape = {
  action: z.enum(SESSION_ACTIONS),
  sessionId: z
    .string()
    .optional()
    .describe(
      "Required for get/resume/cancel/interrupt/steer/fork/clean_background_terminals/terminate_background_terminal"
    ),
  includeSensitive: z
    .boolean()
    .default(false)
    .optional()
    .describe("Include cwd/config/threadId/profile in get (default: false)"),
  statuses: z
    .array(z.enum(CLEANABLE_STATUSES))
    .optional()
    .describe("For clean only. Default: idle/error/cancelled — abandoned only on request."),
  olderThanMs: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("For clean only. Remove sessions idle for at least this many ms."),
  dryRun: z.boolean().optional().describe("For clean only. Preview matched sessions."),
  includeDisk: z
    .boolean()
    .optional()
    .describe("For clean only. Default: true. Also remove persisted session state."),
  processId: z
    .string()
    .optional()
    .describe(
      "For terminate_background_terminal only. The processId clean_background_terminals reported for that terminal."
    ),
  prompt: z
    .string()
    .min(1)
    .optional()
    .describe(
      "For steer only. What to add to the turn already running — a correction, a constraint, an extra task."
    ),
};

const backgroundTerminalOutcomeSchema = z.object({
  processId: z.string(),
  itemId: z.string().optional(),
  command: z.string().optional(),
  cwd: z.string().optional(),
  osPid: z.number().int().nullable().optional(),
  cpuPercent: z.number().nullable().optional(),
  rssKb: z.number().int().nullable().optional(),
  terminated: z
    .boolean()
    .optional()
    .describe(
      "What thread/backgroundTerminals/terminate answered for this process. Absent when that call failed, and `error` says why."
    ),
  error: z.string().optional().describe("Why the terminate call for this process failed."),
  gone: z
    .boolean()
    .optional()
    .describe(
      "Absent from the listing taken after the pass. Absent itself when that listing failed, which leaves this terminal's fate unknown."
    ),
});

const backgroundTerminalsSchema = z
  .object({
    threadId: z.string(),
    terminals: z
      .array(backgroundTerminalOutcomeSchema)
      .describe("Every terminal the call acted on, with what happened to each."),
    survivors: z
      .array(backgroundTerminalOutcomeSchema)
      .optional()
      .describe(
        "What thread/backgroundTerminals/list answered after the pass: the terminals still standing, including any that started during it. Absent when that listing failed."
      ),
    truncated: z
      .boolean()
      .optional()
      .describe("The listing stopped at the page bound with a cursor still to follow."),
    cleanCalled: z
      .boolean()
      .optional()
      .describe(
        "thread/backgroundTerminals/clean swept the thread because the listing failed. It answers an empty object, so what it left running is unknown."
      ),
    listError: z
      .object({ stage: z.enum(["before", "after"]), message: z.string() })
      .optional()
      .describe(
        "The listing failed at this stage, so the state it would have measured is unknown."
      ),
  })
  .describe("What a background-terminal action measured.");

const sessionToolOutputShape = {
  sessions: z.array(publicSessionInfoSchema).optional(),
  sessionId: z.string().optional(),
  status: z.enum(SESSION_STATUSES).optional(),
  createdAt: z.string().optional(),
  lastActiveAt: z.string().optional(),
  cancelledAt: z.string().optional(),
  cancelledReason: z.string().optional(),
  model: z.string().optional(),
  approvalPolicy: z.enum(APPROVAL_POLICIES).optional(),
  sandbox: z.enum(SANDBOX_MODES).optional(),
  pendingRequestCount: z.number().int().optional(),
  activity: z.string().optional(),
  lastTurn: lastTurnSchema.optional(),
  owner: z.object({ pid: z.number().int(), state: z.enum(["self", "other"]) }).optional(),
  threadId: z.string().optional(),
  cwd: z.string().optional(),
  profile: z.string().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  effective: effectiveSettingsSchema.optional(),
  pollInterval: z
    .number()
    .int()
    .optional()
    .describe(
      "Recommended minimum delay before next poll (ms): running >=120000, waiting_approval ~=1000."
    ),
  turnId: z
    .string()
    .optional()
    .describe(
      "For steer: the turn the steer joined. It is the turn that was already running, not a new one."
    ),
  matchedSessionIds: z.array(z.string()).optional(),
  removedSessionIds: z.array(z.string()).optional(),
  removedCount: z.number().int().optional(),
  diskSessionsRemoved: z.number().int().optional(),
  dryRun: z.boolean().optional(),
  backgroundTerminals: backgroundTerminalsSchema.optional(),
  success: z.boolean().optional(),
  message: z.string().optional(),
  ...errorOutputShape,
};

const checkToolOutputShape = {
  sessionId: z.string().optional(),
  status: z.enum(SESSION_STATUSES).optional(),
  pollInterval: z
    .number()
    .int()
    .optional()
    .describe(
      "Recommended minimum delay before next poll (ms): running >=120000, waiting_approval ~=1000."
    ),
  progress: progressSchema.optional(),
  interactionState: interactionStateSchema.optional(),
  recommendedNextAction: nextActionSchema.optional(),
  actions: z
    .array(
      z.object({
        type: z.enum(["approval", "user_input"]),
        requestId: z.string(),
        kind: z.enum(["command", "fileChange", "user_input"]),
        params: z.unknown(),
        itemId: z.string(),
        reason: z.string().optional(),
        approvalId: z.string().optional(),
        commandActions: z.array(z.unknown()).nullable().optional(),
        proposedExecpolicyAmendment: z.array(z.string()).nullable().optional(),
        availableDecisions: z.array(z.unknown()).nullable().optional(),
        proposedNetworkPolicyAmendments: z.array(z.unknown()).nullable().optional(),
        additionalPermissions: z.unknown().optional(),
        networkApprovalContext: z.unknown().optional(),
        createdAt: z.string(),
      })
    )
    .optional()
    .describe("What the caller must answer. Empty while the turn needs nothing."),
  warnings: z
    .array(
      z.object({
        method: z.string(),
        message: z.string(),
        at: z.string(),
      })
    )
    .optional()
    .describe(
      "Why the turn is producing no output, newest last: a backend warning, a model buffering reason, or a hook that blocked it. Report these beside progress.activity — the activity line is what the turn is doing, a warning is what stands in its way."
    ),
  result: z
    .object({
      turnId: z.string(),
      outcome: z.enum(["completed", "error", "cancelled"]).optional(),
      text: z.string().optional(),
      structuredOutput: z.unknown().optional(),
      turn: z.unknown().optional(),
      status: z.string().optional(),
      turnError: z.unknown().optional(),
      error: z.string().optional(),
      completedAt: z.string(),
    })
    .optional()
    .describe(
      "The finished turn's answer. Every check of a terminal session carries it, so a caller that lost it reads it back rather than filling it in from memory."
    ),
  waitedMs: z
    .number()
    .int()
    .optional()
    .describe(
      "How long this poll held the call before answering (ms). Present on poll with waitMs."
    ),
  ...errorOutputShape,
};

// What `codex_check` used to take. A caller that still sends one is told what
// replaced it, rather than polling on and wondering why the response looks
// nothing like the one it asked for.
const REMOVED_CHECK_INPUTS: Record<string, string> = {
  maxEvents:
    "maxEvents was removed: codex_check reports status, actions and the finished turn's result, never events. The turn's transcript is in the Codex rollout log under ~/.codex/sessions/.",
  cursor: "cursor was removed: there is no event stream to page through.",
  nextCursor: "nextCursor was removed: there is no event stream to page through.",
  responseMode:
    "responseMode was removed: every action of codex_check answers with the same status payload.",
  pollOptions: "pollOptions was removed: pass waitMs at the top level.",
};

/** The shape the `codex_check` refinement reads, whatever else the caller sent. */
interface CheckToolInput {
  action: (typeof CHECK_ACTIONS)[number];
  waitMs?: number | undefined;
  requestId?: string | undefined;
  decision?: string | undefined;
  execpolicy_amendment?: string[] | undefined;
  network_policy_amendment?: unknown;
  denyMessage?: string | undefined;
  answers?: unknown;
}

type CheckIssueSink = (path: string, message: string) => void;

/** decision, both amendments and denyMessage answer an approval and nothing else. */
function rejectPermissionOnlyInputs(value: CheckToolInput, addIssue: CheckIssueSink): void {
  if (value.decision !== undefined) {
    addIssue("decision", "decision is only allowed for action='respond_permission'.");
  }
  if (value.execpolicy_amendment !== undefined) {
    addIssue(
      "execpolicy_amendment",
      "execpolicy_amendment is only allowed for action='respond_permission'."
    );
  }
  if (value.network_policy_amendment !== undefined) {
    addIssue(
      "network_policy_amendment",
      "network_policy_amendment is only allowed for action='respond_permission'."
    );
  }
  if (value.denyMessage !== undefined) {
    addIssue("denyMessage", "denyMessage is only allowed for action='respond_permission'.");
  }
}

function rejectPollInputs(value: CheckToolInput, addIssue: CheckIssueSink): void {
  if (value.requestId !== undefined) {
    addIssue("requestId", "requestId is only allowed for respond_* actions.");
  }
  rejectPermissionOnlyInputs(value, addIssue);
  if (value.answers !== undefined) {
    addIssue("answers", "answers is only allowed for action='respond_user_input'.");
  }
}

function rejectPermissionAmendments(value: CheckToolInput, addIssue: CheckIssueSink): void {
  const needsExecpolicy = value.decision === "acceptWithExecpolicyAmendment";
  const needsNetworkPolicy = value.decision === "applyNetworkPolicyAmendment";
  if (needsExecpolicy && (!value.execpolicy_amendment || value.execpolicy_amendment.length === 0)) {
    addIssue(
      "execpolicy_amendment",
      "execpolicy_amendment is required and must be non-empty when decision='acceptWithExecpolicyAmendment'."
    );
  }
  if (!needsExecpolicy && value.execpolicy_amendment !== undefined) {
    addIssue(
      "execpolicy_amendment",
      "execpolicy_amendment is only allowed when decision='acceptWithExecpolicyAmendment'."
    );
  }

  if (needsNetworkPolicy && !value.network_policy_amendment) {
    addIssue(
      "network_policy_amendment",
      "network_policy_amendment is required when decision='applyNetworkPolicyAmendment'."
    );
  }
  if (!needsNetworkPolicy && value.network_policy_amendment !== undefined) {
    addIssue(
      "network_policy_amendment",
      "network_policy_amendment is only allowed when decision='applyNetworkPolicyAmendment'."
    );
  }
}

function rejectPermissionInputs(value: CheckToolInput, addIssue: CheckIssueSink): void {
  if (value.waitMs !== undefined) {
    addIssue("waitMs", "waitMs is only allowed for action='poll'.");
  }
  if (!value.requestId) {
    addIssue("requestId", "requestId is required for action='respond_permission'.");
  }
  if (!value.decision) {
    addIssue("decision", "decision is required for action='respond_permission'.");
  }
  if (value.answers !== undefined) {
    addIssue("answers", "answers is only allowed for action='respond_user_input'.");
  }
  rejectPermissionAmendments(value, addIssue);
}

function rejectUserInputInputs(value: CheckToolInput, addIssue: CheckIssueSink): void {
  if (value.waitMs !== undefined) {
    addIssue("waitMs", "waitMs is only allowed for action='poll'.");
  }
  if (!value.requestId) {
    addIssue("requestId", "requestId is required for action='respond_user_input'.");
  }
  if (!value.answers) {
    addIssue("answers", "answers is required for action='respond_user_input'.");
  }
  rejectPermissionOnlyInputs(value, addIssue);
}

const codexCheckInputSchema = z
  .looseObject({
    action: z.enum(CHECK_ACTIONS),
    sessionId: z.string().describe("Target session ID"),
    waitMs: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        `Long-poll for action='poll': block until the status changes, an action arrives or the turn ends. Ask for more than the task can take — ${MAX_LONG_POLL_WAIT_MS} is the maximum — and the server holds the call for as long as this MCP client tolerates one, then answers with the state it found. Omit or 0 to answer at once, which is polling on a timer.`
      ),
    // respond_permission
    requestId: z.string().optional().describe("Request ID from actions[]"),
    decision: z
      .enum(ALL_DECISIONS)
      .optional()
      .describe(
        "Approval decision for respond_permission. acceptWithExecpolicyAmendment requires execpolicy_amendment; applyNetworkPolicyAmendment requires network_policy_amendment."
      ),
    execpolicy_amendment: z
      .array(z.string())
      .optional()
      .describe("For acceptWithExecpolicyAmendment only"),
    network_policy_amendment: z
      .object({
        action: z.enum(["allow", "deny"]),
        host: z.string().min(1),
      })
      .optional()
      .describe("For applyNetworkPolicyAmendment only"),
    denyMessage: z.string().optional().describe("Deny reason (not sent to agent)"),
    // respond_user_input
    answers: z
      .record(
        z.string(),
        z.object({
          answers: z.array(z.string()),
        })
      )
      .optional()
      .describe("question-id -> answers map (id from actions[] user_input request)."),
  })
  .superRefine((value, ctx) => {
    const addIssue = (path: string, message: string) => {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [path],
        message,
      });
    };

    for (const [name, message] of Object.entries(REMOVED_CHECK_INPUTS)) {
      if (name in value) addIssue(name, message);
    }

    switch (value.action) {
      case "poll":
        rejectPollInputs(value, addIssue);
        break;
      case "respond_permission":
        rejectPermissionInputs(value, addIssue);
        break;
      case "respond_user_input":
        rejectUserInputInputs(value, addIssue);
        break;
    }
  });

function codexAdvancedSchema(sessionDefaults: SessionDefaults) {
  return z
    .object({
      baseInstructions: z.string().optional().describe("Replace system instructions."),
      developerInstructions: z.string().optional().describe("Extra developer instructions."),
      personality: z.enum(PERSONALITIES).optional().describe("Personality (default: config.toml)."),
      summary: z.enum(SUMMARY_MODES).optional().describe("Summary mode (default: config.toml)."),
      config: z.record(z.string(), z.unknown()).optional().describe("Override config values."),
      ephemeral: z.boolean().optional().describe("Do not persist thread (default: false)."),
      outputSchema: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Structured output schema."),
      images: z.array(z.string()).optional().describe("Local image paths."),
      approvalTimeoutMs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(`Auto-decline timeout in ms (default: ${sessionDefaults.approvalTimeoutMs})`),
    })
    .optional()
    .describe("Advanced settings.");
}

function codexInputShape(sessionDefaults: SessionDefaults) {
  return {
    prompt: z.string().describe("Task or question"),
    approvalPolicy: sessionDefaults.approvalPolicy
      ? z
          .enum(APPROVAL_POLICIES)
          .optional()
          .describe(
            `Optional enum: untrusted/on-request/never (default: ${sessionDefaults.approvalPolicy}).`
          )
      : z.enum(APPROVAL_POLICIES).describe("Required enum: untrusted/on-request/never."),
    sandbox: z
      .enum(SANDBOX_MODES)
      .optional()
      .describe(
        sessionDefaults.sandbox
          ? `Enum: read-only/workspace-write/danger-full-access (default: ${sessionDefaults.sandbox}). Name this or \`permissions\`, never both.`
          : "Enum: read-only/workspace-write/danger-full-access. Name this or `permissions` — the call must carry one of the two."
      ),
    permissions: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Named permission profile id from a `[permissions.<id>]` table of the Codex config, such as `:read-only` or `:workspace`. It carries the sandbox, so name it instead of `sandbox` and never alongside it. `codex_setup` lists the ids this machine offers; an id it does not offer is refused here with that list."
      ),
    effort: z
      .string()
      .min(1)
      .optional()
      .describe(
        `Reasoning effort (default: ${sessionDefaults.effort}). Codex 0.150.1 advertises ${ADVERTISED_EFFORT_LEVELS.join("/")}, and each model advertises its own set — Codex refuses one the chosen model does not.`
      ),
    approvalsReviewer: z
      .enum(APPROVALS_REVIEWERS)
      .optional()
      .describe(
        "Who decides an approval this turn raises. `user` (the default) routes it to you: `codex_check` reports it in `actions[]` and `respond_permission` answers it. `auto_review` hands it to a Codex subagent that gathers context and applies a risk-based decision framework, so an unattended run needs no answer from you — and a review that denies an action arrives as `progress.activity`."
      ),
    cwd: z.string().optional().describe("Working directory (default: server cwd)."),
    model: z
      .string()
      .optional()
      .describe(`Model override (default: ${sessionDefaults.model ?? "config.toml"})`),
    profile: z.string().optional().describe("Profile name (default: CLI default profile)."),
    advanced: codexAdvancedSchema(sessionDefaults),
  };
}

/** What the permission refinements of `codex` and `codex_reply` read. */
interface PermissionSurfaceInput {
  sandbox?: string | undefined;
  permissions?: string | undefined;
}

/**
 * `sandbox` and `permissions` name the same thing two ways, so a call names one.
 *
 * The pair is refused here rather than by the backend, which answers
 * `-32600 \`permissions\` cannot be combined with \`sandbox\`` after the child
 * process is already up.
 */
function rejectSandboxWithPermissions(
  value: PermissionSurfaceInput,
  addIssue: (path: string, message: string) => void
): void {
  if (value.sandbox !== undefined && value.permissions !== undefined) {
    addIssue(
      "permissions",
      'Name `sandbox` or `permissions`, not both: a named profile carries the sandbox, and Codex refuses the pair with "`permissions` cannot be combined with `sandbox`".'
    );
  }
}

function codexInputSchema(sessionDefaults: SessionDefaults) {
  return z.object(codexInputShape(sessionDefaults)).superRefine((value, ctx) => {
    const addIssue = (path: string, message: string) => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    };
    rejectSandboxWithPermissions(value, addIssue);
    if (
      value.sandbox === undefined &&
      value.permissions === undefined &&
      !sessionDefaults.sandbox
    ) {
      addIssue(
        "sandbox",
        `Name a sandbox — ${SANDBOX_MODES.join("/")} — or a \`permissions\` profile id. The call named neither and ${SESSION_DEFAULT_ENV.sandbox} sets none.`
      );
    }
  });
}

// ── Tool 1: codex — Start a new Codex agent session ──────────────

function registerCodexTool(ctx: ToolContext): void {
  const { server, sessionManager, serverCwd, sessionDefaults } = ctx;
  server.registerTool(
    "codex",
    {
      title: "Start Codex Session",
      description:
        "Start a Codex session and return `{ sessionId, threadId, status, progress }` at once — the turn runs on. Follow it with `codex_check(action='poll', waitMs=300000)` in a loop until the status is terminal: that call answers the moment Codex says it is working on something new, so write its `progress.activity` out where the person waiting reads it, then call again. See `codex-mcp:///quickstart` for the loop, `codex-mcp:///config` for parameter guidance, and `codex-mcp:///delegation-guide` for approval/sandbox presets.",
      inputSchema: codexInputSchema(sessionDefaults),
      outputSchema: sessionStartOutputShape,
      annotations: {
        title: "Start Codex Session",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    (args) => runTool(() => executeCodex(args, sessionManager, serverCwd, sessionDefaults))
  );
}

const codexReplyInputSchema = z
  .object({
    sessionId: z.string().describe("Session ID from codex tool"),
    prompt: z.string().describe("Follow-up message"),
    model: z.string().optional().describe("Override model."),
    approvalPolicy: z.enum(APPROVAL_POLICIES).optional().describe("Override approval policy."),
    approvalsReviewer: z
      .enum(APPROVALS_REVIEWERS)
      .optional()
      .describe(
        "Override who decides an approval this turn raises: `user` routes it to you, `auto_review` to a Codex subagent. The override sticks for later turns."
      ),
    effort: z
      .string()
      .min(1)
      .optional()
      .describe(
        `Override effort. Codex 0.150.1 advertises ${ADVERTISED_EFFORT_LEVELS.join("/")}, and each model advertises its own set — Codex refuses one the chosen model does not.`
      ),
    summary: z.enum(SUMMARY_MODES).optional().describe("Override summary."),
    personality: z.enum(PERSONALITIES).optional().describe("Override personality."),
    sandbox: z
      .enum(SANDBOX_MODES)
      .optional()
      .describe("Override sandbox. Name this or `permissions`, never both."),
    permissions: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Override the permission profile of the turn by id, such as `:read-only`. It carries the sandbox, so name it instead of `sandbox` and never alongside it. The id is recorded on the session, so a resume and a fork restore it, and an id this machine does not offer is refused with the list of the ids it does."
      ),
    cwd: z.string().optional().describe("Override cwd."),
    outputSchema: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Structured output schema override (top-level in codex_reply)."),
  })
  .superRefine((value, ctx) => {
    rejectSandboxWithPermissions(value, (path, message) => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    });
  });

// ── Tool 2: codex_reply — Continue an existing session ───────────

function registerCodexReplyTool(ctx: ToolContext): void {
  const { server, sessionManager } = ctx;
  server.registerTool(
    "codex_reply",
    {
      title: "Continue Codex Session",
      description:
        "Continue existing session. Allowed in `idle`/`error`; otherwise `SESSION_BUSY`. Returns at once and the turn runs on; follow it with the same `codex_check(action='poll', waitMs=300000)` loop as `codex`.",
      inputSchema: codexReplyInputSchema,
      outputSchema: sessionStartOutputShape,
      annotations: {
        title: "Continue Codex Session",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    (args) => runTool(() => executeCodexReply(args, sessionManager))
  );
}

function registerCodexSetupTool(ctx: ToolContext): void {
  const { server, serverCwd, sessionManager } = ctx;
  server.registerTool(
    "codex_setup",
    {
      title: "Codex Setup",
      description:
        "Run local readiness checks for codex-mcp: executable resolution, login status, Codex CLI version against the minimum this server drives, project config, and the permission profile ids this machine offers as `permissions`. Use this before starting a session when setup is uncertain, or to learn which profile ids exist here.",
      inputSchema: {
        cwd: z
          .string()
          .optional()
          .describe("Optional cwd to inspect for project-local Codex config. Default: server cwd."),
      },
      outputSchema: setupResultShape,
      annotations: {
        title: "Codex Setup",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (args) =>
      runTool(() =>
        executeCodexSetup(args, serverCwd, (cwd) => sessionManager.listPermissionProfiles(cwd))
      )
  );
}

// ── Tool 4: codex_session — Manage sessions ──────────────────────

function registerCodexSessionTool(ctx: ToolContext): void {
  const { server, sessionManager } = ctx;
  server.registerTool(
    "codex_session",
    {
      title: "Manage Sessions",
      description: `Session actions: list, get, resume, cancel, interrupt, steer, fork, clean, clean_background_terminals, terminate_background_terminal.

- list: every session of the state directory, this server's and every other server's. Each carries \`activity\` — what it last said it was doing — and \`owner\`, the process holding it. A session with status \`abandoned\` and no \`owner\` was cut off when its server went away and can be resumed.
- get: details. includeSensitive defaults to false; true adds threadId/cwd/profile/config.
- resume: pick an \`abandoned\` session back up and drive it from here. Codex restores the thread from its rollout log, including the turn it was interrupted in; continue with codex_reply. A session another running server holds is refused.
- cancel: terminal.
- interrupt: stop current turn, throwing away what it had done.
- steer: add to the turn already running instead of stopping it. Takes prompt. No turn starts: turnId is the turn the steer joined, status stays running, and the turn's one result still comes at its end — carry on polling. Codex reads the added text at the turn's next model round trip, so a steer sent as a turn ends can miss it, and that answers SESSION_NOT_RUNNING naming the turn rather than reporting a steer that landed.
- fork: clone current thread into a new session; source remains unchanged.
- clean: batch-remove idle/error/cancelled sessions, optionally from disk too. Pass statuses:["abandoned"] to drop cut-off sessions instead of resuming them.
- clean_background_terminals: terminate every background terminal of this thread and answer what happened. backgroundTerminals.terminals lists what was there, each with terminated — what Codex answered for that process — and gone, measured by listing the thread again afterwards. backgroundTerminals.survivors is what was still standing at the end. A listing that failed leaves listError and no measurement, never a claim that the thread is clear.
- terminate_background_terminal: terminate one of them. Takes processId, from a clean_background_terminals answer, and reports terminated; a process that stayed up answers false rather than raising.`,
      inputSchema: sessionToolInputShape,
      outputSchema: sessionToolOutputShape,
      annotations: {
        title: "Manage Sessions",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    (args) => runTool(() => executeCodexSession(args, sessionManager), payloadIsError)
  );
}

// ── Tool 5: codex_check — Poll events + respond to requests ──────

function registerCodexCheckTool(ctx: ToolContext): void {
  const { server, sessionManager, sessionDefaults, pollWindow } = ctx;
  server.registerTool(
    "codex_check",
    {
      title: "Poll & Respond",
      description: `Report where a session stands and answer what it waits for. Every action returns the same payload: { sessionId, status, progress, actions[], result?, interactionState, recommendedNextAction }. The turn's own events are never returned — Codex writes the full transcript to its rollout log under ~/.codex/sessions/. Answer every entry of actions[]; stop checking on terminal status (idle/error/cancelled), where result carries the final answer and keeps carrying it while the session stands there. WARNING: without waitMs you are polling on a timer, and approvalTimeoutMs defaults to ${sessionDefaults.approvalTimeoutMs}ms, so approvals expire between checks unless you raise the timeout, use non-interactive policies, or pass waitMs — which answers the moment an approval arrives. See codex-mcp:///quickstart and codex-mcp:///gotchas.

poll: current status; with waitMs it holds the call until the status changes, an action arrives, the turn ends, or Codex says it is working on something new — and answers with the state it found when the window runs out instead. Loop it: write progress.activity out where the person waiting reads it, then call again. progress.activityStandingMs says how long that same line has stood, so a turn that is still on it reads "compiling — 15 min" rather than repeating itself. waitedMs says how long the call was held. Send _meta.progressToken and the same lines also arrive as notifications/progress while the call is still open, with a heartbeat every 30s.
respond_permission: answer an approval action.
respond_user_input: answer a user-input action.`,
      inputSchema: codexCheckInputSchema,
      outputSchema: checkToolOutputShape,
      annotations: {
        title: "Poll & Respond",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    (args, extra) =>
      runTool(
        () =>
          executeCodexCheck(
            args,
            sessionManager,
            extra.signal,
            pollWindow,
            progressReporterFor(extra._meta, extra.sendNotification)
          ),
        payloadIsError
      )
  );
}

export function createServer(serverCwd: string, options?: SessionManagerOptions): ServerContext {
  // Read before anything is built: an unreadable value stops the server here
  // rather than at the first session it would have started differently.
  const sessionDefaults = resolveSessionDefaults();
  const sessionManager = new SessionManager(options);
  // One per connection: the tool-call ceiling belongs to the client on the
  // other end of the pipe, and every session of that client shares it.
  const pollWindow = new PollWindow();
  const budget = pollWindow.describe();
  console.error(
    `[codex-mcp] long poll: up to ${budget.budgetMs}ms per call (client ceiling: ${budget.ceilingMs ?? "none declared"}, source: ${budget.source})`
  );

  const server = new McpServer({
    name: "codex-mcp",
    version: SERVER_VERSION,
  });

  // Read-only MCP resources (helpful docs / metadata).
  registerResources(server, {
    version: SERVER_VERSION,
    sessionManager,
    sessionDefaults,
    diskPersistence: options?.persistence !== undefined,
  });

  const ctx: ToolContext = { server, sessionManager, serverCwd, sessionDefaults, pollWindow };
  registerCodexTool(ctx);
  registerCodexReplyTool(ctx);
  registerCodexSetupTool(ctx);
  registerCodexSessionTool(ctx);
  registerCodexCheckTool(ctx);

  // Cleanup on server close
  const originalClose = server.close.bind(server);
  server.close = async () => {
    sessionManager.destroy();
    await originalClose();
  };

  return { server, sessionManager };
}
