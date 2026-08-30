/** What `codex_session` takes and what it answers with, and the session record
 * both a listing and a `get` are made of. */
import { z } from "zod";
import { ANSWERED_APPROVALS_REVIEWERS } from "../../app-server/wire/index.js";
import {
  APPROVAL_POLICIES,
  APPROVALS_REVIEWERS,
  CLEANABLE_STATUSES,
  SANDBOX_MODES,
  SESSION_ACTIONS,
  SESSION_STATUSES,
} from "../../types/index.js";
import { errorOutputShape } from "./common.js";

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
    approvalsReviewer: z
      .enum(ANSWERED_APPROVALS_REVIEWERS)
      .optional()
      .describe(
        "Who Codex routes this thread's approval requests to. `guardian_subagent` is the legacy spelling of `auto_review` and is reported as answered."
      ),
    activePermissionProfile: z
      .object({ id: z.string(), extends: z.string().optional() })
      .optional()
      .describe(
        "The permission profile that produced the active permissions, and the only field saying which profile derived `sandbox`."
      ),
  })
  .describe(
    "The settings Codex answered with, which are the ones the session runs with. A field is absent where the answer did not carry it."
  );

/**
 * How a session says what it was asked to run as. A record of a session and the
 * flat answer of `codex_session` carry the same fields in the same order, so
 * they name them once here.
 */
const sessionSettingsShape = {
  cancelledAt: z.string().optional(),
  cancelledReason: z.string().optional(),
  model: z.string().optional(),
  approvalPolicy: z.enum(APPROVAL_POLICIES).optional(),
  sandbox: z.enum(SANDBOX_MODES).optional(),
  permissions: z
    .string()
    .optional()
    .describe("The permission profile id the call named in place of a sandbox."),
  approvalsReviewer: z
    .enum(APPROVALS_REVIEWERS)
    .optional()
    .describe("Who the call asked to review its approval requests."),
};

const publicSessionInfoSchema = z.object({
  sessionId: z.string(),
  status: z.enum(SESSION_STATUSES),
  createdAt: z.string(),
  lastActiveAt: z.string(),
  ...sessionSettingsShape,
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

export const sessionToolInputShape = {
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

export const sessionToolOutputShape = {
  sessions: z.array(publicSessionInfoSchema).optional(),
  sessionId: z.string().optional(),
  status: z.enum(SESSION_STATUSES).optional(),
  createdAt: z.string().optional(),
  lastActiveAt: z.string().optional(),
  ...sessionSettingsShape,
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
