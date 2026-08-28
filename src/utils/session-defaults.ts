/**
 * How a session starts when the caller names nothing.
 *
 * The client that launches the server sets these, so the model, the reasoning
 * effort and the approval timeout of a session are a property of the
 * installation rather than of whatever the caller happened to pass.
 */
import type { EffortLevel } from "../types.js";
import { DEFAULT_APPROVAL_TIMEOUT_MS, DEFAULT_EFFORT_LEVEL, EFFORT_LEVELS } from "../types.js";

export const SESSION_DEFAULT_ENV = {
  model: "CODEX_MCP_DEFAULT_MODEL",
  effort: "CODEX_MCP_DEFAULT_EFFORT",
  approvalTimeoutMs: "CODEX_MCP_DEFAULT_APPROVAL_TIMEOUT_MS",
} as const;

export interface SessionDefaults {
  /** Unset leaves the model to the Codex CLI's own `config.toml`. */
  model?: string;
  effort: EffortLevel;
  approvalTimeoutMs: number;
}

function readValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function readEffort(env: NodeJS.ProcessEnv): EffortLevel {
  const value = readValue(env, SESSION_DEFAULT_ENV.effort);
  if (value === undefined) return DEFAULT_EFFORT_LEVEL;
  if (!(EFFORT_LEVELS as readonly string[]).includes(value)) {
    throw new Error(
      `${SESSION_DEFAULT_ENV.effort}="${value}" is not a reasoning effort. Use one of: ${EFFORT_LEVELS.join(", ")}.`
    );
  }
  return value as EffortLevel;
}

function readApprovalTimeoutMs(env: NodeJS.ProcessEnv): number {
  const value = readValue(env, SESSION_DEFAULT_ENV.approvalTimeoutMs);
  if (value === undefined) return DEFAULT_APPROVAL_TIMEOUT_MS;
  const ms = Number(value);
  if (!Number.isSafeInteger(ms) || ms <= 0) {
    throw new Error(
      `${SESSION_DEFAULT_ENV.approvalTimeoutMs}="${value}" is not a whole number of milliseconds above zero.`
    );
  }
  return ms;
}

/**
 * Read the defaults, or throw naming the variable that could not be read.
 *
 * The server stops on an unreadable value instead of standing the built-in one
 * in its place: a session started on a default nobody configured is shaped
 * exactly like one started on the configured value, and the difference only
 * surfaces in the bill or in a turn that stopped at an approval.
 */
export function resolveSessionDefaults(env: NodeJS.ProcessEnv = process.env): SessionDefaults {
  return {
    model: readValue(env, SESSION_DEFAULT_ENV.model),
    effort: readEffort(env),
    approvalTimeoutMs: readApprovalTimeoutMs(env),
  };
}
