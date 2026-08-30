/** The schema pieces more than one tool answers with. */
import { z } from "zod";

export const errorOutputShape = {
  error: z.string().optional(),
  isError: z.boolean().optional(),
};

export const interactionStateSchema = z.enum(["working", "waiting_input", "finished"]);
export const nextActionSchema = z.enum([
  "poll",
  "respond_permission",
  "respond_user_input",
  "none",
]);
export const progressSchema = z.object({
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

export const sessionStartOutputShape = {
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
