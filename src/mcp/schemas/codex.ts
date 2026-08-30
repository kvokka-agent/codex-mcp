/** What `codex` and `codex_reply` take: the turn's settings, and the refinement
 * that refuses a pair of them naming the same thing twice. */
import { z } from "zod";
import {
  ADVERTISED_EFFORT_LEVELS,
  APPROVAL_POLICIES,
  APPROVALS_REVIEWERS,
  PERSONALITIES,
  SANDBOX_MODES,
  SUMMARY_MODES,
} from "../../types/index.js";
import { SESSION_DEFAULT_ENV, type SessionDefaults } from "../../utils/session-defaults.js";
import { type IssueSink, issueSink } from "./issue-sink.js";

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
function rejectSandboxWithPermissions(value: PermissionSurfaceInput, addIssue: IssueSink): void {
  if (value.sandbox !== undefined && value.permissions !== undefined) {
    addIssue(
      "permissions",
      'Name `sandbox` or `permissions`, not both: a named profile carries the sandbox, and Codex refuses the pair with "`permissions` cannot be combined with `sandbox`".'
    );
  }
}

export function codexInputSchema(sessionDefaults: SessionDefaults) {
  return z.object(codexInputShape(sessionDefaults)).superRefine((value, ctx) => {
    const addIssue = issueSink(ctx);
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

export const codexReplyInputSchema = z
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
    rejectSandboxWithPermissions(value, issueSink(ctx));
  });
