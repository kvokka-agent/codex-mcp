/**
 * codex tool — start a new Codex agent session.
 *
 * It returns as soon as the thread is up. What the turn then does reaches the
 * caller through `codex_check(action="poll", waitMs=…)`, which answers each time
 * Codex says it is working on something new.
 */
import type { SessionManager } from "../session/manager.js";
import type { ProgressInfo, SessionStartResult } from "../types.js";
import { DEFAULT_EFFORT_LEVEL } from "../types.js";
import type { CodexToolParams } from "../utils/config.js";
import { extractSpawnOptions } from "../utils/config.js";
import { resolveAndValidateCwd } from "../utils/cwd.js";
import {
  coerceProgressForStatus,
  interactionStateForStatus,
  recommendedNextActionForStatus,
} from "../utils/execution.js";

function safeGetProgress(
  sessionManager: SessionManager,
  sessionId: string
): ProgressInfo | undefined {
  return typeof (sessionManager as SessionManager & { getProgress?: unknown }).getProgress ===
    "function"
    ? (
        sessionManager as SessionManager & { getProgress: (id: string) => ProgressInfo }
      ).getProgress(sessionId)
    : undefined;
}

export async function executeCodex(
  args: CodexToolParams,
  sessionManager: SessionManager,
  serverCwd: string
): Promise<SessionStartResult> {
  const cwd = resolveAndValidateCwd(args.cwd, serverCwd);
  const spawnOpts = extractSpawnOptions(args);
  const effort = args.effort ?? DEFAULT_EFFORT_LEVEL;

  const startResult = await sessionManager.createSession(
    args.prompt,
    cwd,
    spawnOpts,
    effort,
    args.advanced
  );

  return {
    ...startResult,
    progress: coerceProgressForStatus(
      "running",
      safeGetProgress(sessionManager, startResult.sessionId) ?? startResult.progress
    ),
    interactionState: interactionStateForStatus("running"),
    recommendedNextAction: recommendedNextActionForStatus("running"),
  };
}
