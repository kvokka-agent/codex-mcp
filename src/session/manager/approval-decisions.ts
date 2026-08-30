/** Whether a decision answers the request it was sent for, and what goes on the wire. */
import type {
  CommandApprovalResponse,
  FileChangeApprovalResponse,
} from "../../app-server/wire/index.js";
import {
  COMMAND_DECISIONS,
  ErrorCode,
  FILE_CHANGE_DECISIONS,
  type NetworkPolicyAmendment,
  type PendingRequest,
} from "../../types/index.js";
import type { ApprovalExtra } from "./core.js";
import { isRecord } from "./read.js";

/** Throw unless `decision` and `extra` are an answer this pending request accepts. */
export function assertApprovalDecision(
  req: PendingRequest,
  requestId: string,
  decision: string,
  extra: ApprovalExtra | undefined
): void {
  if (req.kind === "command") {
    assertCommandDecision(req, decision);
    assertExecpolicyAmendment(decision, extra);
    assertNetworkPolicyAmendment(decision, extra);
    return;
  }
  if (req.kind === "fileChange") {
    if (!FILE_CHANGE_DECISIONS.includes(decision as (typeof FILE_CHANGE_DECISIONS)[number])) {
      throw new Error(
        `Error [${ErrorCode.INVALID_ARGUMENT}]: Invalid fileChange decision '${decision}'`
      );
    }
    return;
  }
  throw new Error(
    `Error [${ErrorCode.INVALID_ARGUMENT}]: Request '${requestId}' is not an approval request`
  );
}

/** Throw unless the command approval offers this decision and this build understands it. */
function assertCommandDecision(req: PendingRequest, decision: string): void {
  const available = parseAvailableDecisionSet(req.availableDecisions);
  if (available && !available.has(decision)) {
    throw new Error(
      `Error [${ErrorCode.INVALID_ARGUMENT}]: Decision '${decision}' is not available for this approval prompt`
    );
  }

  // Backward-compat: object-form decisions must be explicitly advertised by newer CLIs.
  if (!available && decision === "applyNetworkPolicyAmendment") {
    throw new Error(
      `Error [${ErrorCode.INVALID_ARGUMENT}]: Decision '${decision}' is not supported by this Codex CLI version (missing availableDecisions)`
    );
  }
  if (!COMMAND_DECISIONS.includes(decision as (typeof COMMAND_DECISIONS)[number])) {
    throw new Error(
      `Error [${ErrorCode.INVALID_ARGUMENT}]: Invalid command decision '${decision}'`
    );
  }
}

/** Throw unless the execpolicy amendment is there for the one decision that carries it. */
function assertExecpolicyAmendment(decision: string, extra: ApprovalExtra | undefined): void {
  if (
    decision === "acceptWithExecpolicyAmendment" &&
    (!extra?.execpolicy_amendment || extra.execpolicy_amendment.length === 0)
  ) {
    throw new Error(
      `Error [${ErrorCode.INVALID_ARGUMENT}]: execpolicy_amendment required for acceptWithExecpolicyAmendment`
    );
  }

  if (decision !== "acceptWithExecpolicyAmendment" && extra?.execpolicy_amendment !== undefined) {
    throw new Error(
      `Error [${ErrorCode.INVALID_ARGUMENT}]: execpolicy_amendment is only valid for acceptWithExecpolicyAmendment`
    );
  }
}

/** Throw unless the network policy amendment is there, whole, for the decision that carries it. */
function assertNetworkPolicyAmendment(decision: string, extra: ApprovalExtra | undefined): void {
  if (decision === "applyNetworkPolicyAmendment") {
    const amendment = extra?.network_policy_amendment;
    if (!amendment) {
      throw new Error(
        `Error [${ErrorCode.INVALID_ARGUMENT}]: network_policy_amendment required for applyNetworkPolicyAmendment`
      );
    }
    if (amendment.action !== "allow" && amendment.action !== "deny") {
      throw new Error(
        `Error [${ErrorCode.INVALID_ARGUMENT}]: network_policy_amendment.action must be 'allow' or 'deny'`
      );
    }
    if (!amendment.host) {
      throw new Error(
        `Error [${ErrorCode.INVALID_ARGUMENT}]: network_policy_amendment.host required for applyNetworkPolicyAmendment`
      );
    }
  } else if (extra?.network_policy_amendment !== undefined) {
    throw new Error(
      `Error [${ErrorCode.INVALID_ARGUMENT}]: network_policy_amendment is only valid for applyNetworkPolicyAmendment`
    );
  }
}

/** The protocol answer for a decision, or nothing when the request answers to neither shape. */
export function buildApprovalResponse(
  req: PendingRequest,
  decision: string,
  extra: ApprovalExtra | undefined
): unknown {
  if (req.kind === "command") {
    return buildCommandApprovalResponse(decision, {
      execpolicy_amendment: extra?.execpolicy_amendment,
      network_policy_amendment: extra?.network_policy_amendment,
    });
  }
  if (req.kind === "fileChange") {
    return { decision } as FileChangeApprovalResponse;
  }
  return undefined;
}

function buildCommandApprovalResponse(
  decision: string,
  extra?: {
    execpolicy_amendment?: string[];
    network_policy_amendment?: NetworkPolicyAmendment;
  }
): CommandApprovalResponse {
  if (decision === "acceptWithExecpolicyAmendment") {
    const execpolicy_amendment = extra?.execpolicy_amendment;
    if (!execpolicy_amendment || execpolicy_amendment.length === 0) {
      throw new Error(
        `Error [${ErrorCode.INVALID_ARGUMENT}]: execpolicy_amendment required for acceptWithExecpolicyAmendment`
      );
    }
    return {
      decision: {
        acceptWithExecpolicyAmendment: {
          execpolicy_amendment,
        },
      },
    };
  }

  if (decision === "applyNetworkPolicyAmendment") {
    const amendment = extra?.network_policy_amendment;
    if (!amendment) {
      throw new Error(
        `Error [${ErrorCode.INVALID_ARGUMENT}]: network_policy_amendment required for applyNetworkPolicyAmendment`
      );
    }
    return {
      decision: {
        applyNetworkPolicyAmendment: {
          network_policy_amendment: amendment,
        },
      },
    };
  }
  return { decision: decision as "accept" | "acceptForSession" | "decline" | "cancel" };
}

function parseAvailableDecisionSet(available: unknown[] | null | undefined): Set<string> | null {
  if (!Array.isArray(available) || available.length === 0) return null;
  const set = new Set<string>();
  for (const entry of available) addAvailableDecision(set, entry);
  return set.size > 0 ? set : null;
}

/** One entry of `availableDecisions`: a decision name, or the object form carrying one. */
function addAvailableDecision(set: Set<string>, entry: unknown): void {
  if (typeof entry === "string") {
    set.add(entry);
    return;
  }
  if (!isRecord(entry)) return;
  if ("acceptWithExecpolicyAmendment" in entry) set.add("acceptWithExecpolicyAmendment");
  if ("applyNetworkPolicyAmendment" in entry) set.add("applyNetworkPolicyAmendment");
}
