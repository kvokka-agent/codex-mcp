/** Holding a server-initiated approval or question open for the caller. */
import { randomUUID } from "node:crypto";
import type { ICodexClient } from "../../app-server/client-interface.js";
import {
  type CommandApprovalParams,
  type CommandApprovalResponse,
  type DynamicToolCallResponse,
  type FileChangeApprovalResponse,
  type LegacyApprovalResponse,
  Methods,
  type RequestId,
  type UserInputRequestResponse,
} from "../../app-server/protocol.js";
import type { PendingRequest, SessionInfo } from "../../types.js";
import {
  AUTH_REFRESH_UNSUPPORTED_CODE,
  AUTH_REFRESH_UNSUPPORTED_MESSAGE,
  commandApprovalFields,
  correlationIds,
  respondOrReport,
} from "./approval-io.js";
import type { PendingTimeout, SessionRuntime } from "./core.js";
import { recordEvent } from "./events.js";
import { createUnrefTimeout, settlePendingRequest } from "./pending-requests.js";
import { normalizeOptionalString } from "./read.js";

/**
 * The pending request an approval or a question from the app-server opens.
 *
 * `extra` carries what one kind adds over the shape all three share: the fields
 * of a command approval, the reason of a file change.
 */
function newPendingRequest(
  kind: PendingRequest["kind"],
  client: ICodexClient,
  id: RequestId,
  method: string,
  params: Record<string, unknown>,
  sessionId: string,
  extra?: Partial<PendingRequest>
): PendingRequest {
  return {
    requestId: `req_${randomUUID().slice(0, 8)}`,
    kind,
    params,
    ...correlationIds(params, method, sessionId),
    createdAt: new Date().toISOString(),
    resolved: false,
    respond: (result) => client.respondToServer(id, result),
    ...extra,
  };
}

/**
 * Put a pending request in the session and arm its timeout.
 *
 * A caller that never answers gets `timeout.response` sent on its behalf, and
 * the session drops back to `running` once nothing is pending. The send is
 * wrapped because the client may already be destroyed by the time the timer
 * fires.
 */
function awaitPendingRequest(
  runtime: SessionRuntime,
  session: SessionInfo,
  pending: PendingRequest,
  approvalTimeoutMs: number,
  request: Record<string, unknown>,
  timeout: PendingTimeout
): void {
  const { sessionId } = session;
  const { requestId } = pending;

  pending.timeoutHandle = createUnrefTimeout(() => {
    if (pending.resolved) return;
    pending.resolved = true;
    if (timeout.decision !== undefined) pending.decision = timeout.decision;
    try {
      timeout.respond(timeout.response);
    } catch (err) {
      console.error(
        `[codex-mcp] Failed to ${timeout.action} timeout: session=${sessionId} request=${requestId} error=${err instanceof Error ? err.message : String(err)}`
      );
    }
    recordEvent(session, "approval_result", { requestId, ...timeout.event, timeout: true });
    settlePendingRequest(runtime, session, requestId);
  }, approvalTimeoutMs);

  session.pendingRequests.set(requestId, pending);
  session.status = "waiting_approval";
  recordEvent(session, "approval_request", { requestId, ...request });
}

/** Route one server-initiated request to the handler that answers it. */
export function handleServerRequest(
  runtime: SessionRuntime,
  session: SessionInfo,
  client: ICodexClient,
  id: RequestId,
  method: string,
  params: unknown,
  approvalTimeoutMs: number
): void {
  const { sessionId } = session;
  switch (method) {
    case Methods.COMMAND_APPROVAL:
      awaitCommandApproval(runtime, session, client, id, method, params, approvalTimeoutMs);
      break;

    case Methods.FILE_CHANGE_APPROVAL:
      awaitFileChangeApproval(runtime, session, client, id, method, params, approvalTimeoutMs);
      break;

    case Methods.USER_INPUT_REQUEST:
      awaitUserInput(runtime, session, client, id, method, params, approvalTimeoutMs);
      break;

    case Methods.DYNAMIC_TOOL_CALL:
      // Auto-reject: codex-mcp doesn't support dynamic tool calls
      respondOrReport(sessionId, method, () =>
        client.respondToServer(id, {
          success: false,
          contentItems: [{ type: "inputText", text: "Not supported by codex-mcp" }],
        } as DynamicToolCallResponse)
      );
      break;

    case Methods.AUTH_TOKEN_REFRESH:
      respondOrReport(sessionId, method, () =>
        client.respondErrorToServer(
          id,
          AUTH_REFRESH_UNSUPPORTED_CODE,
          AUTH_REFRESH_UNSUPPORTED_MESSAGE
        )
      );
      break;

    case Methods.LEGACY_PATCH_APPROVAL:
    case Methods.LEGACY_EXEC_APPROVAL:
      respondOrReport(sessionId, method, () =>
        client.respondToServer(id, { decision: "denied" } as LegacyApprovalResponse)
      );
      console.error(`[codex-mcp] Legacy approval request received: ${method}`);
      break;

    default:
      respondOrReport(sessionId, method, () =>
        client.respondErrorToServer(id, -32601, `Unhandled server request: ${method}`)
      );
      break;
  }
}

/** Hold a command approval open for the caller, declining it if nobody answers. */
function awaitCommandApproval(
  runtime: SessionRuntime,
  session: SessionInfo,
  client: ICodexClient,
  id: RequestId,
  method: string,
  params: unknown,
  approvalTimeoutMs: number
): void {
  const approvalParams = params as CommandApprovalParams & Record<string, unknown>;
  const fields = commandApprovalFields(approvalParams);
  const pending = newPendingRequest(
    "command",
    client,
    id,
    method,
    approvalParams,
    session.sessionId,
    fields
  );

  awaitPendingRequest(
    runtime,
    session,
    pending,
    approvalTimeoutMs,
    {
      kind: "command",
      itemId: approvalParams.itemId,
      approvalId: fields.approvalId,
      command: approvalParams.command,
      cwd: approvalParams.cwd,
      reason: fields.reason,
      commandActions: fields.commandActions,
      proposedExecpolicyAmendment: fields.proposedExecpolicyAmendment,
      availableDecisions: fields.availableDecisions,
      proposedNetworkPolicyAmendments: fields.proposedNetworkPolicyAmendments,
      additionalPermissions: fields.additionalPermissions,
      networkApprovalContext: fields.networkApprovalContext,
    },
    {
      action: "auto-decline command approval",
      respond: (result) => client.respondToServer(id, result),
      response: { decision: "decline" } as CommandApprovalResponse,
      decision: "decline",
      event: { kind: "command", approvalId: fields.approvalId, decision: "decline" },
    }
  );
}

/** Hold a file-change approval open for the caller, declining it if nobody answers. */
function awaitFileChangeApproval(
  runtime: SessionRuntime,
  session: SessionInfo,
  client: ICodexClient,
  id: RequestId,
  method: string,
  params: unknown,
  approvalTimeoutMs: number
): void {
  const p = params as Record<string, unknown>;
  const reason = normalizeOptionalString(p.reason);
  const pending = newPendingRequest("fileChange", client, id, method, p, session.sessionId, {
    reason,
  });

  awaitPendingRequest(
    runtime,
    session,
    pending,
    approvalTimeoutMs,
    { kind: "fileChange", itemId: p.itemId, reason },
    {
      action: "auto-decline file-change approval",
      respond: (result) => client.respondToServer(id, result),
      response: { decision: "decline" } as FileChangeApprovalResponse,
      decision: "decline",
      event: { kind: "fileChange", decision: "decline" },
    }
  );
}

/** Hold a user-input question open for the caller, answering it empty if nobody does. */
function awaitUserInput(
  runtime: SessionRuntime,
  session: SessionInfo,
  client: ICodexClient,
  id: RequestId,
  method: string,
  params: unknown,
  approvalTimeoutMs: number
): void {
  const p = params as Record<string, unknown>;
  const pending = newPendingRequest("user_input", client, id, method, p, session.sessionId);

  awaitPendingRequest(
    runtime,
    session,
    pending,
    approvalTimeoutMs,
    { kind: "user_input", questions: p.questions },
    {
      action: "auto-answer user-input",
      respond: (result) => client.respondToServer(id, result),
      response: { answers: {} } as UserInputRequestResponse,
      event: { kind: "user_input" },
    }
  );
}
