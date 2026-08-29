/**
 * Configuration helpers for codex-mcp.
 */
import type { AppServerSpawnOptions } from "../app-server/lifecycle.js";
import type {
  ApprovalPolicy,
  ApprovalsReviewer,
  EffortLevel,
  Personality,
  SandboxMode,
  SummaryMode,
} from "../types.js";
import type { SessionDefaults } from "./session-defaults.js";

export interface CodexToolParams {
  prompt: string;
  cwd?: string;
  model?: string;
  profile?: string;
  approvalPolicy?: ApprovalPolicy;
  sandbox?: SandboxMode;
  approvalsReviewer?: ApprovalsReviewer;
  permissions?: string;
  effort?: EffortLevel;
  advanced?: {
    baseInstructions?: string;
    developerInstructions?: string;
    personality?: Personality;
    summary?: SummaryMode;
    config?: Record<string, unknown>;
    ephemeral?: boolean;
    outputSchema?: Record<string, unknown>;
    images?: string[];
    approvalTimeoutMs?: number;
  };
}

export function extractSpawnOptions(
  params: CodexToolParams,
  defaults: SessionDefaults
): AppServerSpawnOptions {
  return {
    profile: params.profile,
    model: params.model ?? defaults.model,
    approvalPolicy: params.approvalPolicy ?? defaults.approvalPolicy,
    // A call that names a profile takes no sandbox at all, the environment's
    // default included: `thread/start` refuses the two together with
    // `-32600 \`permissions\` cannot be combined with \`sandbox\``, and
    // `-c sandbox_mode=` on the spawn would fight the profile besides.
    sandbox: params.permissions === undefined ? (params.sandbox ?? defaults.sandbox) : undefined,
    config: params.advanced?.config,
  };
}
