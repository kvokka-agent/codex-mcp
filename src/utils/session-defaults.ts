/**
 * How a session starts when the caller names nothing.
 *
 * The client that launches the server sets these, so the model, the reasoning
 * effort, the approval timeout, the approval policy and the sandbox of a
 * session are a property of the installation rather than of whatever the caller
 * happened to pass.
 */
import type { ApprovalPolicy, EffortLevel, SandboxMode } from "../types.js";
import {
  APPROVAL_POLICIES,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  DEFAULT_EFFORT_LEVEL,
  SANDBOX_MODES,
} from "../types.js";

export const SESSION_DEFAULT_ENV = {
  model: "CODEX_MCP_DEFAULT_MODEL",
  effort: "CODEX_MCP_DEFAULT_EFFORT",
  approvalTimeoutMs: "CODEX_MCP_DEFAULT_APPROVAL_TIMEOUT_MS",
  approvalPolicy: "CODEX_MCP_DEFAULT_APPROVAL_POLICY",
  sandbox: "CODEX_MCP_DEFAULT_SANDBOX",
} as const;

export interface SessionDefaults {
  /** Unset leaves the model to the Codex CLI's own `config.toml`. */
  model?: string;
  effort: EffortLevel;
  approvalTimeoutMs: number;
  /** Unset keeps `approvalPolicy` a required parameter of the `codex` tool. */
  approvalPolicy?: ApprovalPolicy;
  /** Unset keeps `sandbox` a required parameter of the `codex` tool. */
  sandbox?: SandboxMode;
}

function readValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function readOneOf<T extends string>(
  env: NodeJS.ProcessEnv,
  name: string,
  allowed: readonly T[],
  what: string
): T | undefined {
  const value = readValue(env, name);
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`${name}="${value}" is not ${what}. Use one of: ${allowed.join(", ")}.`);
  }
  return value as T;
}

/**
 * Read a value the backend, not this server, decides the vocabulary of.
 *
 * A variable set to whitespace is a client that meant to name something and
 * wrote nothing, so it stops the server rather than resolving to the built-in
 * default.
 */
function readNonBlank(env: NodeJS.ProcessEnv, name: string, what: string): string | undefined {
  const raw = env[name];
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (!value) {
    throw new Error(`${name}="${raw}" is not ${what}. Name a non-empty value.`);
  }
  return value;
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
    effort:
      readNonBlank(env, SESSION_DEFAULT_ENV.effort, "a reasoning effort") ?? DEFAULT_EFFORT_LEVEL,
    approvalTimeoutMs: readApprovalTimeoutMs(env),
    approvalPolicy: readOneOf(
      env,
      SESSION_DEFAULT_ENV.approvalPolicy,
      APPROVAL_POLICIES,
      "an approval policy"
    ),
    sandbox: readOneOf(env, SESSION_DEFAULT_ENV.sandbox, SANDBOX_MODES, "a sandbox mode"),
  };
}
