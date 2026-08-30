/** Picking an existing Codex thread back up: resume, fork, and the shutdown record. */
import { randomUUID } from "node:crypto";
import type { ICodexClient } from "../../app-server/client-interface.js";
import { describeOwner, ownerState, readOwner } from "../../persistence/index.js";
import {
  DEFAULT_POLL_INTERVAL,
  type EffectiveSettings,
  ErrorCode,
  type SessionInfo,
  type SessionStartResult,
} from "../../types/index.js";
import { redactPaths } from "../../utils/redact.js";
import type { SessionRuntime } from "./core.js";
import { registerHandlers } from "./handlers.js";
import { buildProgressInfo } from "./progress.js";
import { describeError } from "./read.js";
import { extractThreadId, readEffectiveSettings } from "./session-decode.js";
import {
  attachEventSink,
  evictSession,
  ingestRecovered,
  persistSessionIfChanged,
  recordEffectiveSettings,
  scanDisk,
  threadTarget,
} from "./store.js";
import { notifyWaiters, registerSession } from "./waiters.js";

/**
 * Pick a session nobody holds back up and drive it from here.
 *
 * `thread/resume` reads the thread out of Codex's own rollout log, so the
 * model comes back knowing where it was cut off — including a turn that never
 * finished, which arrives with `status: "interrupted"`. The session is then a
 * normal idle session: `codex_reply` carries it on.
 */
export async function resumeSession(
  runtime: SessionRuntime,
  sessionId: string
): Promise<SessionStartResult> {
  const session = adoptForResume(runtime, sessionId);
  if (!session.threadId) {
    throw new Error(
      `Error [${ErrorCode.INTERNAL}]: Session '${sessionId}' records no threadId, so there is no thread to resume`
    );
  }
  const threadId = session.threadId;
  const previousStatus = session.status;

  const client = runtime.createClient();
  runtime.clients.set(sessionId, client);
  attachEventSink(runtime, session);

  try {
    registerHandlers(runtime, session, client, session.approvalTimeoutMs);
    await client.start({
      profile: session.profile,
      model: session.model,
      approvalPolicy: session.approvalPolicy,
      sandbox: session.sandbox,
      config: session.config,
    });
    const resumeResult = await client.threadResume({
      threadId,
      personality: session.personality,
      baseInstructions: session.baseInstructions,
      developerInstructions: session.developerInstructions,
      approvalsReviewer: session.approvalsReviewer,
      permissions: session.permissions,
    });
    // A resume restores the thread from Codex's own rollout log, so the
    // thread's persisted metadata decides what it runs with — not the
    // `meta.json` of whichever server started it.
    recordEffectiveSettings(session, resumeResult);
    session.threadId = threadId;
    session.status = "idle";
    session.lastActiveAt = new Date().toISOString();
    runtime.persistence?.claim(sessionId);
    persistSessionIfChanged(runtime, session);
    notifyWaiters(runtime, sessionId);

    return {
      sessionId,
      threadId,
      status: "idle" as const,
      pollInterval: DEFAULT_POLL_INTERVAL,
      progress: buildProgressInfo(session),
    };
  } catch (err) {
    session.status = previousStatus;
    runtime.clients.delete(sessionId);
    try {
      await client.destroy();
    } catch (destroyErr) {
      console.error(
        `[codex-mcp] Failed to destroy the client of a resume that did not take: session=${sessionId} error=${describeError(destroyErr)}`
      );
    }
    throw new Error(
      `Error [${ErrorCode.THREAD_FORK_RESUME_FAILED}]: Failed to resume thread '${threadId}' of session '${sessionId}': ${redactPaths(describeError(err))}`
    );
  }
}

/**
 * The session `resume` is about to drive, taken into memory when it is only on disk.
 *
 * The owner is read from the directory at this moment rather than from what
 * startup found: a server that started since then may hold the session now,
 * and resuming it would put two servers on one thread.
 */
function adoptForResume(runtime: SessionRuntime, sessionId: string): SessionInfo {
  if (runtime.clients.has(sessionId)) {
    throw new Error(
      `Error [${ErrorCode.SESSION_BUSY}]: Session '${sessionId}' is already open on this server`
    );
  }
  if (runtime.persistence) {
    const state = ownerState(readOwner(runtime.persistence.sessionDir(sessionId)));
    if (state.kind === "held") {
      throw new Error(
        `Error [${ErrorCode.SESSION_HELD_BY_OTHER_SERVER}]: Session '${sessionId}' is ${describeOwner(state)}`
      );
    }
  }

  const known = runtime.sessions.get(sessionId);
  if (known) return known;

  const found = scanDisk(runtime).find((rec) => rec.sessionId === sessionId);
  if (!found) {
    throw new Error(`Error [${ErrorCode.SESSION_NOT_FOUND}]: Session '${sessionId}' not found`);
  }
  ingestRecovered(runtime, [found]);
  const adopted = runtime.sessions.get(sessionId);
  if (!adopted) {
    throw new Error(
      `Error [${ErrorCode.SESSION_NOT_FOUND}]: Session '${sessionId}' is on disk and could not be taken into memory`
    );
  }
  return adopted;
}

/**
 * Write down where the sessions of this server stand and give up its claims.
 *
 * It runs before anything a shutdown waits on: a turn that was running when
 * the client went away is `abandoned`, which is what it is, and the claims are
 * gone whether or not the rest of the shutdown gets to finish.
 */
export function finalizeForShutdown(runtime: SessionRuntime): void {
  for (const session of runtime.sessions.values()) {
    if (session.status === "running" || session.status === "waiting_approval") {
      session.status = "abandoned";
      session.lastActiveAt = new Date().toISOString();
    }
    persistSessionIfChanged(runtime, session);
  }
  runtime.persistence?.flushAll();
  runtime.persistence?.releaseAll();
}

/** The in-memory session a fork opens, copied off the session it was forked from. */
function forkedSessionRecord(source: SessionInfo, effective: EffectiveSettings | undefined) {
  const now = new Date().toISOString();
  const record: SessionInfo = {
    sessionId: `sess_${randomUUID().slice(0, 12)}`,
    status: "idle",
    createdAt: now,
    lastActiveAt: now,
    approvalTimeoutMs: source.approvalTimeoutMs,
    cwd: source.cwd,
    model: source.model,
    profile: source.profile,
    approvalPolicy: source.approvalPolicy,
    sandbox: source.sandbox,
    approvalsReviewer: source.approvalsReviewer,
    permissions: source.permissions,
    personality: source.personality,
    effort: source.effort,
    summary: source.summary,
    config: source.config,
    pendingRequests: new Map(),
    baseInstructions: source.baseInstructions,
    developerInstructions: source.developerInstructions,
    effective,
  };
  return record;
}

export async function forkSession(
  runtime: SessionRuntime,
  sessionId: string
): Promise<SessionStartResult> {
  const {
    session,
    client: originalClient,
    threadId,
  } = threadTarget(runtime, sessionId, {
    cancelled: `Session '${sessionId}' has been cancelled and cannot be forked`,
    noThread: "No threadId to fork",
  });

  // Fork the thread on the ORIGINAL client (which holds the thread state)
  const forkResult = await originalClient.threadFork({
    threadId,
    baseInstructions: session.baseInstructions,
    developerInstructions: session.developerInstructions,
    approvalsReviewer: session.approvalsReviewer,
    permissions: session.permissions,
  });
  const forkedThreadId = extractThreadId(forkResult);

  // Create new session with its own app-server process
  const newClient = runtime.createClient();
  const newSession = forkedSessionRecord(session, readEffectiveSettings(forkResult));

  registerSession(runtime, newSession);
  runtime.clients.set(newSession.sessionId, newClient);
  attachEventSink(runtime, newSession);
  persistSessionIfChanged(runtime, newSession);
  runtime.persistence?.claim(newSession.sessionId);

  try {
    return await openForkedSession(runtime, session, newSession, newClient, forkedThreadId);
  } catch (err) {
    await discardFailedFork(runtime, newSession, newClient, originalClient, forkedThreadId);
    throw new Error(
      `Error [${ErrorCode.THREAD_FORK_RESUME_FAILED}]: Failed to resume forked thread '${forkedThreadId}' in new app-server process: ${redactPaths(err instanceof Error ? err.message : String(err))}`
    );
  }
}

/** Bring up the process the forked session runs on and resume the forked thread there. */
async function openForkedSession(
  runtime: SessionRuntime,
  source: SessionInfo,
  newSession: SessionInfo,
  newClient: ICodexClient,
  forkedThreadId: string
): Promise<SessionStartResult> {
  // Register handlers before start to prevent unhandled "error" events
  registerHandlers(runtime, newSession, newClient, newSession.approvalTimeoutMs);

  // Start new app-server subprocess
  await newClient.start({
    profile: source.profile,
    model: source.model,
    approvalPolicy: source.approvalPolicy,
    sandbox: source.sandbox,
    config: source.config,
  });

  // Resume the forked thread on the new process
  const resumeResult = await newClient.threadResume({
    threadId: forkedThreadId,
    personality: source.personality,
    baseInstructions: source.baseInstructions,
    developerInstructions: source.developerInstructions,
    approvalsReviewer: source.approvalsReviewer,
    permissions: source.permissions,
  });
  // The fork answered for the thread and this resume answers for the
  // process the new session is driven by, which is the one it runs on.
  recordEffectiveSettings(newSession, resumeResult);
  newSession.threadId = forkedThreadId;
  persistSessionIfChanged(runtime, newSession);

  return {
    sessionId: newSession.sessionId,
    threadId: forkedThreadId,
    status: "idle" as const,
    pollInterval: DEFAULT_POLL_INTERVAL,
  };
}

/** Give up a fork whose new process never took the thread, in memory and on disk. */
async function discardFailedFork(
  runtime: SessionRuntime,
  newSession: SessionInfo,
  newClient: ICodexClient,
  originalClient: ICodexClient,
  forkedThreadId: string
): Promise<void> {
  // The fork is this server's own leftover: `thread/fork` answered, nothing
  // else ever saw the thread, and the caller gets an error instead of it.
  // `thread/delete` runs on the original client, which is the process that
  // created it — the new one is the half that failed.
  try {
    await originalClient.threadDelete({ threadId: forkedThreadId });
  } catch (deleteErr) {
    console.error(
      `[codex-mcp] forkSession failed after thread/fork created thread=${forkedThreadId}, and thread/delete did not remove it: ${deleteErr instanceof Error ? deleteErr.message : String(deleteErr)}. It stays in the rollout log until it is deleted there.`
    );
  }
  newSession.status = "error";
  try {
    await newClient.destroy();
  } catch (destroyErr) {
    console.error(
      `[codex-mcp] Failed to destroy forked app-server client after resume failure: session=${newSession.sessionId} error=${destroyErr instanceof Error ? destroyErr.message : String(destroyErr)}`
    );
  }
  runtime.clients.delete(newSession.sessionId);
  evictSession(runtime, newSession.sessionId, true);
}
