/** Starting a session and continuing it: the turns this server opens itself. */
import { randomUUID } from "node:crypto";
import type { ICodexClient } from "../../app-server/client-interface.js";
import type { AppServerSpawnOptions } from "../../app-server/lifecycle.js";
import {
  DEFAULT_APPROVAL_TIMEOUT_MS,
  DEFAULT_POLL_INTERVAL,
  type EffortLevel,
  ErrorCode,
  type SessionInfo,
  type SessionStartResult,
} from "../../types/index.js";
import { resolveAndValidateFilePath } from "../../utils/files.js";
import { redactPaths } from "../../utils/redact.js";
import { composeDeveloperInstructions } from "../activity-marker.js";
import { assertPermissionProfileSelectable } from "../permission-profiles.js";
import type { CreateSessionAdvanced, SessionRuntime, TurnOverrides } from "./core.js";
import { recordEvent } from "./events.js";
import { registerHandlers } from "./handlers.js";
import { buildProgressInfo } from "./progress.js";
import { extractThreadId, extractTurnId, newSessionRecord } from "./session-decode.js";
import {
  evictSession,
  getClientOrThrow,
  getSessionOrThrow,
  markTurnOutputSchema,
  openNewSession,
  persistSessionIfChanged,
  recordCodexDefaultModel,
  recordEffectiveSettings,
} from "./store.js";
import {
  applyTurnOverrides,
  assertSessionAcceptsTurn,
  buildTurnParams,
  buildUserInput,
  resolveTurnCwd,
  startTurnWithCompatibilityFallback,
} from "./turn-params.js";

export async function createSession(
  runtime: SessionRuntime,
  prompt: string,
  cwd: string,
  spawnOpts: AppServerSpawnOptions,
  effort: EffortLevel,
  advanced?: CreateSessionAdvanced
): Promise<SessionStartResult> {
  const sessionId = `sess_${randomUUID().slice(0, 12)}`;
  const client = runtime.createClient();

  // Create session record
  const now = new Date().toISOString();
  const approvalTimeoutMs = advanced?.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;

  const developerInstructions = composeDeveloperInstructions(advanced?.developerInstructions);

  const resolvedImages = advanced?.images
    ? advanced.images.map((p) => resolveAndValidateFilePath(p, cwd, "image"))
    : undefined;
  const session = newSessionRecord({
    sessionId,
    now,
    cwd,
    spawnOpts,
    effort,
    developerInstructions,
    approvalTimeoutMs,
    advanced,
  });

  openNewSession(runtime, session, client);

  try {
    return await startFirstTurn(
      runtime,
      session,
      client,
      spawnOpts,
      prompt,
      resolvedImages,
      advanced
    );
  } catch (err) {
    await discardFailedSession(runtime, session, client, err);
    throw err;
  }
}

/** Start the app-server, open the thread and run the session's first turn on it. */
async function startFirstTurn(
  runtime: SessionRuntime,
  session: SessionInfo,
  client: ICodexClient,
  spawnOpts: AppServerSpawnOptions,
  prompt: string,
  resolvedImages: string[] | undefined,
  advanced: CreateSessionAdvanced | undefined
): Promise<SessionStartResult> {
  const threadId = await openThread(runtime, session, client, spawnOpts, advanced);

  markTurnOutputSchema(runtime, session.sessionId, advanced?.outputSchema);
  const turnStart = await startTurnWithCompatibilityFallback(client, {
    threadId,
    input: buildUserInput(prompt, resolvedImages),
    effort: session.effort,
    summary: advanced?.summary,
    outputSchema: advanced?.outputSchema,
    approvalsReviewer: session.approvalsReviewer,
  });

  // Best-effort: seed activeTurnId from response if present (notifications are authoritative)
  const startedTurnId = extractTurnId(turnStart.turnStartResult);
  if (startedTurnId) session.activeTurnId = startedTurnId;

  return {
    sessionId: session.sessionId,
    threadId,
    status: "running",
    pollInterval: DEFAULT_POLL_INTERVAL,
    compatWarnings: turnStart.compatWarnings,
    progress: buildProgressInfo(session),
  };
}

/** Bring the app-server up and open the thread this session's turns run on. */
async function openThread(
  runtime: SessionRuntime,
  session: SessionInfo,
  client: ICodexClient,
  spawnOpts: AppServerSpawnOptions,
  advanced: CreateSessionAdvanced | undefined
): Promise<string> {
  // Register event handlers before start to prevent unhandled "error" events
  registerHandlers(runtime, session, client, session.approvalTimeoutMs);

  // Start app-server subprocess
  await client.start(spawnOpts);

  // An id Codex does not know fails `thread/start` with a message about a
  // `[permissions]` TOML table the caller never wrote, so the id is held
  // against the machine's own listing first.
  if (session.permissions !== undefined) {
    await assertPermissionProfileSelectable(client, session.permissions, session.cwd);
  }

  const threadStartResult = await client.threadStart({
    cwd: session.cwd,
    model: spawnOpts.model,
    approvalPolicy: spawnOpts.approvalPolicy,
    sandbox: spawnOpts.sandbox,
    personality: advanced?.personality,
    ephemeral: advanced?.ephemeral,
    baseInstructions: advanced?.baseInstructions,
    developerInstructions: session.developerInstructions,
    config: advanced?.config,
    approvalsReviewer: session.approvalsReviewer,
    permissions: session.permissions,
  });
  const threadId = extractThreadId(threadStartResult);
  session.threadId = threadId;
  // Codex answers with the settings the thread runs with, and where they
  // differ from what the call asked for its answer is the truth: a start
  // naming no model is answered with the model `config.toml` picked.
  recordEffectiveSettings(session, threadStartResult);
  recordCodexDefaultModel(runtime, spawnOpts.model, session.effective?.model);
  // The first turn can run for minutes and a client can die inside it. The
  // thread id is what a resume needs, so it goes to disk on arrival rather
  // than with the next status change.
  persistSessionIfChanged(runtime, session);
  return threadId;
}

/** Give up a session whose first turn never started, on disk as well as in memory. */
async function discardFailedSession(
  runtime: SessionRuntime,
  session: SessionInfo,
  client: ICodexClient,
  err: unknown
): Promise<void> {
  const { sessionId } = session;
  session.status = "error";
  recordEvent(session, "error", {
    message: redactPaths(err instanceof Error ? err.message : String(err)),
  });
  await client.destroy();
  runtime.clients.delete(sessionId);
  // Drop the half-created session from memory and from disk: the caller gets
  // an error and no session id, and a leftover directory would come back as
  // a recovered session on the next server start.
  evictSession(runtime, sessionId, true);
}

// ── Session Reply ────────────────────────────────────────────────

export async function replyToSession(
  runtime: SessionRuntime,
  sessionId: string,
  prompt: string,
  overrides?: TurnOverrides
): Promise<SessionStartResult> {
  const session = getSessionOrThrow(runtime, sessionId);

  assertSessionAcceptsTurn(session, sessionId);
  if (!session.threadId) {
    throw new Error(
      `Error [${ErrorCode.INTERNAL}]: Session '${sessionId}' has no threadId, cannot reply`
    );
  }

  const client = getClientOrThrow(runtime, sessionId);

  const resolvedCwd = resolveTurnCwd(session, sessionId, overrides);
  // Held against the machine's listing before the session leaves `idle`, so a
  // profile id nobody offers costs the caller an error and not a turn.
  if (overrides?.permissions !== undefined) {
    await assertPermissionProfileSelectable(
      client,
      overrides.permissions,
      resolvedCwd ?? session.cwd
    );
  }

  openReplyTurn(runtime, session);

  const turnParams = buildTurnParams(session, session.threadId, prompt, overrides, resolvedCwd);

  let compatWarnings: string[] | undefined;
  markTurnOutputSchema(runtime, sessionId, overrides?.outputSchema);
  try {
    const turnStart = await startTurnWithCompatibilityFallback(client, turnParams);
    compatWarnings = turnStart.compatWarnings;
    const turnStartResult = turnStart.turnStartResult;
    const startedTurnId = extractTurnId(turnStartResult);
    if (startedTurnId) session.activeTurnId = startedTurnId;

    recordTurnOverrides(runtime, session, overrides, resolvedCwd);
  } catch (err) {
    session.status = "error";
    recordEvent(session, "error", {
      message: redactPaths(
        `Failed to start turn: ${err instanceof Error ? err.message : String(err)}`
      ),
    });
    throw err;
  }

  return {
    sessionId,
    threadId: session.threadId,
    status: "running",
    pollInterval: DEFAULT_POLL_INTERVAL,
    compatWarnings,
    progress: buildProgressInfo(session),
  };
}

/** Put the session on the turn it is about to start, and drop the finished turn's answer. */
function openReplyTurn(runtime: SessionRuntime, session: SessionInfo): void {
  // The finished turn's answer belongs to that turn: a check of the new one
  // reports the new result or none.
  session.lastResult = undefined;
  session.lastAgentMessageText = undefined;

  session.status = "running";
  session.lastActiveAt = new Date().toISOString();
  persistSessionIfChanged(runtime, session);
}

// ── Session Management ───────────────────────────────────────────

/**
 * Record what the turn actually ran with.
 *
 * Read after `turnStart` because that is the call the answer describes:
 * app-server applies every per-turn override, so what the turn was asked for
 * is what it runs with.
 */
function recordTurnOverrides(
  runtime: SessionRuntime,
  session: SessionInfo,
  overrides: TurnOverrides | undefined,
  resolvedCwd: string | undefined
): void {
  applyTurnOverrides(session, overrides, resolvedCwd);
  // The turn runs for minutes and the server can die inside it; what the session
  // now runs with reaches meta.json here rather than at the next status change.
  persistSessionIfChanged(runtime, session);
}
