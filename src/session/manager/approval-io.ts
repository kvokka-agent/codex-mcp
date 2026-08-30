/** Answering the app-server: what goes back, what is logged, what is reported. */
import type { ICodexClient } from "../../app-server/client-interface.js";
import {
  type CommandApprovalParams,
  type DynamicToolCallResponse,
  type LegacyApprovalResponse,
  Methods,
  type RequestId,
  type UserInputRequestResponse,
} from "../../app-server/protocol.js";
import { ErrorCode, type PendingRequest } from "../../types.js";
import { describeError, isRecord, normalizeOptionalString } from "./read.js";

export const AUTH_REFRESH_UNSUPPORTED_CODE = -32000;

export const AUTH_REFRESH_UNSUPPORTED_MESSAGE =
  "account/chatgptAuthTokens/refresh unsupported: codex-mcp does not manage external ChatGPT auth tokens";

const AUTH_REFRESH_TERMINAL_MESSAGE =
  "account/chatgptAuthTokens/refresh unsupported: session is terminal";

/**
 * Answer a server-initiated request, reporting a delivery that failed.
 *
 * The client throws when it cannot write the response. Letting that escape the request
 * handler would skip the long-poll wake-up at the end of it, so a caller waiting on this
 * session would sit until its own deadline instead of hearing about the turn.
 */
export function respondOrReport(sessionId: string, method: string, send: () => void): void {
  try {
    send();
  } catch (err) {
    console.error(
      `[codex-mcp] Failed to answer a server request: session=${sessionId} method=${method} ` +
        `error=${describeError(err)}`
    );
  }
}

export function respondToTerminalSessionRequest(
  client: ICodexClient,
  id: RequestId,
  method: string,
  sessionId: string
): void {
  respondOrReport(sessionId, method, () => {
    switch (method) {
      case Methods.COMMAND_APPROVAL:
      case Methods.FILE_CHANGE_APPROVAL:
        client.respondToServer(id, { decision: "cancel" });
        break;
      case Methods.USER_INPUT_REQUEST:
        client.respondToServer(id, { answers: {} } as UserInputRequestResponse);
        break;
      case Methods.DYNAMIC_TOOL_CALL:
        client.respondToServer(id, {
          success: false,
          contentItems: [{ type: "inputText", text: "Session is terminal" }],
        } as DynamicToolCallResponse);
        break;
      case Methods.AUTH_TOKEN_REFRESH:
        client.respondErrorToServer(
          id,
          AUTH_REFRESH_UNSUPPORTED_CODE,
          AUTH_REFRESH_TERMINAL_MESSAGE
        );
        break;
      case Methods.LEGACY_PATCH_APPROVAL:
      case Methods.LEGACY_EXEC_APPROVAL:
        client.respondToServer(id, { decision: "denied" } as LegacyApprovalResponse);
        break;
      default:
        client.respondErrorToServer(id, -32601, `Unhandled server request: ${method}`);
        break;
    }
  });
}

/** The ids of the questions whose answer the log must not carry. */
function secretQuestionIds(params: unknown): Set<string> {
  const questions = isRecord(params) && Array.isArray(params.questions) ? params.questions : [];
  const ids = new Set<string>();
  for (const question of questions) {
    if (isRecord(question) && question.isSecret === true && typeof question.id === "string") {
      ids.add(question.id);
    }
  }
  return ids;
}

/**
 * The answers to keep in events.jsonl.
 *
 * A question marked `isSecret` is answered with something that must not be
 * written down — a token, a password (codex-schema/ToolRequestUserInputParams.json
 * → ToolRequestUserInputQuestion.isSecret). Codex still receives the answer as
 * given; the log keeps only the fact that the question was answered.
 */
export function loggableAnswers(
  params: unknown,
  answers: Record<string, { answers: string[] }>
): Record<string, { answers: string[] }> {
  const secretIds = secretQuestionIds(params);
  if (secretIds.size === 0) return answers;

  const loggable: Record<string, { answers: string[] }> = {};
  for (const [id, value] of Object.entries(answers)) {
    loggable[id] = secretIds.has(id)
      ? { answers: (value?.answers ?? []).map(() => "<secret>") }
      : value;
  }
  return loggable;
}

/**
 * The correlation ids a server-initiated request carries.
 *
 * The protocol declares `itemId`, `threadId` and `turnId` on every approval and
 * user-input request, so a missing one is a server that broke its own contract and says
 * so on stderr. It is passed on as `""` because nothing routes by it: the decision goes
 * back on the JSON-RPC id the request arrived with, and the caller names the request by
 * its `requestId`.
 */
export function correlationIds(
  params: Record<string, unknown>,
  method: string,
  sessionId: string
): { itemId: string; threadId: string; turnId: string } {
  const itemId = normalizeOptionalString(params.itemId);
  const threadId = normalizeOptionalString(params.threadId);
  const turnId = normalizeOptionalString(params.turnId);
  const missing: string[] = [];
  if (itemId === undefined) missing.push("itemId");
  if (threadId === undefined) missing.push("threadId");
  if (turnId === undefined) missing.push("turnId");
  if (missing.length > 0) {
    console.error(
      `[codex-mcp] ${method} carries no ${missing.join(", ")}: session=${sessionId} — ` +
        `reported as an empty string`
    );
  }
  return { itemId: itemId ?? "", threadId: threadId ?? "", turnId: turnId ?? "" };
}

/** The fields a `commandApproval` request carries, as the pending request records them. */
export function commandApprovalFields(
  approvalParams: CommandApprovalParams & Record<string, unknown>
): {
  reason: string | undefined;
  approvalId: string | undefined;
  commandActions: unknown[] | null;
  proposedExecpolicyAmendment: string[] | null;
  availableDecisions: unknown[] | null;
  proposedNetworkPolicyAmendments: unknown[] | null;
  additionalPermissions: unknown;
  networkApprovalContext: unknown;
} {
  return {
    reason: normalizeOptionalString(approvalParams.reason),
    approvalId: normalizeOptionalString(approvalParams.approvalId),
    commandActions: Array.isArray(approvalParams.commandActions)
      ? approvalParams.commandActions
      : null,
    proposedExecpolicyAmendment: normalizeStringArrayOrNull(
      approvalParams.proposedExecpolicyAmendment
    ),
    availableDecisions: Array.isArray(approvalParams.availableDecisions)
      ? (approvalParams.availableDecisions as unknown[])
      : null,
    proposedNetworkPolicyAmendments: Array.isArray(approvalParams.proposedNetworkPolicyAmendments)
      ? (approvalParams.proposedNetworkPolicyAmendments as unknown[])
      : null,
    additionalPermissions:
      "additionalPermissions" in approvalParams
        ? (approvalParams.additionalPermissions as unknown)
        : undefined,
    networkApprovalContext:
      "networkApprovalContext" in approvalParams
        ? (approvalParams.networkApprovalContext as unknown)
        : undefined,
  };
}

function normalizeStringArrayOrNull(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const normalized = value.filter((entry): entry is string => typeof entry === "string");
  return normalized;
}

export function sendPendingRequestResponseOrThrow(
  req: PendingRequest,
  response: unknown,
  sessionId: string,
  requestId: string
): void {
  if (!req.respond) {
    throw new Error(
      `Error [${ErrorCode.INTERNAL}]: Missing response handler for request '${requestId}'`
    );
  }
  try {
    req.respond(response);
  } catch (err) {
    throw new Error(
      `Error [${ErrorCode.INTERNAL}]: Failed to send response: session=${sessionId} request=${requestId} kind=${req.kind} error=${err instanceof Error ? err.message : String(err)}`
    );
  }
}
