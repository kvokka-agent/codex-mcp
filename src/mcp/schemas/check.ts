/** What `codex_check` takes and what it answers with, and the refinement that
 * refuses an input the chosen action has no use for. */
import { z } from "zod";
import {
  ALL_DECISIONS,
  CHECK_ACTIONS,
  MAX_LONG_POLL_WAIT_MS,
  SESSION_STATUSES,
} from "../../types/index.js";
import {
  errorOutputShape,
  interactionStateSchema,
  nextActionSchema,
  progressSchema,
} from "./common.js";
import { type IssueSink, issueSink } from "./issue-sink.js";

export const checkToolOutputShape = {
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

/** decision, both amendments and denyMessage answer an approval and nothing else. */
function rejectPermissionOnlyInputs(value: CheckToolInput, addIssue: IssueSink): void {
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

function rejectPollInputs(value: CheckToolInput, addIssue: IssueSink): void {
  if (value.requestId !== undefined) {
    addIssue("requestId", "requestId is only allowed for respond_* actions.");
  }
  rejectPermissionOnlyInputs(value, addIssue);
  if (value.answers !== undefined) {
    addIssue("answers", "answers is only allowed for action='respond_user_input'.");
  }
}

function rejectPermissionAmendments(value: CheckToolInput, addIssue: IssueSink): void {
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

function rejectPermissionInputs(value: CheckToolInput, addIssue: IssueSink): void {
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

function rejectUserInputInputs(value: CheckToolInput, addIssue: IssueSink): void {
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

export const codexCheckInputSchema = z
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
    const addIssue = issueSink(ctx);

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
