/** A session record read out of what Codex or the state directory answered. */
import type { AppServerSpawnOptions } from "../../app-server/lifecycle.js";
import {
  ANSWERED_APPROVALS_REVIEWERS,
  APPROVAL_POLICY_PRESETS,
  type AskForApproval,
  type AskForApprovalGranular,
  SANDBOX_POLICY_TYPES,
  type SandboxPolicy,
} from "../../app-server/wire/index.js";
import type { RecoveredSession } from "../../persistence/index.js";
import {
  APPROVAL_POLICIES,
  APPROVALS_REVIEWERS,
  type EffectivePermissionProfile,
  type EffectiveSettings,
  type EffortLevel,
  ErrorCode,
  type Personality,
  type PublicEffectiveSettings,
  SANDBOX_MODES,
  SESSION_STATUSES,
  type SessionInfo,
  type SessionStatus,
  type SummaryMode,
  type TurnResult,
} from "../../types.js";
import type { CreateSessionAdvanced } from "./core.js";
import { extractTokens } from "./progress.js";
import { isRecord, normalizeOptionalString, readNonEmptyString, readOneOf } from "./read.js";

/**
 * Everything meta.json carries, as one string to compare two writes by.
 *
 * `lastActiveAt` is deliberately absent: every notification of a turn moves it,
 * and writing meta.json for each would put a file write on the hot path without
 * changing anything a reader acts on.
 */
export function metaFingerprint(session: SessionInfo): string {
  return JSON.stringify([
    session.status,
    session.threadId,
    session.model,
    session.cwd,
    session.profile,
    session.approvalPolicy,
    session.sandbox,
    session.personality,
    session.effort,
    session.summary,
    session.baseInstructions,
    session.developerInstructions,
    session.approvalTimeoutMs,
    session.cancelledAt,
    session.cancelledReason,
    session.config,
    session.effective,
  ]);
}

/**
 * What a session on disk is now.
 *
 * A turn that was running when its owner died is `abandoned`. A session another
 * server still holds is whatever that server last wrote. A status this build
 * cannot read leaves the session unrestorable, which is an error.
 */
export function statusOfRecovered(rec: RecoveredSession): SessionStatus {
  const recorded = rec.meta.status;
  const known = SESSION_STATUSES.includes(recorded as never)
    ? (recorded as SessionStatus)
    : undefined;
  if (known === undefined) return "error";
  const wasActive = known === "running" || known === "waiting_approval";
  return wasActive && rec.owner.kind !== "held" ? "abandoned" : known;
}

/** The in-memory session a new `createSession` call describes. */
export function newSessionRecord(fields: {
  sessionId: string;
  now: string;
  cwd: string;
  spawnOpts: AppServerSpawnOptions;
  effort: EffortLevel;
  developerInstructions: string | undefined;
  approvalTimeoutMs: number;
  advanced: CreateSessionAdvanced | undefined;
}): SessionInfo {
  const { sessionId, now, cwd, spawnOpts, effort, developerInstructions, approvalTimeoutMs } =
    fields;
  const { advanced } = fields;
  return {
    sessionId,
    status: "running",
    createdAt: now,
    lastActiveAt: now,
    approvalTimeoutMs,
    cwd,
    model: spawnOpts.model,
    profile: spawnOpts.profile,
    approvalPolicy: spawnOpts.approvalPolicy,
    sandbox: spawnOpts.sandbox,
    approvalsReviewer: advanced?.approvalsReviewer,
    permissions: advanced?.permissions,
    personality: advanced?.personality,
    effort,
    summary: advanced?.summary,
    config: spawnOpts.config,
    pendingRequests: new Map(),
    lastAgentMessageText: undefined,
    progressState: { lastEventAt: now },
    baseInstructions: advanced?.baseInstructions,
    developerInstructions,
  };
}

/** The in-memory session a recovered record describes, timestamps included. */
export function sessionOfRecovered(
  rec: RecoveredSession,
  createdAt: string,
  lastActiveAt: string
): SessionInfo {
  const resolvedStatus = statusOfRecovered(rec);
  const recoveredReason = normalizeOptionalString(rec.meta.cancelledReason);
  const result = rec.result as TurnResult | undefined;
  return {
    sessionId: rec.meta.sessionId,
    threadId: normalizeOptionalString(rec.meta.threadId),
    status: resolvedStatus,
    createdAt,
    lastActiveAt,
    cancelledAt: normalizeOptionalString(rec.meta.cancelledAt),
    cancelledReason:
      recoveredReason ??
      (resolvedStatus === "error" && !SESSION_STATUSES.includes(rec.meta.status as never)
        ? `Recovered with a status this server cannot read: ${JSON.stringify(rec.meta.status)}`
        : undefined),
    cwd: normalizeOptionalString(rec.meta.cwd),
    model: normalizeOptionalString(rec.meta.model),
    profile: normalizeOptionalString(rec.meta.profile),
    approvalPolicy: readOneOf(APPROVAL_POLICIES, rec.meta.approvalPolicy),
    sandbox: readOneOf(SANDBOX_MODES, rec.meta.sandbox),
    approvalsReviewer: readOneOf(APPROVALS_REVIEWERS, rec.meta.approvalsReviewer),
    permissions: normalizeOptionalString(rec.meta.permissions),
    personality: rec.meta.personality as Personality | undefined,
    effort: rec.meta.effort as EffortLevel | undefined,
    summary: rec.meta.summary as SummaryMode | undefined,
    config: isRecord(rec.meta.config) ? rec.meta.config : undefined,
    baseInstructions: normalizeOptionalString(rec.meta.baseInstructions),
    developerInstructions: normalizeOptionalString(rec.meta.developerInstructions),
    effective: readEffectiveSettings(rec.meta.effective),
    approvalTimeoutMs:
      typeof rec.meta.approvalTimeoutMs === "number" ? rec.meta.approvalTimeoutMs : undefined,
    pendingRequests: new Map(),
    lastResult: result,
    lastAgentMessageText: typeof result?.text === "string" ? result.text : undefined,
    progressState: {
      lastEventAt: lastActiveAt,
      tokens: extractTokens(result?.turn),
      activity: rec.lastActivity,
      // The record holds the line, not the instant it arrived. The session
      // was last active then, which is the closest the disk answers.
      activityAt: rec.lastActivity === undefined ? undefined : lastActiveAt,
    },
  };
}

/**
 * Read the thread id of a `thread/start` or `thread/fork` response.
 *
 * Both answer `{thread: Thread}` (codex-schema/v2/ThreadStartResponse.json,
 * v2/ThreadForkResponse.json). No response of the bundle
 * puts a thread id anywhere else, so a differently shaped answer is a backend
 * this server cannot drive: the session needs the id, so it throws rather than
 * carrying on with an id it made up.
 */
export function extractThreadId(result: unknown): string {
  if (!isRecord(result)) {
    throw new Error(`Error [${ErrorCode.INTERNAL}]: Invalid thread response: expected object`);
  }

  const thread = result.thread;
  if (isRecord(thread) && typeof thread.id === "string" && thread.id.length > 0) return thread.id;

  throw new Error(`Error [${ErrorCode.INTERNAL}]: Invalid thread response: missing thread id`);
}

/**
 * The settings Codex answered a thread call with.
 *
 * `thread/start`, `thread/fork` and `thread/resume` all report what the thread
 * runs with rather than what the call asked for, and a `thread/resume` reads
 * them out of Codex's own rollout log, so they can name settings this server
 * never recorded. `meta.json` carries the block back under the same names, so a
 * recovered session reads through this same function.
 *
 * Each field is read in the shape `codex-schema/v2/ThreadStartResponse.json`
 * gives it and left out otherwise. Unlike the thread id, none of it is worth
 * failing the call over — a session runs perfectly well without knowing its
 * effective model — and a field left out is a setting the session reports as
 * unknown, never one filled in from the argument the call sent.
 */
export function readEffectiveSettings(source: unknown): EffectiveSettings | undefined {
  if (!isRecord(source)) return undefined;
  const settings: EffectiveSettings = {
    model: readNonEmptyString(source.model),
    modelProvider: readNonEmptyString(source.modelProvider),
    // Optional on the response, and null for a model advertising no effort.
    reasoningEffort: readNonEmptyString(source.reasoningEffort),
    approvalPolicy: readAskForApproval(source.approvalPolicy),
    sandbox: readSandboxPolicy(source.sandbox),
    cwd: readNonEmptyString(source.cwd),
    // Required by the schema, and a session that does not know its reviewer
    // still runs, so an answer without one reports it unknown like the rest.
    approvalsReviewer: readOneOf(ANSWERED_APPROVALS_REVIEWERS, source.approvalsReviewer),
    activePermissionProfile: readActivePermissionProfile(source.activePermissionProfile),
  };
  return Object.values(settings).some((value) => value !== undefined) ? settings : undefined;
}

/** A policy preset the schema lists, or its `granular` object. */
function readAskForApproval(value: unknown): AskForApproval | undefined {
  if (typeof value === "string") return readOneOf(APPROVAL_POLICY_PRESETS, value);
  if (!isRecord(value) || !isRecord(value.granular)) return undefined;
  return value as unknown as AskForApprovalGranular;
}

/**
 * The profile of the active permissions, which the answer identifies by `id`.
 * `extends` is null for a profile naming no parent, and absent then here too.
 */
function readActivePermissionProfile(value: unknown): EffectivePermissionProfile | undefined {
  if (!isRecord(value)) return undefined;
  const id = readNonEmptyString(value.id);
  if (id === undefined) return undefined;
  const parent = readNonEmptyString(value.extends);
  return parent === undefined ? { id } : { id, extends: parent };
}

/** One of the four policy objects the schema's `SandboxPolicy` union carries. */
function readSandboxPolicy(value: unknown): SandboxPolicy | undefined {
  if (!isRecord(value) || typeof value.type !== "string") return undefined;
  return SANDBOX_POLICY_TYPES.includes(value.type as SandboxPolicy["type"])
    ? (value as SandboxPolicy)
    : undefined;
}

/** The effective settings a redacted view carries: `cwd` is a path and stays out. */
export function publicEffectiveSettings(
  effective: EffectiveSettings | undefined
): PublicEffectiveSettings | undefined {
  if (!effective) return undefined;
  const { cwd: _cwd, ...redacted } = effective;
  return Object.values(redacted).some((value) => value !== undefined) ? redacted : undefined;
}

/**
 * Read the turn id of a `turn/start` response, which answers `{turn: Turn}`
 * (codex-schema/v2/TurnStartResponse.json).
 *
 * Optional: the id is a seed for `activeTurnId` and the `turn/started`
 * notification is what settles it. The one response of the bundle carrying a
 * bare `turnId` answers `turn/steer`, which `steerSession` reads on its own —
 * that id is the running turn's, not a new one's.
 */
export function extractTurnId(result: unknown): string | undefined {
  if (!isRecord(result)) return undefined;

  const turn = result.turn;
  if (isRecord(turn) && typeof turn.id === "string" && turn.id.length > 0) return turn.id;

  return undefined;
}
