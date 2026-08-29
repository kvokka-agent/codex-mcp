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
  // The permission level of a turn is stated, never inferred: the tool schema
  // requires both where the environment sets neither, and this is what a caller
  // reaching the function directly hits.
  for (const [name, value] of [
    ["approvalPolicy", spawnOpts.approvalPolicy],
    ["sandbox", spawnOpts.sandbox],
  ] as const) {
    if (value === undefined) {
      throw new Error(
        `Error [${ErrorCode.INVALID_ARGUMENT}]: ${name} is required — the call named none and ${SESSION_DEFAULT_ENV[name]} sets none.`
      );
    }
  }
  const effort = args.effort ?? defaults.effort;
  const advanced = {
    ...args.advanced,
    approvalTimeoutMs: args.advanced?.approvalTimeoutMs ?? defaults.approvalTimeoutMs,
    approvalsReviewer: args.approvalsReviewer,
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
