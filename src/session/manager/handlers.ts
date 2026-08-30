/** What this server does with everything the app-server sends it. */
import type { ICodexClient } from "../../app-server/client-interface.js";
import type { RequestId } from "../../app-server/protocol.js";
import { DEFAULT_APPROVAL_TIMEOUT_MS, type SessionInfo } from "../../types.js";
import { redactPaths } from "../../utils/redact.js";
import { respondToTerminalSessionRequest } from "./approval-io.js";
import type { SessionRuntime } from "./core.js";
import { recordEvent } from "./events.js";
import { handleNotification } from "./notifications.js";
import { clearSessionPendingRequests, setTerminalErrorResult } from "./pending-requests.js";
import { recordProgressObservation } from "./progress.js";
import { handleServerRequest } from "./server-requests.js";
import { persistResult, persistSessionIfChanged, persistSpawnedPid } from "./store.js";
import { notifyWaiters } from "./waiters.js";

export function registerHandlers(
  runtime: SessionRuntime,
  session: SessionInfo,
  client: ICodexClient,
  approvalTimeoutMs = DEFAULT_APPROVAL_TIMEOUT_MS
): void {
  const { sessionId } = session;

  // Persist PID info for orphan detection on the next startup. The client
  // reports the process it spawns in `start()`, so the file follows the live
  // child.
  client.on("spawn", (pid: number, spawnedAt: string) => {
    persistSpawnedPid(runtime, session, pid, spawnedAt);
  });

  // Handle notifications
  client.onNotification((method, params) => {
    session.lastActiveAt = new Date().toISOString();
    const p = params as Record<string, unknown>;
    recordProgressObservation(session, method, p);

    handleNotification(runtime, session, method, p);

    // Wake any long-poll waiters after every notification
    notifyWaiters(runtime, sessionId);
  });

  // Handle server-initiated requests
  client.onServerRequest((id: RequestId, method: string, params: unknown) => {
    // Do not transition terminal sessions back to waiting_approval.
    if (session.status === "cancelled" || session.status === "error") {
      respondToTerminalSessionRequest(client, id, method, sessionId);
      return;
    }

    session.lastActiveAt = new Date().toISOString();
    const p = params as Record<string, unknown>;
    recordProgressObservation(session, method, p);

    handleServerRequest(runtime, session, client, id, method, params, approvalTimeoutMs);

    // Wake any long-poll waiters after every server-initiated request (new pending approval)
    notifyWaiters(runtime, sessionId);
  });

  // Handle subprocess exit
  client.on("exit", (code: number | null) => {
    failOnSubprocessLoss(runtime, session, `app-server exited unexpectedly (code: ${code})`);
  });

  // Handle subprocess spawn errors (must listen to prevent uncaught exception)
  client.on("error", (err: Error) => {
    failOnSubprocessLoss(runtime, session, redactPaths(`app-server error: ${err.message}`));
  });
}

/** The app-server went away under a live turn: the turn failed, and the session says so. */
function failOnSubprocessLoss(
  runtime: SessionRuntime,
  session: SessionInfo,
  message: string
): void {
  clearSessionPendingRequests(session);
  if (session.status === "running" || session.status === "waiting_approval") {
    session.status = "error";
    setTerminalErrorResult(session, message);
    recordEvent(session, "error", {
      message,
    });
    persistSessionIfChanged(runtime, session);
    persistResult(runtime, session);
    notifyWaiters(runtime, session.sessionId);
  }
}
