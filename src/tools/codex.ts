/**
 * codex tool — start a new Codex agent session.
 *
 * It returns as soon as the thread is up. What the turn then does reaches the
 * caller through `codex_check(action="poll", waitMs=…)`, which answers each time
 * Codex says it is working on something new.
 */
import type { SessionManager } from "../session/manager.js";
import type { SessionStartResult } from "../types.js";
import { ErrorCode } from "../types.js";
import type { CodexToolParams } from "../utils/config.js";
import { extractSpawnOptions } from "../utils/config.js";
import { resolveAndValidateCwd } from "../utils/cwd.js";
import { startedTurnResult } from "../utils/execution.js";
import type { SessionDefaults } from "../utils/session-defaults.js";
import { SESSION_DEFAULT_ENV } from "../utils/session-defaults.js";

export async function executeCodex(
  args: CodexToolParams,
  sessionManager: SessionManager,
  serverCwd: string,
  defaults: SessionDefaults
): Promise<SessionStartResult> {
  const cwd = resolveAndValidateCwd(args.cwd, serverCwd);
  const spawnOpts = extractSpawnOptions(args, defaults);
  // The permission level of a turn is stated, never inferred. The tool schema
  // says the same; this is what a caller reaching the function directly hits.
  if (args.sandbox !== undefined && args.permissions !== undefined) {
    throw new Error(
      `Error [${ErrorCode.INVALID_ARGUMENT}]: name sandbox or permissions, not both — a named profile carries the sandbox.`
    );
  }
  if (spawnOpts.approvalPolicy === undefined) {
    throw new Error(
      `Error [${ErrorCode.INVALID_ARGUMENT}]: approvalPolicy is required — the call named none and ${SESSION_DEFAULT_ENV.approvalPolicy} sets none.`
    );
  }
  if (spawnOpts.sandbox === undefined && args.permissions === undefined) {
    throw new Error(
      `Error [${ErrorCode.INVALID_ARGUMENT}]: name a sandbox or a permissions profile — the call named neither and ${SESSION_DEFAULT_ENV.sandbox} sets none.`
    );
  }
  const effort = args.effort ?? defaults.effort;
  const advanced = {
    ...args.advanced,
    approvalTimeoutMs: args.advanced?.approvalTimeoutMs ?? defaults.approvalTimeoutMs,
    approvalsReviewer: args.approvalsReviewer,
    permissions: args.permissions,
  };

  const startResult = await sessionManager.createSession(
    args.prompt,
    cwd,
    spawnOpts,
    effort,
    advanced
  );

  return startedTurnResult(sessionManager, startResult);
}
