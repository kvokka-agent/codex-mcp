/** What a turn is started with, and whether the session can start one. */
import { isAbsolute } from "node:path";
import type { ICodexClient } from "../../app-server/client-interface.js";
import {
  type TurnStartParams,
  toSandboxPolicy,
  type UserInput,
} from "../../app-server/protocol.js";
import {
  type ApprovalPolicy,
  type EffortLevel,
  ErrorCode,
  type SandboxMode,
  type SessionInfo,
} from "../../types.js";
import { resolveAndValidateCwd } from "../../utils/cwd.js";
import {
  buildEffortFallbackWarning,
  classifyTurnCompatibilityError,
  toFriendlyTurnCompatibilityError,
} from "../../utils/turn-compat.js";
import type { TurnOverrides } from "./core.js";
import { messageOf, normalizeOptionalString } from "./read.js";

const EFFORT_FALLBACK_LEVEL: EffortLevel = "low";

export async function startTurnWithCompatibilityFallback(
  client: ICodexClient,
  turnParams: TurnStartParams
): Promise<{ turnStartResult: unknown; compatWarnings?: string[] }> {
  try {
    return { turnStartResult: await client.turnStart(turnParams) };
  } catch (err) {
    if (
      turnParams.effort === "minimal" &&
      classifyTurnCompatibilityError(err) === "minimal_web_search"
    ) {
      try {
        return {
          turnStartResult: await client.turnStart({
            ...turnParams,
            effort: EFFORT_FALLBACK_LEVEL,
          }),
          compatWarnings: [buildEffortFallbackWarning("minimal", EFFORT_FALLBACK_LEVEL)],
        };
      } catch (retryErr) {
        throw toFriendlyTurnCompatibilityError(retryErr);
      }
    }
    throw toFriendlyTurnCompatibilityError(err);
  }
}

// ── Session Creation ─────────────────────────────────────────────

/** Throw unless the session is in a state a new turn can start from. */
export function assertSessionAcceptsTurn(session: SessionInfo, sessionId: string): void {
  // Status first: cancelSession drops the client, so a client lookup ahead of this
  // reports a cancelled session as SESSION_NOT_FOUND.
  if (session.status === "cancelled") {
    throw new Error(
      `Error [${ErrorCode.CANCELLED}]: Session '${sessionId}' has been cancelled and cannot be resumed`
    );
  }
  if (session.status === "abandoned") {
    throw new Error(
      `Error [${ErrorCode.SESSION_NOT_RUNNING}]: Session '${sessionId}' was abandoned by the server that held it — ` +
        `call codex_session(action="resume") to pick its thread back up`
    );
  }
  if (session.status !== "idle" && session.status !== "error") {
    throw new Error(
      `Error [${ErrorCode.SESSION_BUSY}]: Session '${sessionId}' is ${session.status}, expected idle or error`
    );
  }
}

/**
 * Put on the session what the turn runs with, so the next turn — and a turn
 * after a resume — starts from it.
 */
export function applyTurnOverrides(
  session: SessionInfo,
  overrides: TurnOverrides | undefined,
  resolvedCwd: string | undefined
): void {
  if (resolvedCwd) session.cwd = resolvedCwd;
  if (!overrides) return;
  if (overrides.model) session.model = overrides.model;
  if (overrides.approvalPolicy) {
    session.approvalPolicy = overrides.approvalPolicy as ApprovalPolicy;
  }
  if (overrides.approvalsReviewer) session.approvalsReviewer = overrides.approvalsReviewer;
  applyTurnReachOverrides(session, overrides);
}

/** What the turn is allowed to reach, and how hard it thinks while it does. */
function applyTurnReachOverrides(session: SessionInfo, overrides: TurnOverrides): void {
  // A session records one of the two, never both: `thread/resume` sends the
  // profile and the spawn sends `-c sandbox_mode=`, and a session carrying both
  // would put a profile and a sandbox on one restored thread.
  if (overrides.permissions) {
    session.permissions = overrides.permissions;
    session.sandbox = undefined;
  }
  if (overrides.effort) session.effort = overrides.effort;
  if (overrides.summary) session.summary = overrides.summary;
  if (overrides.personality) session.personality = overrides.personality;
  if (overrides.sandbox) {
    session.sandbox = overrides.sandbox as SandboxMode;
    session.permissions = undefined;
  }
}

/** The cwd a reply's override asks the turn to run in, or nothing when it names none. */
export function resolveTurnCwd(
  session: SessionInfo,
  sessionId: string,
  overrides: TurnOverrides | undefined
): string | undefined {
  // A recovered session whose meta.json recorded no cwd has no base to resolve a
  // relative override against, and the server's own cwd is not that base.
  if (overrides?.cwd !== undefined && session.cwd === undefined && !isAbsolute(overrides.cwd)) {
    throw new Error(
      `Error [${ErrorCode.INVALID_ARGUMENT}]: Session '${sessionId}' records no cwd, so a relative cwd override cannot be resolved — pass an absolute path`
    );
  }
  return overrides?.cwd
    ? resolveAndValidateCwd(overrides.cwd, session.cwd ?? overrides.cwd)
    : undefined;
}

/**
 * The `input` of a turn: the prompt, then one entry per image the caller named.
 *
 * `turn/start` and `turn/steer` both take `UserInput[]`, so a steer that carries
 * an image is built here too.
 */
export function buildUserInput(prompt: string, images?: string[]): UserInput[] {
  const input: UserInput[] = [{ type: "text", text: prompt }];
  for (const path of images ?? []) input.push({ type: "localImage", path });
  return input;
}

/**
 * The backend's refusal of a steer, as the error the caller acts on.
 *
 * Measured on codex-cli 0.150.1: a steer whose `expectedTurnId` is not the
 * running turn answers ``-32600 expected active turn id `X` but found `Y` ``,
 * and one that arrives with no turn running answers `-32600 no active turn to
 * steer`. The steered text lands at the turn's next model round trip rather than
 * on arrival, so a steer sent late in a turn reaches a turn that has ended.
 *
 * Both say the same thing about the session — the turn the steer named is not
 * running — which is `SESSION_NOT_RUNNING`; the backend's own sentence is
 * carried through, so the caller can still tell the turn that moved on from the
 * turn that ended. Any other failure is left as it was raised: a timed-out
 * request or a dead child is not a turn that finished.
 */
export function steerRefusal(sessionId: string, turnId: string, err: unknown): Error | undefined {
  const message = messageOf(err);
  if (!/no active turn to steer|expected active turn id/.test(message)) return undefined;
  return new Error(
    `Error [${ErrorCode.SESSION_NOT_RUNNING}]: Session '${sessionId}' is no longer running turn '${turnId}', so the steer reached no turn: ${message}`
  );
}

/** The `turn/start` parameters of a reply: the overrides it names, over what the session runs with. */
export function buildTurnParams(
  session: SessionInfo,
  threadId: string,
  prompt: string,
  overrides: TurnOverrides | undefined,
  resolvedCwd: string | undefined
): TurnStartParams {
  const named = overrides ?? {};
  const turnParams: TurnStartParams = {
    threadId,
    input: buildUserInput(prompt),
    model: named.model,
    approvalPolicy: named.approvalPolicy,
    // `turn/start` carries these on every turn; the thread holds none of them, so a
    // turn that omits one takes the value from ~/.codex/config.toml rather than the
    // one the session was started with.
    effort: named.effort ?? session.effort,
    summary: named.summary ?? session.summary,
    personality: named.personality ?? session.personality,
    approvalsReviewer: named.approvalsReviewer ?? session.approvalsReviewer,
    // Only what this turn named. The thread already carries the session's own
    // profile, and re-sending it beside a `sandboxPolicy` the same reply asked
    // for is the pair `turn/start` refuses.
    permissions: named.permissions,
    cwd: resolvedCwd,
    outputSchema: named.outputSchema,
  };
  // Map sandbox string to protocol object
  if (named.sandbox) {
    turnParams.sandboxPolicy = toSandboxPolicy(named.sandbox);
  }
  return turnParams;
}

/** The id of a finished turn, reporting a `turn/completed` that named none. */
export function turnIdOfCompleted(
  session: SessionInfo,
  turnObj: Record<string, unknown> | undefined
): string {
  const knownTurnId = normalizeOptionalString(turnObj?.id) ?? session.activeTurnId;
  if (knownTurnId === undefined) {
    // `turn/completed` carries `turn.id`; an empty one here says the notification
    // did not, and it is never used to route anything — a response goes back by
    // its JSON-RPC id and a poll by `requestId`.
    console.error(
      `[codex-mcp] turn/completed carries no turn id: session=${session.sessionId} — reporting lastResult.turnId as ""`
    );
  }
  return knownTurnId ?? "";
}
