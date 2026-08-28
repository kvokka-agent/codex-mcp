/**
 * Configuration helpers for codex-mcp.
 */
import type { AppServerSpawnOptions } from "../app-server/lifecycle.js";
import type { SessionDefaults } from "./session-defaults.js";
import type {
  ApprovalPolicy,
  EffortLevel,
  Personality,
  SandboxMode,
  SummaryMode,
} from "../types.js";

export interface CodexToolParams {
  prompt: string;
  cwd?: string;
  model?: string;
  profile?: string;
  approvalPolicy: ApprovalPolicy;
  sandbox: SandboxMode;
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
    approvalPolicy: params.approvalPolicy,
    sandbox: params.sandbox,
    config: params.advanced?.config,
  };
}
