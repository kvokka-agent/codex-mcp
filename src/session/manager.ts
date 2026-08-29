/**
 * SessionManager — manages Codex session lifecycle, status and approval flow.
 */
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { AppServerClient } from "../app-server/client.js";
import type { ICodexClient } from "../app-server/client-interface.js";
import type { AppServerSpawnOptions } from "../app-server/lifecycle.js";
import {
  type CommandApprovalParams,
  type CommandApprovalResponse,
  type DynamicToolCallResponse,
  type FileChangeApprovalResponse,
  type LegacyApprovalResponse,
  Methods,
  type RequestId,
  type TurnStartParams,
  toSandboxPolicy,
  type UserInput,
  type UserInputRequestResponse,
} from "../app-server/protocol.js";
import {
  describeOwner,
  type OwnerState,
  ownerState,
  type RecoveredSession,
  readOwner,
} from "../persistence/index.js";
import {
  type ApprovalPolicy,
  type CheckResult,
  CLEANUP_INTERVAL_MS,
  type CleanableStatus,
  COMMAND_DECISIONS,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  DEFAULT_IDLE_CLEANUP_MS,
  DEFAULT_POLL_INTERVAL,
  DEFAULT_RUNNING_CLEANUP_MS,
  DEFAULT_TERMINAL_CLEANUP_MS,
  type EffortLevel,
  ErrorCode,
  FILE_CHANGE_DECISIONS,
  type LastTurnInfo,
  MAX_LONG_POLL_WAIT_MS,
  type NetworkPolicyAmendment,
  type PendingAction,
  type PendingRequest,
  type Personality,
  type ProgressInfo,
  type ProgressPhase,
  type ProgressTokens,
  type PublicSessionInfo,
  type SandboxMode,
  SESSION_STATUSES,
  type SensitiveSessionInfo,
  type SessionEventType,
  type SessionInfo,
  type SessionOwnership,
  type SessionSignal,
  type SessionStartResult,
  type SessionStatus,
  type SummaryMode,
  type TurnResult,
  WAITING_APPROVAL_POLL_INTERVAL,
} from "../types.js";
import { resolveAndValidateCwd } from "../utils/cwd.js";
import { interactionStateForStatus, recommendedNextActionForStatus } from "../utils/execution.js";
import { resolveAndValidateFilePath } from "../utils/files.js";
import { redactPaths } from "../utils/redact.js";
import {
  buildEffortFallbackWarning,
  classifyTurnCompatibilityError,
  toFriendlyTurnCompatibilityError,
} from "../utils/turn-compat.js";
import {
  ActivityMarkerScanner,
  composeDeveloperInstructions,
  stripActivityMarkers,
  stripActivityMarkersFromTurn,
} from "./activity-marker.js";
import type { PidDetails } from "./persistence.js";

const AUTH_REFRESH_UNSUPPORTED_CODE = -32000;
const AUTH_REFRESH_UNSUPPORTED_MESSAGE =
  "account/chatgptAuthTokens/refresh unsupported: codex-mcp does not manage external ChatGPT auth tokens";
const AUTH_REFRESH_TERMINAL_MESSAGE =
  "account/chatgptAuthTokens/refresh unsupported: session is terminal";

// ── Shell noise filtering ────────────────────────────────────────────
// On Windows, PowerShell profile output (oh-my-posh, PSReadLine, etc.) leaks
// into every command execution, wasting tokens in MCP client contexts.
// These patterns are stripped from COMMAND_OUTPUT_DELTA events before they
// reach the event log.  Disable with CODEX_MCP_DISABLE_NOISE_FILTER=1.
const NOISE_FILTER_ENABLED = process.env.CODEX_MCP_DISABLE_NOISE_FILTER !== "1";
const WINDOWS_TERMINAL_INTEGRATION_PREFIX = `${String.fromCharCode(0x1b)}]633;`;

const SHELL_NOISE_LINE_PATTERNS: RegExp[] = [
  // oh-my-posh migration / update prompts
  /oh-my-posh/i,
  // PSReadLine configuration errors
  /PSReadLine/i,
  /Set-PSReadLineOption/i,
  // PowerShell module auto-import warnings
  /^WARNING:\s/,
  // PowerShell profile loading messages
  /Loading personal and system profiles/i,
  // conda/mamba init noise that leaks through profiles
  /^(\(base\)|\(conda\))/,
  // Common "new version available" nag lines from profile tools
  /A new version of .+ is available/i,
];

/**
 * Strip known shell profile noise lines from a command output delta.
 * Returns the cleaned string, or empty string if everything was noise.
 */
function stripShellNoise(delta: string): string {
  if (!NOISE_FILTER_ENABLED) return delta;
  const lines = delta.split("\n");
  const cleaned = lines.filter(
    (line) =>
      !line.includes(WINDOWS_TERMINAL_INTEGRATION_PREFIX) &&
      !SHELL_NOISE_LINE_PATTERNS.some((re) => re.test(line))
  );
  // Preserve original trailing newline structure
  if (cleaned.length === 0) return "";
  return cleaned.join("\n");
}

export interface SessionManagerOptions {
  /** Inject client factory (for tests or to select exec mode). */
  createClient?: () => ICodexClient;
  /** Disable background cleanup timer (useful for tests). */
  disableCleanup?: boolean;
  /** Disk persistence adapter (optional). */
  persistence?: import("./persistence.js").SessionPersistence;
}

/** What `createSession` may be given beyond the session's own spawn options. */
interface CreateSessionAdvanced {
  baseInstructions?: string;
  developerInstructions?: string;
  personality?: Personality;
  ephemeral?: boolean;
  config?: Record<string, unknown>;
  images?: string[];
  outputSchema?: Record<string, unknown>;
  summary?: SummaryMode;
  approvalTimeoutMs?: number;
}

const TTL_WARNING_THRESHOLD_MS = 60_000;
const MAX_WAITERS_PER_SESSION = 4;
const EFFORT_FALLBACK_LEVEL: EffortLevel = "low";
/**
 * What `clean` removes when the caller names no statuses.
 *
 * `abandoned` is not among them: a session nobody holds is what somebody looking
 * for interrupted work is about to resume, so removing it takes a caller asking
 * for it by name.
 */
const DEFAULT_CLEANABLE_STATUSES: CleanableStatus[] = ["idle", "error", "cancelled"];
const REASONING_PROGRESS_METHODS = new Set<string>([
  Methods.REASONING_TEXT_DELTA,
  Methods.REASONING_SUMMARY_DELTA,
  Methods.REASONING_SUMMARY_PART_ADDED,
  Methods.PLAN_DELTA,
]);
/** Operation names of `reportPersistFailure`, which also key its one-line-per-session set. */
const PERSIST_OP_META = "session metadata";
const PERSIST_OP_RESULT = "turn result";

/**
 * The notifications that go into the event log as progress and move nothing else.
 *
 * None of them is a failure, so they stay out of the "error" type and leave the
 * session status alone.
 */
const PLAIN_PROGRESS_METHODS = new Set<string>([
  Methods.THREAD_ARCHIVED,
  Methods.THREAD_UNARCHIVED,
  Methods.THREAD_NAME_UPDATED,
  Methods.THREAD_TOKEN_USAGE_UPDATED,
  Methods.FUZZY_FILE_SEARCH_SESSION_UPDATED,
  Methods.FUZZY_FILE_SEARCH_SESSION_COMPLETED,
  Methods.WINDOWS_WORLD_WRITABLE_WARNING,
  Methods.ACCOUNT_LOGIN_COMPLETED,
  Methods.COMMAND_TERMINAL_INTERACTION,
  Methods.FILE_CHANGE_OUTPUT_DELTA,
  Methods.REASONING_TEXT_DELTA,
  Methods.REASONING_SUMMARY_DELTA,
  Methods.REASONING_SUMMARY_PART_ADDED,
  Methods.PLAN_DELTA,
  Methods.MCP_TOOL_PROGRESS,
  Methods.TURN_DIFF_UPDATED,
  Methods.TURN_PLAN_UPDATED,
  Methods.MODEL_REROUTED,
  Methods.THREAD_CLOSED,
  Methods.THREAD_COMPACTED,
  Methods.DEPRECATION_NOTICE,
  Methods.CONFIG_WARNING,
]);

const ACTING_PROGRESS_METHODS = new Set<string>([
  Methods.COMMAND_OUTPUT_DELTA,
  Methods.COMMAND_TERMINAL_INTERACTION,
  Methods.FILE_CHANGE_OUTPUT_DELTA,
  Methods.MCP_TOOL_PROGRESS,
  Methods.TURN_DIFF_UPDATED,
  Methods.TURN_PLAN_UPDATED,
]);

/** How a pending request answers, and what it records, when its timeout fires. */
interface PendingTimeout {
  /** Names the action in the line a failed auto-answer logs. */
  action: string;
  /** Sends the answer to the app-server on the caller's behalf. */
  respond: (result: unknown) => void;
  /** The answer itself. */
  response: unknown;
  /** Recorded on the pending request; a user-input question decides nothing. */
  decision?: string;
  /** `approval_result` fields beyond `requestId` and `timeout`. */
  event: Record<string, unknown>;
}

export class SessionManager {
  private sessions = new Map<string, SessionInfo>();
  private clients = new Map<string, ICodexClient>();
  private cancellationInFlight = new Map<string, Promise<void>>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private createClient: () => ICodexClient;
  /** Optional disk persistence adapter. */
  readonly persistence: import("./persistence.js").SessionPersistence | null;
  /** Fingerprint of the metadata last written per session, to skip a write that changes nothing. */
  private lastPersistedMeta = new Map<string, string>();
  /** Sessions for which a TTL warning event has already been emitted this cycle. */
  private ttlWarningEmitted = new Set<string>();
  /** Sessions whose event persistence already reported a failure — keeps stderr to one line. */
  private eventPersistFailed = new Set<string>();
  /** Persistence failures already reported, keyed `${operation}\0${sessionId}`. */
  private persistFailureReported = new Set<string>();
  /** Sessions whose running turn was started with an `outputSchema`. */
  private schemaConstrainedTurns = new Set<string>();
  /** Long-poll notifiers: set of resolve callbacks waiting for a change in a session. */
  private sessionNotifiers = new Map<string, Set<() => void>>();
  /** The signal each session last woke its waiters on — see `notifyWaiters`. */
  private lastNotifiedSignal = new Map<string, string>();

  constructor(options: SessionManagerOptions = {}) {
    this.createClient = options.createClient ?? (() => new AppServerClient());
    this.persistence = options.persistence ?? null;

    if (!options.disableCleanup) {
      this.cleanupTimer = setInterval(() => this.cleanupSessions(), CLEANUP_INTERVAL_MS);
      if (this.cleanupTimer.unref) this.cleanupTimer.unref();
    }
  }

  /**
   * Take into memory the sessions of this state directory that no other server holds.
   *
   * A session another running codex-mcp owns is left where it is: that server is
   * writing into the directory, and two servers on one Codex thread would each
   * answer half the turn. A session whose owner is gone is adopted, its stale
   * claim removed, and a turn that was running when the owner died becomes
   * `abandoned` — the work was cut off, and `resume` picks the thread back up.
   *
   * Every field comes from the recovered metadata, timestamps included: a session that
   * was cut off keeps the instant it was last active, so idle cleanup and the retention
   * policy — which both date a session by `lastActiveAt` — still measure its real age
   * after a restart instead of measuring the restart.
   */
  ingestRecovered(recovered: RecoveredSession[]): void {
    for (const rec of recovered) {
      if (this.sessions.has(rec.sessionId)) continue; // skip duplicates
      this.takeRecovered(rec);
    }
  }

  /** Take one recovered session into memory, or say on stderr why it stays on disk. */
  private takeRecovered(rec: RecoveredSession): void {
    if (rec.owner.kind === "held") {
      console.error(
        `[codex-mcp] Session ${rec.sessionId} is ${describeOwner(rec.owner)} — leaving it to that server`
      );
      return;
    }
    const createdAt = normalizeOptionalString(rec.meta.createdAt);
    const lastActiveAt = normalizeOptionalString(rec.meta.lastActiveAt);
    if (!createdAt || !lastActiveAt) {
      // Both timestamps decide when cleanup cancels the session and when retention drops
      // its directory. Reading the clock for a missing one would date every restart as
      // fresh activity and keep the directory for good, so the session stays out.
      console.error(
        `[codex-mcp] Skipping recovered session ${rec.sessionId}: meta.json records no ` +
          `${!createdAt ? "createdAt" : "lastActiveAt"}`
      );
      return;
    }
    const session = sessionOfRecovered(rec, createdAt, lastActiveAt);
    this.registerSession(session);
    // The owner is gone, so its claim on the session goes with it.
    if (rec.owner.kind === "gone") this.persistence?.release(rec.sessionId);
    // Resume event log sequence numbering
    if (rec.lastSeq >= 0) {
      this.persistence?.setEventLogNextSeq(rec.sessionId, rec.lastSeq + 1);
    }
    this.attachEventSink(session);
    // Record what the session now is, so the next reader sees `abandoned`
    // rather than a `running` status no process backs.
    if (session.status !== rec.meta.status) this.persistSessionIfChanged(session);
  }

  /**
   * Mirror this session's events into its events.jsonl.
   *
   * Persistence is best-effort: a write that fails is reported once per session and
   * leaves the session running, with its status and its result held in memory.
   */
  private attachEventSink(session: SessionInfo): void {
    const persistence = this.persistence;
    if (!persistence) return;
    const sessionId = session.sessionId;
    setEventSink(session, (type, data, timestamp) => {
      try {
        persistence.appendEvent(sessionId, type, data, timestamp);
      } catch (err) {
        if (this.eventPersistFailed.has(sessionId)) return;
        this.eventPersistFailed.add(sessionId);
        console.error(
          `[codex-mcp] Failed to persist events: session=${sessionId} error=${err instanceof Error ? err.message : String(err)}`
        );
      }
    });
  }

  /**
   * Report a persistence write that failed.
   *
   * The session goes on running from memory, so what the caller is told and what a
   * restart would find drift apart from here on: one stderr line per session and
   * operation says which write was lost and why, without a line per turn.
   */
  private reportPersistFailure(operation: string, sessionId: string, err: unknown): void {
    const key = `${operation}\0${sessionId}`;
    if (this.persistFailureReported.has(key)) return;
    this.persistFailureReported.add(key);
    console.error(
      `[codex-mcp] Failed to persist ${operation}: session=${sessionId} error=${describeError(err)}`
    );
  }

  /**
   * Write the session's metadata to disk when any of it changed.
   *
   * The comparison covers every field meta.json carries, so the thread id
   * reaches the file the moment Codex hands it over rather than at the next
   * status change — a session cut off inside its first turn is resumable only
   * if its thread id is already there.
   */
  private persistSessionIfChanged(session: SessionInfo): void {
    if (!this.persistence) return;
    const fingerprint = metaFingerprint(session);
    if (this.lastPersistedMeta.get(session.sessionId) === fingerprint) return;
    try {
      this.persistence.writeSessionMeta(session);
      this.lastPersistedMeta.set(session.sessionId, fingerprint);
    } catch (err) {
      this.reportPersistFailure(PERSIST_OP_META, session.sessionId, err);
    }
  }

  /**
   * Record whether the turn about to start constrains its final message with a
   * JSON Schema — `turn/completed` carries no schema of its own, so this is what
   * tells the completion handler to read the message as structured output.
   */
  private markTurnOutputSchema(sessionId: string, outputSchema?: Record<string, unknown>): void {
    if (outputSchema && Object.keys(outputSchema).length > 0) {
      this.schemaConstrainedTurns.add(sessionId);
    } else {
      this.schemaConstrainedTurns.delete(sessionId);
    }
  }

  /**
   * Best-effort persist result to disk.
   */
  private persistResult(session: SessionInfo): void {
    if (!this.persistence || !session.lastResult) return;
    try {
      this.persistence.writeResult(session.sessionId, session.lastResult);
    } catch (err) {
      // A result that never reaches result.json comes back as `lastResult: null` after a
      // restart, which reads exactly like a turn that produced nothing.
      this.reportPersistFailure(PERSIST_OP_RESULT, session.sessionId, err);
    }
  }

  private async startTurnWithCompatibilityFallback(
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

  async createSession(
    prompt: string,
    cwd: string,
    spawnOpts: AppServerSpawnOptions,
    effort: EffortLevel,
    advanced?: CreateSessionAdvanced
  ): Promise<SessionStartResult> {
    const sessionId = `sess_${randomUUID().slice(0, 12)}`;
    const client = this.createClient();

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

    this.openNewSession(session, client);

    try {
      return await this.startFirstTurn(
        session,
        client,
        spawnOpts,
        prompt,
        resolvedImages,
        advanced
      );
    } catch (err) {
      await this.discardFailedSession(session, client, err);
      throw err;
    }
  }

  /** Take a new session into memory, claim it for this server, and open its directory. */
  private openNewSession(session: SessionInfo, client: ICodexClient): void {
    const { sessionId } = session;
    this.registerSession(session);
    this.clients.set(sessionId, client);
    this.attachEventSink(session);

    // Persist session metadata to disk and claim the session for this server
    try {
      this.persistence?.writeSessionMeta(session);
      this.persistence?.claim(sessionId);
    } catch (err) {
      // The first write is what creates the session directory: without it nothing about
      // this session survives a restart, while the compat report still says
      // `diskPersistence: true`.
      this.reportPersistFailure(PERSIST_OP_META, sessionId, err);
    }
  }

  /** Start the app-server, open the thread and run the session's first turn on it. */
  private async startFirstTurn(
    session: SessionInfo,
    client: ICodexClient,
    spawnOpts: AppServerSpawnOptions,
    prompt: string,
    resolvedImages: string[] | undefined,
    advanced: CreateSessionAdvanced | undefined
  ): Promise<SessionStartResult> {
    const { sessionId } = session;
    // Register event handlers before start to prevent unhandled "error" events
    this.registerHandlers(session, client, session.approvalTimeoutMs);

    // Start app-server subprocess
    await client.start(spawnOpts);

    // Start thread
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
    });
    const threadId = extractThreadId(threadStartResult);
    session.threadId = threadId;
    // The first turn can run for minutes and a client can die inside it. The
    // thread id is what a resume needs, so it goes to disk on arrival rather
    // than with the next status change.
    this.persistSessionIfChanged(session);

    // Build input array
    const input: UserInput[] = [{ type: "text", text: prompt }];
    if (resolvedImages) {
      for (const imagePath of resolvedImages) {
        input.push({ type: "localImage", path: imagePath });
      }
    }

    // Start first turn
    this.markTurnOutputSchema(sessionId, advanced?.outputSchema);
    const turnStart = await this.startTurnWithCompatibilityFallback(client, {
      threadId,
      input,
      effort: session.effort,
      summary: advanced?.summary,
      outputSchema: advanced?.outputSchema,
    });
    const turnStartResult = turnStart.turnStartResult;

    // Best-effort: seed activeTurnId from response if present (notifications are authoritative)
    const startedTurnId = extractTurnId(turnStartResult);
    if (startedTurnId) session.activeTurnId = startedTurnId;

    return {
      sessionId,
      threadId,
      status: "running",
      pollInterval: DEFAULT_POLL_INTERVAL,
      compatWarnings: turnStart.compatWarnings,
      progress: this.getProgress(sessionId),
    };
  }

  /** Give up a session whose first turn never started, on disk as well as in memory. */
  private async discardFailedSession(
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
    this.clients.delete(sessionId);
    // Drop the half-created session from memory and from disk: the caller gets
    // an error and no session id, and a leftover directory would come back as
    // a recovered session on the next server start.
    this.evictSession(sessionId, true);
  }

  // ── Session Reply ────────────────────────────────────────────────

  async replyToSession(
    sessionId: string,
    prompt: string,
    overrides?: TurnOverrides
  ): Promise<SessionStartResult> {
    const session = this.getSessionOrThrow(sessionId);

    assertSessionAcceptsTurn(session, sessionId);
    if (!session.threadId) {
      throw new Error(
        `Error [${ErrorCode.INTERNAL}]: Session '${sessionId}' has no threadId, cannot reply`
      );
    }

    const client = this.getClientOrThrow(sessionId);

    this.openReplyTurn(session);

    const resolvedCwd = resolveTurnCwd(session, sessionId, overrides);

    const turnParams = buildTurnParams(session, session.threadId, prompt, overrides, resolvedCwd);

    let compatWarnings: string[] | undefined;
    this.markTurnOutputSchema(sessionId, overrides?.outputSchema);
    try {
      const turnStart = await this.startTurnWithCompatibilityFallback(client, turnParams);
      compatWarnings = turnStart.compatWarnings;
      const turnStartResult = turnStart.turnStartResult;
      const startedTurnId = extractTurnId(turnStartResult);
      if (startedTurnId) session.activeTurnId = startedTurnId;

      const unappliedWarning = this.recordTurnOverrides(session, client, overrides, resolvedCwd);
      if (unappliedWarning) compatWarnings = [...(compatWarnings ?? []), unappliedWarning];
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
      progress: this.getProgress(sessionId),
    };
  }

  /** Put the session on the turn it is about to start, and drop the finished turn's answer. */
  private openReplyTurn(session: SessionInfo): void {
    // The finished turn's answer belongs to that turn: a check of the new one
    // reports the new result or none.
    session.lastResult = undefined;
    session.lastAgentMessageText = undefined;

    session.status = "running";
    session.lastActiveAt = new Date().toISOString();
    this.persistSessionIfChanged(session);
  }

  // ── Session Management ───────────────────────────────────────────

  /** The sessions this server holds in memory. */
  listSessions(): PublicSessionInfo[] {
    return Array.from(this.sessions.values()).map((session) =>
      toPublicInfo(session, this.ownershipOfSession(session.sessionId))
    );
  }

  /**
   * Every session of the state directory: the ones this server drives, the ones
   * another running server drives, and the ones nobody holds.
   *
   * The directory is read on each call rather than at startup, because the
   * picture changes underneath: a server that died a minute ago left sessions
   * this one can resume, and a server that started a minute ago holds sessions
   * this one must not touch.
   */
  listAllSessions(): PublicSessionInfo[] {
    const byId = new Map<string, PublicSessionInfo>();
    for (const rec of this.scanDisk()) {
      byId.set(rec.sessionId, publicInfoOfRecovered(rec));
    }
    for (const session of this.sessions.values()) {
      // A session with a live client here is this server's, and memory is ahead
      // of the file. One without a client was adopted or given up, and the
      // directory carries whatever has happened to it since.
      if (this.clients.has(session.sessionId) || !byId.has(session.sessionId)) {
        byId.set(
          session.sessionId,
          toPublicInfo(session, this.ownershipOfSession(session.sessionId))
        );
      }
    }
    return Array.from(byId.values()).sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
  }

  /** Read the state directory, reporting a scan that failed rather than serving an empty one. */
  private scanDisk(): RecoveredSession[] {
    if (!this.persistence) return [];
    try {
      return this.persistence.recoverSessions();
    } catch (err) {
      console.error(`[codex-mcp] Failed to read the state directory: ${describeError(err)}`);
      return [];
    }
  }

  /** Who holds a session: this server while it drives it, else whatever owner.json says. */
  private ownershipOfSession(sessionId: string): SessionOwnership | undefined {
    if (this.clients.has(sessionId)) return { pid: process.pid, state: "self" };
    if (!this.persistence) return undefined;
    return ownershipOf(ownerState(readOwner(this.persistence.sessionDir(sessionId))));
  }

  /**
   * Count currently active sessions for lightweight runtime observability.
   * "Active" here means the session can still be interacted with.
   */
  getActiveSessionCount(): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (
        session.status === "running" ||
        session.status === "waiting_approval" ||
        session.status === "idle"
      ) {
        count++;
      }
    }
    return count;
  }

  /**
   * Best-effort effective default model observed from recent sessions.
   * Returns null when no model can be inferred from in-memory state.
   */
  getObservedDefaultModel(): string | null {
    let latestModel: string | null = null;
    let latestTs = Number.NEGATIVE_INFINITY;

    for (const session of this.sessions.values()) {
      if (session.status === "cancelled") continue;
      if (typeof session.model !== "string" || session.model.length === 0) continue;

      const ts = Date.parse(session.lastActiveAt);
      const comparableTs = Number.isFinite(ts) ? ts : Number.NEGATIVE_INFINITY;
      if (comparableTs >= latestTs) {
        latestTs = comparableTs;
        latestModel = session.model;
      }
    }

    return latestModel;
  }

  getSession(
    sessionId: string,
    includeSensitive = false
  ): PublicSessionInfo | SensitiveSessionInfo {
    const session = this.getSessionOrThrow(sessionId);
    const owner = this.ownershipOfSession(sessionId);
    return includeSensitive ? toSensitiveInfo(session, owner) : toPublicInfo(session, owner);
  }

  getLastResult(sessionId: string): TurnResult | undefined {
    return this.getSessionOrThrow(sessionId).lastResult;
  }

  getProgress(sessionId: string): ProgressInfo {
    return buildProgressInfo(this.getSessionOrThrow(sessionId));
  }

  /**
   * Hear each new activity line of a session for as long as the returned
   * function is not called.
   *
   * It is what a caller holding a tool call open reports upward as the line
   * arrives, before the poll it is holding answers.
   */
  onActivity(sessionId: string, listener: (activity: string) => void): () => void {
    const session = this.getSessionOrThrow(sessionId);
    let listeners = activityListeners.get(session);
    if (!listeners) {
      listeners = new Set();
      activityListeners.set(session, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  getPendingActionTypes(sessionId: string): Array<"approval" | "user_input"> {
    const session = this.getSessionOrThrow(sessionId);
    const actionTypes = new Set<"approval" | "user_input">();
    for (const req of session.pendingRequests.values()) {
      if (req.resolved) continue;
      actionTypes.add(req.kind === "user_input" ? "user_input" : "approval");
    }
    return Array.from(actionTypes);
  }

  async cancelSession(sessionId: string, reason?: string): Promise<void> {
    const existing = this.cancellationInFlight.get(sessionId);
    if (existing) {
      await existing;
      return;
    }

    const cancellation = this.performCancelSession(sessionId, reason);
    this.cancellationInFlight.set(sessionId, cancellation);
    try {
      await cancellation;
    } finally {
      this.cancellationInFlight.delete(sessionId);
    }
  }

  private async performCancelSession(sessionId: string, reason?: string): Promise<void> {
    const session = this.getSessionOrThrow(sessionId);

    // Idempotent: already cancelled
    if (session.status === "cancelled") return;

    const client = this.clients.get(sessionId);

    session.status = "cancelled";
    const now = new Date().toISOString();
    session.cancelledAt = now;
    session.lastActiveAt = now;
    session.cancelledReason = reason ?? "Cancelled by user";

    // Persist cancelled status to disk
    this.persistSessionIfChanged(session);

    this.cancelPendingRequests(session);

    recordEvent(session, "progress", {
      message: "Session cancelled",
      cancelledReason: session.cancelledReason,
    });

    const cancelledTurnId = session.activeTurnId ?? "";
    session.activeTurnId = undefined;
    // A turn that already ended left its answer in `lastResult`, and a turn that starts
    // clears it — so a result here belongs to a finished turn and the cancel keeps it.
    // Overwriting it left result.json saying "cancelled" for a session that had answered,
    // and the answer was gone from disk. The cancellation is in meta.json's
    // `cancelledAt`/`cancelledReason` and in the event log below.
    if (!session.lastResult) {
      session.lastResult = {
        turnId: cancelledTurnId,
        outcome: "cancelled",
        status: "cancelled",
        error: session.cancelledReason,
        completedAt: new Date().toISOString(),
      };
      this.persistResult(session);
    }
    recordEvent(session, "result", {
      status: "cancelled",
      reason: session.cancelledReason,
      turnId: cancelledTurnId,
    });
    // Wake long-poll waiters so they see the cancellation immediately
    this.notifyWaiters(sessionId);

    if (client) {
      await client.destroy();
      this.clients.delete(sessionId);
    }
  }

  /** Answer every request the cancelled session still holds open, so nothing waits on it. */
  private cancelPendingRequests(session: SessionInfo): void {
    const { sessionId } = session;
    // Resolve and clear all pending requests (avoid leaving hanging server-initiated requests)
    for (const [reqId, req] of session.pendingRequests) {
      if (req.timeoutHandle) clearTimeout(req.timeoutHandle);
      if (!req.resolved && req.respond) {
        req.resolved = true;
        try {
          respondCancelled(req);
        } catch (err) {
          console.error(
            `[codex-mcp] Failed to respond pending request during cancel: session=${sessionId} request=${reqId} kind=${req.kind} error=${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
      session.pendingRequests.delete(reqId);
    }
  }

  async interruptSession(sessionId: string): Promise<void> {
    const session = this.getSessionOrThrow(sessionId);

    // Status first: cancelSession drops the client, so a client lookup ahead of this
    // reports a cancelled session as SESSION_NOT_FOUND.
    if (session.status === "cancelled") {
      throw new Error(
        `Error [${ErrorCode.CANCELLED}]: Session '${sessionId}' has been cancelled and cannot be interrupted`
      );
    }
    if (session.status !== "running" && session.status !== "waiting_approval") {
      throw new Error(
        `Error [${ErrorCode.SESSION_NOT_RUNNING}]: Cannot interrupt session in ${session.status} state`
      );
    }

    if (!session.threadId || !session.activeTurnId) {
      throw new Error(
        `Error [${ErrorCode.INTERNAL}]: Missing threadId or activeTurnId for interrupt`
      );
    }

    const client = this.getClientOrThrow(sessionId);

    await client.turnInterrupt({
      threadId: session.threadId,
      turnId: session.activeTurnId,
    });
  }

  async cleanBackgroundTerminals(sessionId: string): Promise<void> {
    const session = this.getSessionOrThrow(sessionId);

    // Status first: cancelSession drops the client, so a client lookup ahead of this
    // reports a cancelled session as SESSION_NOT_FOUND.
    if (session.status === "cancelled") {
      throw new Error(
        `Error [${ErrorCode.CANCELLED}]: Session '${sessionId}' has been cancelled and cannot be cleaned`
      );
    }
    if (!session.threadId) {
      throw new Error(
        `Error [${ErrorCode.INTERNAL}]: Session '${sessionId}' has no threadId, cannot clean background terminals`
      );
    }

    const client = this.getClientOrThrow(sessionId);

    await client.threadBackgroundTerminalsClean({ threadId: session.threadId });
    session.lastActiveAt = new Date().toISOString();
    recordEvent(session, "progress", {
      method: Methods.THREAD_BACKGROUND_TERMINALS_CLEAN,
      threadId: session.threadId,
      status: "requested",
    });
  }

  async cleanSessions(options?: {
    statuses?: CleanableStatus[];
    olderThanMs?: number;
    dryRun?: boolean;
    includeDisk?: boolean;
  }): Promise<{
    matchedSessionIds: string[];
    removedSessionIds: string[];
    removedCount: number;
    diskSessionsRemoved: number;
    dryRun: boolean;
    /** Set when a session directory removal was asked for and failed; names the sessions. */
    message?: string;
  }> {
    const statuses = new Set<string>(options?.statuses ?? DEFAULT_CLEANABLE_STATUSES);
    const olderThanMs = options?.olderThanMs;
    const dryRun = options?.dryRun ?? false;
    const includeDisk = options?.includeDisk ?? true;
    const now = Date.now();
    const matchedSessionIds = this.matchCleanableSessions(statuses, olderThanMs, now);

    if (dryRun) {
      return {
        matchedSessionIds,
        removedSessionIds: [],
        removedCount: 0,
        diskSessionsRemoved: 0,
        dryRun: true,
      };
    }

    const { removedSessionIds, diskSessionsRemoved, diskFailures } = this.evictMatchedSessions(
      matchedSessionIds,
      includeDisk
    );

    return {
      matchedSessionIds,
      removedSessionIds,
      removedCount: removedSessionIds.length,
      diskSessionsRemoved,
      dryRun: false,
      // Without this, a failed removal reports the same numbers as `includeDisk: false`
      // and the caller reads a directory that is still there as cleaned.
      ...(diskFailures.length > 0 ? { message: stillOnDiskMessage(diskFailures) } : {}),
    };
  }

  /** The sessions `clean` removes: those in one of `statuses` and idle for long enough. */
  private matchCleanableSessions(
    statuses: Set<string>,
    olderThanMs: number | undefined,
    now: number
  ): string[] {
    const matchedSessionIds: string[] = [];
    for (const [sessionId, session] of Array.from(this.sessions.entries())) {
      if (!statuses.has(session.status)) continue;
      if (!isOlderThan(session.lastActiveAt, olderThanMs, now)) continue;
      matchedSessionIds.push(sessionId);
    }
    return matchedSessionIds;
  }

  /** Drop each matched session, counting what went and naming what stayed on disk. */
  private evictMatchedSessions(
    matchedSessionIds: string[],
    includeDisk: boolean
  ): { removedSessionIds: string[]; diskSessionsRemoved: number; diskFailures: string[] } {
    let diskSessionsRemoved = 0;
    const removedSessionIds: string[] = [];
    const diskFailures: string[] = [];
    for (const sessionId of matchedSessionIds) {
      const evicted = this.evictSession(sessionId, includeDisk);
      if (evicted.deleted) {
        removedSessionIds.push(sessionId);
      }
      if (evicted.diskRemoved) {
        diskSessionsRemoved++;
      }
      if (evicted.diskError) {
        diskFailures.push(`${sessionId} (${evicted.diskError})`);
      }
    }
    return { removedSessionIds, diskSessionsRemoved, diskFailures };
  }

  /**
   * Pick a session nobody holds back up and drive it from here.
   *
   * `thread/resume` reads the thread out of Codex's own rollout log, so the
   * model comes back knowing where it was cut off — including a turn that never
   * finished, which arrives with `status: "interrupted"`. The session is then a
   * normal idle session: `codex_reply` carries it on.
   */
  async resumeSession(sessionId: string): Promise<SessionStartResult> {
    const session = this.adoptForResume(sessionId);
    if (!session.threadId) {
      throw new Error(
        `Error [${ErrorCode.INTERNAL}]: Session '${sessionId}' records no threadId, so there is no thread to resume`
      );
    }
    const threadId = session.threadId;
    const previousStatus = session.status;

    const client = this.createClient();
    this.clients.set(sessionId, client);
    this.attachEventSink(session);

    try {
      this.registerHandlers(session, client, session.approvalTimeoutMs);
      await client.start({
        profile: session.profile,
        model: session.model,
        approvalPolicy: session.approvalPolicy,
        sandbox: session.sandbox,
        config: session.config,
      });
      await client.threadResume({
        threadId,
        personality: session.personality,
        baseInstructions: session.baseInstructions,
        developerInstructions: session.developerInstructions,
      });
      session.threadId = threadId;
      session.status = "idle";
      session.lastActiveAt = new Date().toISOString();
      this.persistence?.claim(sessionId);
      this.persistSessionIfChanged(session);
      this.notifyWaiters(sessionId);

      return {
        sessionId,
        threadId,
        status: "idle" as const,
        pollInterval: DEFAULT_POLL_INTERVAL,
        progress: this.getProgress(sessionId),
      };
    } catch (err) {
      session.status = previousStatus;
      this.clients.delete(sessionId);
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
  private adoptForResume(sessionId: string): SessionInfo {
    if (this.clients.has(sessionId)) {
      throw new Error(
        `Error [${ErrorCode.SESSION_BUSY}]: Session '${sessionId}' is already open on this server`
      );
    }
    if (this.persistence) {
      const state = ownerState(readOwner(this.persistence.sessionDir(sessionId)));
      if (state.kind === "held") {
        throw new Error(
          `Error [${ErrorCode.SESSION_HELD_BY_OTHER_SERVER}]: Session '${sessionId}' is ${describeOwner(state)}`
        );
      }
    }

    const known = this.sessions.get(sessionId);
    if (known) return known;

    const found = this.scanDisk().find((rec) => rec.sessionId === sessionId);
    if (!found) {
      throw new Error(`Error [${ErrorCode.SESSION_NOT_FOUND}]: Session '${sessionId}' not found`);
    }
    this.ingestRecovered([found]);
    const adopted = this.sessions.get(sessionId);
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
  finalizeForShutdown(): void {
    for (const session of this.sessions.values()) {
      if (session.status === "running" || session.status === "waiting_approval") {
        session.status = "abandoned";
        session.lastActiveAt = new Date().toISOString();
      }
      this.persistSessionIfChanged(session);
    }
    this.persistence?.flushAll();
    this.persistence?.releaseAll();
  }

  async forkSession(sessionId: string): Promise<SessionStartResult> {
    const session = this.getSessionOrThrow(sessionId);

    // Status first: cancelSession drops the client, so a client lookup ahead of this
    // reports a cancelled session as SESSION_NOT_FOUND.
    if (session.status === "cancelled") {
      throw new Error(
        `Error [${ErrorCode.CANCELLED}]: Session '${sessionId}' has been cancelled and cannot be forked`
      );
    }
    if (!session.threadId) {
      throw new Error(`Error [${ErrorCode.INTERNAL}]: No threadId to fork`);
    }

    const originalClient = this.getClientOrThrow(sessionId);

    // Fork the thread on the ORIGINAL client (which holds the thread state)
    const forkResult = await originalClient.threadFork({
      threadId: session.threadId,
      baseInstructions: session.baseInstructions,
      developerInstructions: session.developerInstructions,
    });
    const forkedThreadId = extractThreadId(forkResult);

    // Create new session with its own app-server process
    const newSessionId = `sess_${randomUUID().slice(0, 12)}`;
    const newClient = this.createClient();
    const now = new Date().toISOString();

    const newSession: SessionInfo = {
      sessionId: newSessionId,
      status: "idle",
      createdAt: now,
      lastActiveAt: now,
      approvalTimeoutMs: session.approvalTimeoutMs,
      cwd: session.cwd,
      model: session.model,
      profile: session.profile,
      approvalPolicy: session.approvalPolicy,
      sandbox: session.sandbox,
      personality: session.personality,
      effort: session.effort,
      summary: session.summary,
      config: session.config,
      pendingRequests: new Map(),
      baseInstructions: session.baseInstructions,
      developerInstructions: session.developerInstructions,
    };

    this.registerSession(newSession);
    this.clients.set(newSessionId, newClient);
    this.attachEventSink(newSession);
    this.persistSessionIfChanged(newSession);
    this.persistence?.claim(newSessionId);

    try {
      // Register handlers before start to prevent unhandled "error" events
      this.registerHandlers(newSession, newClient, newSession.approvalTimeoutMs);

      // Start new app-server subprocess
      await newClient.start({
        profile: session.profile,
        model: session.model,
        approvalPolicy: session.approvalPolicy,
        sandbox: session.sandbox,
        config: session.config,
      });

      // Resume the forked thread on the new process
      await newClient.threadResume({
        threadId: forkedThreadId,
        personality: session.personality,
        baseInstructions: session.baseInstructions,
        developerInstructions: session.developerInstructions,
      });
      newSession.threadId = forkedThreadId;
      this.persistSessionIfChanged(newSession);

      return {
        sessionId: newSessionId,
        threadId: forkedThreadId,
        status: "idle" as const,
        pollInterval: DEFAULT_POLL_INTERVAL,
      };
    } catch (err) {
      const errorMessage = redactPaths(err instanceof Error ? err.message : String(err));
      console.error(
        `[codex-mcp] forkSession failed after thread/fork created thread=${forkedThreadId}. The app-server protocol does not currently expose a guaranteed thread-delete RPC, so manual cleanup may be required.`
      );
      newSession.status = "error";
      try {
        await newClient.destroy();
      } catch (destroyErr) {
        console.error(
          `[codex-mcp] Failed to destroy forked app-server client after resume failure: session=${newSessionId} error=${destroyErr instanceof Error ? destroyErr.message : String(destroyErr)}`
        );
      }
      this.clients.delete(newSessionId);
      this.evictSession(newSessionId, true);
      throw new Error(
        `Error [${ErrorCode.THREAD_FORK_RESUME_FAILED}]: Failed to resume forked thread '${forkedThreadId}' in new app-server process: ${errorMessage}`
      );
    }
  }

  // ── Long-poll support ────────────────────────────────────────────

  /**
   * Wait until the session state a caller acts on changes, or `timeoutMs`
   * elapses (whichever comes first). `notifyWaiters` decides what counts.
   *
   * Rejects with an error when more than MAX_WAITERS_PER_SESSION concurrent
   * waiters are already queued for the same session.
   */
  waitForChange(sessionId: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        resolve();
        return;
      }

      const known = this.sessionNotifiers.get(sessionId);
      const notifiers = known ?? new Set<() => void>();
      if (!known) {
        this.sessionNotifiers.set(sessionId, notifiers);
      }
      if (notifiers.size >= MAX_WAITERS_PER_SESSION) {
        reject(
          new Error(
            `[codex-mcp] Too many concurrent long-poll waiters for session '${sessionId}' (max ${MAX_WAITERS_PER_SESSION})`
          )
        );
        return;
      }

      const clampedMs = Math.min(Math.max(0, timeoutMs), MAX_LONG_POLL_WAIT_MS);

      const done = (): void => {
        notifiers.delete(notifyFn);
        if (notifiers.size === 0) this.sessionNotifiers.delete(sessionId);
        clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onAbort);
        resolve();
      };

      const notifyFn = done;
      const timer = setTimeout(done, clampedMs);
      if (timer.unref) timer.unref();

      const onAbort = (): void => done();
      if (signal) signal.addEventListener("abort", onAbort, { once: true });

      notifiers.add(notifyFn);
    });
  }

  /**
   * Take a session into the store with the signal it starts on, so the first
   * change of it is what wakes a waiter rather than the first notification.
   */
  private registerSession(session: SessionInfo): void {
    this.sessions.set(session.sessionId, session);
    this.lastNotifiedSignal.set(session.sessionId, signalOf(session));
  }

  /**
   * Wake the long-poll waiters of a session, for what they act on and for what
   * they report: the status, the set of open actions, the result of a finished
   * turn, and each new line the turn says it is working on.
   *
   * Nothing else wakes them. A measured run of ten parallel sessions delivered
   * 20.2% agent-message deltas and 25.7% token-counter updates; waking on those
   * turned a 120s long poll into a 4.8s median round trip and put the whole
   * transcript through the caller's context. Those move `signalOf` not at all,
   * so a waiter sleeps through them, while the handful of activity lines a turn
   * writes each move it once.
   */
  private notifyWaiters(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    const signal = session ? signalOf(session) : `gone:${sessionId}`;
    if (this.lastNotifiedSignal.get(sessionId) === signal) return;
    this.lastNotifiedSignal.set(sessionId, signal);

    const notifiers = this.sessionNotifiers.get(sessionId);
    if (!notifiers || notifiers.size === 0) return;
    // Snapshot to avoid mutation issues during iteration
    for (const fn of Array.from(notifiers)) {
      fn();
    }
  }

  // ── Status ───────────────────────────────────────────────────────

  /**
   * Where the session stands and what it waits for.
   *
   * The turn's own events are not part of it: Codex writes the whole transcript
   * to its rollout log under `~/.codex/sessions/`, and repeating it here would
   * put the run through the caller's context a second time.
   */
  pollStatus(sessionId: string): CheckResult {
    const session = this.getSessionOrThrow(sessionId);

    const actions: PendingAction[] = [];
    for (const req of session.pendingRequests.values()) {
      if (req.resolved) continue;
      actions.push({
        type: req.kind === "user_input" ? "user_input" : "approval",
        requestId: req.requestId,
        kind: req.kind,
        params: req.params,
        itemId: req.itemId,
        reason: req.reason,
        approvalId: req.approvalId,
        commandActions: req.commandActions,
        proposedExecpolicyAmendment: req.proposedExecpolicyAmendment,
        availableDecisions: req.availableDecisions,
        proposedNetworkPolicyAmendments: req.proposedNetworkPolicyAmendments,
        additionalPermissions: req.additionalPermissions,
        networkApprovalContext: req.networkApprovalContext,
        createdAt: req.createdAt,
      });
    }

    return {
      sessionId,
      status: session.status,
      pollInterval: pollIntervalForStatus(session.status),
      progress: buildProgressInfo(session),
      interactionState: interactionStateForStatus(session.status),
      recommendedNextAction: recommendedNextActionForStatus(
        session.status,
        Array.from(new Set(actions.map((action) => action.type)))
      ),
      actions,
      result: this.terminalTurnResult(sessionId),
    };
  }

  /**
   * The finished turn's answer, for as long as the session stands on it.
   *
   * Every check of a terminal session carries it, not the first one alone. A
   * caller that checks again — it retried, it lost the answer, its response was
   * dropped by a transport that cut the call — reads the answer back instead of
   * an empty result it then fills in from memory. Only the next turn replaces
   * it.
   */
  terminalTurnResult(sessionId: string): TurnResult | undefined {
    const session = this.getSessionOrThrow(sessionId);
    if (!TERMINAL_SESSION_STATUSES.has(session.status)) return undefined;
    return session.lastResult;
  }

  /**
   * What a long-poll caller waits on: the status, the open actions and the
   * result of the turn.
   */
  getSessionSignal(sessionId: string): SessionSignal {
    const session = this.getSessionOrThrow(sessionId);
    return {
      key: signalOf(session),
      awaitsCaller:
        countPendingRequests(session) > 0 ||
        (TERMINAL_SESSION_STATUSES.has(session.status) && !awaitsTurnRecord(session)),
    };
  }

  // ── Approval Response ────────────────────────────────────────────

  resolveApproval(
    sessionId: string,
    requestId: string,
    decision: string,
    extra?: ApprovalExtra
  ): void {
    const session = this.getSessionOrThrow(sessionId);
    const req = session.pendingRequests.get(requestId);

    if (!req || req.resolved) {
      throw new Error(
        `Error [${ErrorCode.REQUEST_NOT_FOUND}]: Request '${requestId}' not found or already resolved`
      );
    }

    // Validate decision by kind (avoid sending invalid protocol payloads)
    assertApprovalDecision(req, requestId, decision, extra);

    // Build protocol response
    const response = buildApprovalResponse(req, decision, extra);

    if (!response) {
      throw new Error(
        `Error [${ErrorCode.INTERNAL}]: Failed to build approval response for request '${requestId}'`
      );
    }

    // Mark as resolved while sending to avoid duplicate timeout/response races.
    req.resolved = true;
    req.decision = decision;
    try {
      sendPendingRequestResponseOrThrow(req, response, sessionId, requestId);
    } catch (error) {
      req.resolved = false;
      req.decision = undefined;
      session.pendingRequests.set(requestId, req);
      if (session.status !== "cancelled") {
        session.status = "waiting_approval";
      }
      throw error;
    }

    if (req.timeoutHandle) clearTimeout(req.timeoutHandle);

    // Push approval_result event
    recordEvent(session, "approval_result", {
      requestId,
      kind: req.kind,
      approvalId: req.approvalId,
      decision,
      denyMessage: extra?.denyMessage,
    });

    this.settlePendingRequest(session, requestId);
  }

  /**
   * Drop an answered request and give the session back the status it runs on.
   *
   * The waiters are woken last, so the poll they return to reads the session as
   * it now stands rather than as it was while the request was open.
   */
  private settlePendingRequest(session: SessionInfo, requestId: string): void {
    // Remove resolved request to prevent unbounded growth
    session.pendingRequests.delete(requestId);

    // Restore status if no more pending requests
    if (session.pendingRequests.size === 0 && session.status === "waiting_approval") {
      session.status = "running";
    }

    // Wake any long-poll waiters so they see the status transition
    this.notifyWaiters(session.sessionId);
  }

  // ── User Input Response ──────────────────────────────────────────

  resolveUserInput(
    sessionId: string,
    requestId: string,
    answers: Record<string, { answers: string[] }>
  ): void {
    const session = this.getSessionOrThrow(sessionId);
    const req = session.pendingRequests.get(requestId);

    if (!req || req.resolved || req.kind !== "user_input") {
      throw new Error(
        `Error [${ErrorCode.REQUEST_NOT_FOUND}]: User input request '${requestId}' not found`
      );
    }

    req.resolved = true;
    try {
      sendPendingRequestResponseOrThrow(
        req,
        { answers } as UserInputRequestResponse,
        sessionId,
        requestId
      );
    } catch (error) {
      req.resolved = false;
      session.pendingRequests.set(requestId, req);
      if (session.status !== "cancelled") {
        session.status = "waiting_approval";
      }
      throw error;
    }

    if (req.timeoutHandle) clearTimeout(req.timeoutHandle);

    recordEvent(session, "approval_result", {
      requestId,
      kind: "user_input",
      approvalId: req.approvalId,
      answers: loggableAnswers(req.params, answers),
    });

    this.settlePendingRequest(session, requestId);
  }

  // ── Cleanup ──────────────────────────────────────────────────────

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.cancellationInFlight.clear();

    // Clear all pending request timers
    for (const [, session] of this.sessions) {
      clearSessionPendingRequests(session);
    }

    for (const [id, client] of this.clients) {
      client.destroy().catch((err) => {
        console.error(
          `[codex-mcp] Failed to destroy app-server client during manager.destroy(): session=${id} error=${err instanceof Error ? err.message : String(err)}`
        );
      });
      this.clients.delete(id);
    }
    this.sessions.clear();
    this.lastNotifiedSignal.clear();
    this.eventPersistFailed.clear();
    try {
      this.persistence?.flushAll();
    } catch {
      /* best-effort */
    }
  }

  // ── Private ──────────────────────────────────────────────────────

  private getSessionOrThrow(sessionId: string): SessionInfo {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Error [${ErrorCode.SESSION_NOT_FOUND}]: Session '${sessionId}' not found`);
    }
    return session;
  }

  private getClientOrThrow(sessionId: string): ICodexClient {
    const client = this.clients.get(sessionId);
    if (!client) {
      throw new Error(
        `Error [${ErrorCode.SESSION_NOT_FOUND}]: No client for session '${sessionId}'`
      );
    }
    return client;
  }

  /**
   * Record what the turn actually ran with, and name what it could not apply.
   *
   * Read after `turnStart` because that is the call the answer describes.
   * `unappliedTurnOverrides` is the client naming what its command line could
   * not carry; a client that reports none still says through
   * `supportsTurnOverrides` that cwd and sandbox do not reach a turn past the
   * first. The return is the sentence for `compatWarnings`, or nothing when the
   * turn applied everything it was asked for.
   */
  private recordTurnOverrides(
    session: SessionInfo,
    client: ICodexClient,
    overrides: TurnOverrides | undefined,
    resolvedCwd: string | undefined
  ): string | undefined {
    const canOverride = client.supportsTurnOverrides;
    const requestedValue: Record<string, string | undefined> = {
      sandbox: overrides?.sandbox,
      cwd: resolvedCwd,
    };
    const requestedNames = Object.entries(requestedValue)
      .filter(([, value]) => value !== undefined)
      .map(([name]) => name);
    const unapplied = client.unappliedTurnOverrides ?? (canOverride ? [] : requestedNames);

    applyTurnOverrides(
      session,
      overrides,
      resolvedCwd,
      (name) => canOverride && !unapplied.includes(name)
    );
    // The turn runs for minutes and the server can die inside it; what the session
    // now runs with reaches meta.json here rather than at the next status change.
    this.persistSessionIfChanged(session);

    if (unapplied.length === 0) return undefined;

    if (unapplied.includes("outputSchema")) {
      // The turn output is not schema-constrained, so reading its text as structured
      // output would hand the caller a shape the model was never asked for.
      this.schemaConstrainedTurns.delete(session.sessionId);
    }
    // A caller narrowing the sandbox and reading `status: "running"` would otherwise
    // take the narrower permissions for granted while codex keeps writing under the
    // wider ones.
    return unappliedTurnWarning(unapplied, requestedValue, {
      sandbox: session.sandbox,
      cwd: session.cwd,
    });
  }

  /** `thread/started` — the notification that carries the real thread id. */
  private onThreadStarted(session: SessionInfo, method: string, p: Record<string, unknown>): void {
    const thread = isRecord(p.thread) ? p.thread : undefined;
    // Update session.threadId if the notification provides a real thread ID
    // (e.g. ExecClient returns a synthetic ID from threadStart(), then the
    // real ID arrives via the thread.started JSONL event).
    const notifiedThreadId =
      normalizeOptionalString(p.threadId) ?? normalizeOptionalString(thread?.id);
    if (notifiedThreadId && notifiedThreadId !== session.threadId) {
      session.threadId = notifiedThreadId;
      this.persistSessionIfChanged(session);
    }
    // Thread.status is a ThreadStatus union object whose variant is named
    // by `type` — "notLoaded" | "idle" | "systemError" | "active"
    // (codex-schema/v2/ThreadStartedNotification.json → Thread.status →
    // ThreadStatus), the same shape `thread/status/changed` carries.
    const threadStatus = isRecord(thread?.status) ? thread.status : undefined;
    recordEvent(session, "progress", {
      method,
      ...p,
      threadId: notifiedThreadId,
      status: normalizeOptionalString(threadStatus?.type),
    });
  }

  /** `turn/completed` — the notification that writes `lastResult`. */
  private onTurnCompleted(session: SessionInfo, method: string, p: Record<string, unknown>): void {
    const turnObj = p.turn as Record<string, unknown> | undefined;
    const completedTurnId = turnIdOfCompleted(session, turnObj);
    const rawTurnOutput = outputOfCompleted(turnObj);
    const finalText = rawTurnOutput ?? session.lastAgentMessageText;
    const askedForSchema = this.schemaConstrainedTurns.delete(session.sessionId);
    session.status = "idle";
    session.activeTurnId = undefined;
    session.lastResult = {
      turnId: completedTurnId,
      outcome: "completed",
      text: finalText,
      output: rawTurnOutput,
      structuredOutput: askedForSchema ? parseStructuredOutput(finalText) : undefined,
      // The turn record carries the assistant text a second time, in
      // `output` or `items[].text`, and that copy has seen no stripping.
      turn: stripActivityMarkersFromTurn(p.turn),
      status: turnObj?.status as string | undefined,
      turnError: turnObj?.error,
      completedAt: new Date().toISOString(),
    };
    // Like `output`, `usage` is ExecClient's addition — it forwards the
    // `usage` of the exec `turn.completed` record. App-server mode counts
    // tokens through `thread/tokenUsage/updated` only, so this merge adds
    // nothing there.
    mergeProgressTokens(session, extractTokens(turnObj?.usage));
    recordEvent(session, "result", {
      method,
      ...p,
      turnId: completedTurnId,
      status: normalizeOptionalString(turnObj?.status),
    });
    // Persist idle status + result to disk
    this.persistSessionIfChanged(session);
    this.persistResult(session);
  }

  /** `error` — a failure, or a reconnect when the server says it will retry. */
  private onErrorNotification(
    session: SessionInfo,
    method: string,
    p: Record<string, unknown>
  ): void {
    const willRetry = p.willRetry as boolean;
    if (!willRetry) {
      session.status = "error";
    }
    const data: Record<string, unknown> = { method, ...p };
    // The notification carries `[error, threadId, turnId, willRetry]` and
    // no text of its own (codex-schema/v2/ErrorNotification.json).
    // ErrorNotification.error is a TurnError object whose `message` carries the
    // text; a bare string arrives from builds predating that shape.
    if (typeof data.error === "string") {
      data.error = redactPaths(data.error);
    } else if (isRecord(data.error) && typeof data.error.message === "string") {
      data.error = { ...data.error, message: redactPaths(data.error.message) };
    }
    if (willRetry) {
      recordEvent(session, "progress", {
        ...data,
        method: "codex-mcp/reconnect",
        sourceMethod: method,
        phase: "retrying",
      });
      return;
    }
    recordEvent(session, "error", data);
    // Persist error status to disk
    this.persistSessionIfChanged(session);
  }

  /** `item/agentMessage/delta` — the stream the activity marker is lifted out of. */
  private onAgentMessageDelta(
    session: SessionInfo,
    method: string,
    p: Record<string, unknown>
  ): void {
    if (typeof p.delta === "string") {
      let lines = 0;
      for (const line of scannerOf(session).push(p.delta)) {
        recordActivity(session, line, normalizeOptionalString(p.itemId));
        lines += 1;
      }
      // A new line is what the person waiting reads, so the poll holding
      // this session answers with it rather than sitting out its window.
      if (lines > 0) this.notifyWaiters(session.sessionId);
    }
    recordEvent(session, "output", { method, delta: p.delta, itemId: p.itemId });
  }

  /** `thread/status/changed` — the notification that moves the session status. */
  private onThreadStatusChanged(
    session: SessionInfo,
    method: string,
    p: Record<string, unknown>
  ): void {
    const threadStatus = isRecord(p.status) ? p.status : undefined;
    const statusType = normalizeOptionalString(threadStatus?.type);
    const activeFlags = Array.isArray(threadStatus?.activeFlags)
      ? (threadStatus.activeFlags as unknown[])
      : undefined;
    const nextStatus = sessionStatusForThreadStatus(session, statusType);
    const statusChanged = nextStatus !== undefined && nextStatus !== session.status;
    if (statusChanged) session.status = nextStatus;
    const failed = session.status === "error" && statusChanged;
    recordEvent(session, failed ? "error" : "progress", {
      method,
      ...p,
      statusType,
      activeFlags,
    });
    if (statusChanged) this.persistSessionIfChanged(session);
  }

  /**
   * Put a pending request in the session and arm its timeout.
   *
   * A caller that never answers gets `timeout.response` sent on its behalf, and
   * the session drops back to `running` once nothing is pending. The send is
   * wrapped because the client may already be destroyed by the time the timer
   * fires.
   */
  private awaitPendingRequest(
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
      this.settlePendingRequest(session, requestId);
    }, approvalTimeoutMs);

    session.pendingRequests.set(requestId, pending);
    session.status = "waiting_approval";
    recordEvent(session, "approval_request", { requestId, ...request });
  }

  /** Route one notification to the handler that acts on it. */
  private handleNotification(
    session: SessionInfo,
    method: string,
    p: Record<string, unknown>
  ): void {
    if (PLAIN_PROGRESS_METHODS.has(method)) {
      recordEvent(session, "progress", { method, ...p });
      return;
    }

    switch (method) {
      case Methods.THREAD_STARTED:
        this.onThreadStarted(session, method, p);
        break;

      case Methods.TURN_STARTED:
        if (session.status !== "cancelled") onTurnStarted(session, method, p);
        break;

      case Methods.TURN_COMPLETED:
        if (session.status !== "cancelled") this.onTurnCompleted(session, method, p);
        break;

      case Methods.ERROR:
        if (session.status !== "cancelled") this.onErrorNotification(session, method, p);
        break;

      case Methods.AGENT_MESSAGE_DELTA:
        this.onAgentMessageDelta(session, method, p);
        break;

      case Methods.ITEM_STARTED:
      case Methods.ITEM_COMPLETED:
      case Methods.RAW_RESPONSE_ITEM_COMPLETED:
        onItemNotification(session, method, p);
        break;

      case Methods.COMMAND_OUTPUT_DELTA:
        this.onCommandOutputDelta(session, method, p);
        break;

      case Methods.THREAD_STATUS_CHANGED:
        this.onThreadStatusChanged(session, method, p);
        break;

      default:
        // Ignore other notifications (account, config, etc.)
        break;
    }
  }

  /** `item/commandExecution/outputDelta` — the stream shell profile noise is cut from. */
  private onCommandOutputDelta(
    session: SessionInfo,
    method: string,
    p: Record<string, unknown>
  ): void {
    // Filter known shell profile noise (PowerShell oh-my-posh, PSReadLine, etc.)
    if (typeof p.delta === "string") {
      const cleaned = stripShellNoise(p.delta);
      if (cleaned.length === 0) return; // entire delta was noise, skip event
      recordEvent(session, "progress", { method, ...p, delta: cleaned });
    } else {
      recordEvent(session, "progress", { method, ...p });
    }
  }

  /** Route one server-initiated request to the handler that answers it. */
  private handleServerRequest(
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
        this.awaitCommandApproval(session, client, id, method, params, approvalTimeoutMs);
        break;

      case Methods.FILE_CHANGE_APPROVAL:
        this.awaitFileChangeApproval(session, client, id, method, params, approvalTimeoutMs);
        break;

      case Methods.USER_INPUT_REQUEST:
        this.awaitUserInput(session, client, id, method, params, approvalTimeoutMs);
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
  private awaitCommandApproval(
    session: SessionInfo,
    client: ICodexClient,
    id: RequestId,
    method: string,
    params: unknown,
    approvalTimeoutMs: number
  ): void {
    const requestId = `req_${randomUUID().slice(0, 8)}`;
    const approvalParams = params as CommandApprovalParams & Record<string, unknown>;
    const fields = commandApprovalFields(approvalParams);
    const pending: PendingRequest = {
      requestId,
      kind: "command",
      params,
      ...correlationIds(approvalParams, method, session.sessionId),
      ...fields,
      createdAt: new Date().toISOString(),
      resolved: false,
      respond: (result) => client.respondToServer(id, result),
    };

    this.awaitPendingRequest(
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
  private awaitFileChangeApproval(
    session: SessionInfo,
    client: ICodexClient,
    id: RequestId,
    method: string,
    params: unknown,
    approvalTimeoutMs: number
  ): void {
    const p = params as Record<string, unknown>;
    const requestId = `req_${randomUUID().slice(0, 8)}`;
    const reason = normalizeOptionalString(p.reason);
    const pending: PendingRequest = {
      requestId,
      kind: "fileChange",
      params,
      ...correlationIds(p, method, session.sessionId),
      reason,
      createdAt: new Date().toISOString(),
      resolved: false,
      respond: (result) => client.respondToServer(id, result),
    };

    this.awaitPendingRequest(
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
  private awaitUserInput(
    session: SessionInfo,
    client: ICodexClient,
    id: RequestId,
    method: string,
    params: unknown,
    approvalTimeoutMs: number
  ): void {
    const p = params as Record<string, unknown>;
    const requestId = `req_${randomUUID().slice(0, 8)}`;
    const pending: PendingRequest = {
      requestId,
      kind: "user_input",
      params,
      ...correlationIds(p, method, session.sessionId),
      createdAt: new Date().toISOString(),
      resolved: false,
      respond: (result) => client.respondToServer(id, result),
    };

    this.awaitPendingRequest(
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

  private registerHandlers(
    session: SessionInfo,
    client: ICodexClient,
    approvalTimeoutMs = DEFAULT_APPROVAL_TIMEOUT_MS
  ): void {
    const { sessionId } = session;

    // Persist PID info for orphan detection on the next startup. The client
    // reports every process it spawns: app-server spawns one in `start()`,
    // exec spawns one per turn, so the file follows the live child.
    client.on("spawn", (pid: number, spawnedAt: string) => {
      this.persistSpawnedPid(session, pid, spawnedAt);
    });

    // Handle notifications
    client.onNotification((method, params) => {
      session.lastActiveAt = new Date().toISOString();
      const p = params as Record<string, unknown>;
      recordProgressObservation(session, method, p);

      this.handleNotification(session, method, p);

      // Wake any long-poll waiters after every notification
      this.notifyWaiters(sessionId);
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

      this.handleServerRequest(session, client, id, method, params, approvalTimeoutMs);

      // Wake any long-poll waiters after every server-initiated request (new pending approval)
      this.notifyWaiters(sessionId);
    });

    // Handle subprocess exit
    client.on("exit", (code: number | null) => {
      this.failOnSubprocessLoss(session, `app-server exited unexpectedly (code: ${code})`);
    });

    // Handle subprocess spawn errors (must listen to prevent uncaught exception)
    client.on("error", (err: Error) => {
      this.failOnSubprocessLoss(session, redactPaths(`app-server error: ${err.message}`));
    });
  }

  /** Write down the pid of every process the client spawns, for the orphan reaper. */
  private persistSpawnedPid(session: SessionInfo, pid: number, spawnedAt: string): void {
    const { sessionId } = session;
    // spawnedAt is the instant the client spawned the process; the reaper
    // matches it against the start time the OS reports for that pid.
    const details: PidDetails & { spawnedAt?: string } = { model: session.model, spawnedAt };
    try {
      this.persistence?.writePidInfo(sessionId, pid, details);
    } catch (err) {
      // Every spawn that never reaches pid.json is a codex process the orphan reaper
      // cannot find on the next start, so each one is reported rather than the first.
      console.error(
        `[codex-mcp] Failed to persist pid.json — pid ${pid} will not be reaped after a ` +
          `restart: session=${sessionId} error=${describeError(err)}`
      );
    }
  }

  /** The app-server went away under a live turn: the turn failed, and the session says so. */
  private failOnSubprocessLoss(session: SessionInfo, message: string): void {
    clearSessionPendingRequests(session);
    if (session.status === "running" || session.status === "waiting_approval") {
      session.status = "error";
      setTerminalErrorResult(session, message);
      recordEvent(session, "error", {
        message,
      });
      this.persistSessionIfChanged(session);
      this.persistResult(session);
      this.notifyWaiters(session.sessionId);
    }
  }

  private cleanupSessions(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      const lastActive = new Date(session.lastActiveAt).getTime();
      if (Number.isNaN(lastActive)) {
        // Invalid timestamp — clean up immediately
        this.ttlWarningEmitted.delete(id);
        this.requestCancellation(id, "Invalid timestamp");
        continue;
      }
      const age = now - lastActive;

      const expiredReason = expiryReasonForAge(session.status, age);
      if (expiredReason !== undefined) {
        this.ttlWarningEmitted.delete(id);
        this.requestCancellation(id, expiredReason);
      } else if (isRetentionExpired(session.status, age)) {
        this.evictSession(id, true);
      } else {
        this.warnBeforeExpiry(id, session, age);
      }
    }
  }

  /** Say once, on the session's own event log, that its TTL is about to run out. */
  private warnBeforeExpiry(id: string, session: SessionInfo, age: number): void {
    // Check if this session is within the TTL warning window.
    const ttlMs = ttlForStatus(session.status);
    if (ttlMs === undefined || this.ttlWarningEmitted.has(id)) return;
    const timeUntilExpiry = ttlMs - age;
    if (timeUntilExpiry <= TTL_WARNING_THRESHOLD_MS && timeUntilExpiry > 0) {
      this.ttlWarningEmitted.add(id);
      recordEvent(session, "progress", {
        method: "codex-mcp/ttl_warning",
        type: "ttl_warning",
        ttlRemainingMs: timeUntilExpiry,
        sessionId: id,
      });
    }
  }

  private requestCancellation(sessionId: string, reason: string): void {
    if (this.cancellationInFlight.has(sessionId)) return;
    this.cancelSession(sessionId, reason).catch((err) => {
      console.error(
        `[codex-mcp] Failed to cancel session during cleanup: session=${sessionId} reason=${reason} error=${err instanceof Error ? err.message : String(err)}`
      );
    });
  }

  private evictSession(
    sessionId: string,
    removeDisk: boolean
  ): {
    deleted: boolean;
    diskRemoved: boolean;
    /** Why the session directory is still on disk, when removal was asked for and failed. */
    diskError?: string;
  } {
    const session = this.sessions.get(sessionId);
    if (!session) return { deleted: false, diskRemoved: false };

    clearSessionPendingRequests(session);
    this.clients
      .get(sessionId)
      ?.destroy()
      .catch((err) => {
        console.error(
          `[codex-mcp] Failed to destroy app-server client during cleanup: session=${sessionId} error=${err instanceof Error ? err.message : String(err)}`
        );
      });
    this.clients.delete(sessionId);
    const deleted = this.sessions.delete(sessionId);
    // After the removal: a waiter is woken by the session being gone, which is a
    // change it acts on, and its next read reports the session as not found.
    this.notifyWaiters(sessionId);
    this.lastPersistedMeta.delete(sessionId);
    this.ttlWarningEmitted.delete(sessionId);
    this.sessionNotifiers.delete(sessionId);
    this.lastNotifiedSignal.delete(sessionId);
    this.cancellationInFlight.delete(sessionId);
    this.eventPersistFailed.delete(sessionId);
    this.schemaConstrainedTurns.delete(sessionId);
    this.persistFailureReported.delete(`${PERSIST_OP_META}\0${sessionId}`);
    this.persistFailureReported.delete(`${PERSIST_OP_RESULT}\0${sessionId}`);
    let diskRemoved = false;
    let diskError: string | undefined;
    try {
      if (this.persistence) {
        if (removeDisk) {
          this.persistence.removeSession(sessionId);
          diskRemoved = true;
        } else {
          // Flush what the session buffered, drop its log handle, and give the
          // session back: this server no longer drives it.
          this.persistence.destroySessionLog(sessionId);
          this.persistence.release(sessionId);
        }
      }
    } catch (err) {
      // A directory that could not be removed still holds the session's paths and code
      // fragments, and `diskSessionsRemoved: 0` alone reads like disk removal was never
      // asked for — so the caller is told which sessions are still there.
      const detail = describeError(err);
      if (removeDisk) diskError = detail;
      console.error(
        `[codex-mcp] Failed to ${removeDisk ? "remove the session directory" : "close the event log"}: ` +
          `session=${sessionId} error=${detail}`
      );
    }

    return { deleted, diskRemoved, ...(diskError ? { diskError } : {}) };
  }
}

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Everything meta.json carries, as one string to compare two writes by.
 *
 * `lastActiveAt` is deliberately absent: every notification of a turn moves it,
 * and writing meta.json for each would put a file write on the hot path without
 * changing anything a reader acts on.
 */
function metaFingerprint(session: SessionInfo): string {
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
  ]);
}

/**
 * What a session on disk is now.
 *
 * A turn that was running when its owner died is `abandoned`. A session another
 * server still holds is whatever that server last wrote. A status this build
 * cannot read leaves the session unrestorable, which is an error.
 */
function statusOfRecovered(rec: RecoveredSession): SessionStatus {
  const recorded = rec.meta.status;
  const known = SESSION_STATUSES.includes(recorded as never)
    ? (recorded as SessionStatus)
    : undefined;
  if (known === undefined) return "error";
  const wasActive = known === "running" || known === "waiting_approval";
  return wasActive && rec.owner.kind !== "held" ? "abandoned" : known;
}

/** The in-memory session a new `createSession` call describes. */
function newSessionRecord(fields: {
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
function sessionOfRecovered(
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
    approvalPolicy: rec.meta.approvalPolicy as ApprovalPolicy | undefined,
    sandbox: rec.meta.sandbox as SandboxMode | undefined,
    personality: rec.meta.personality as Personality | undefined,
    effort: rec.meta.effort as EffortLevel | undefined,
    summary: rec.meta.summary as SummaryMode | undefined,
    config: isRecord(rec.meta.config) ? rec.meta.config : undefined,
    baseInstructions: normalizeOptionalString(rec.meta.baseInstructions),
    developerInstructions: normalizeOptionalString(rec.meta.developerInstructions),
    approvalTimeoutMs:
      typeof rec.meta.approvalTimeoutMs === "number" ? rec.meta.approvalTimeoutMs : undefined,
    pendingRequests: new Map(),
    lastResult: result,
    lastAgentMessageText: recoveredAgentMessageText(result),
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

/** The answer a recovered turn left, read from whichever field its result carries it in. */
function recoveredAgentMessageText(result: TurnResult | undefined): string | undefined {
  if (typeof result?.text === "string") return result.text;
  if (typeof result?.output === "string") return result.output;
  return undefined;
}

/** How a listing names the server holding a session, or nothing when none does. */
function ownershipOf(owner: OwnerState): SessionOwnership | undefined {
  if (owner.kind === "self") return { pid: owner.owner.pid, state: "self" };
  if (owner.kind === "held") return { pid: owner.owner.pid, state: "other" };
  return undefined;
}

/** A session this server does not hold, as a listing reports it. */
function publicInfoOfRecovered(rec: RecoveredSession): PublicSessionInfo {
  return {
    sessionId: rec.sessionId,
    status: statusOfRecovered(rec),
    createdAt: normalizeOptionalString(rec.meta.createdAt) ?? "",
    lastActiveAt: normalizeOptionalString(rec.meta.lastActiveAt) ?? "",
    cancelledAt: normalizeOptionalString(rec.meta.cancelledAt),
    cancelledReason: normalizeOptionalString(rec.meta.cancelledReason),
    model: normalizeOptionalString(rec.meta.model),
    approvalPolicy: rec.meta.approvalPolicy as ApprovalPolicy | undefined,
    sandbox: rec.meta.sandbox as SandboxMode | undefined,
    pendingRequestCount: 0,
    activity: rec.lastActivity,
    owner: ownershipOf(rec.owner),
  };
}

/**
 * Whether a session last active at `lastActiveAt` has been still for `olderThanMs`.
 *
 * A caller that names no age wants every session of the named statuses, and a
 * `lastActiveAt` no clock can read dates the session nowhere, so it is left alone.
 */
function isOlderThan(lastActiveAt: string, olderThanMs: number | undefined, now: number): boolean {
  if (typeof olderThanMs !== "number" || olderThanMs <= 0) return true;
  const lastActive = new Date(lastActiveAt).getTime();
  if (!Number.isFinite(lastActive)) return false;
  return now - lastActive >= olderThanMs;
}

/** Names the sessions whose directory removal was asked for and failed. */
function stillOnDiskMessage(diskFailures: string[]): string {
  return (
    `${diskFailures.length} session director${diskFailures.length === 1 ? "y is" : "ies are"} ` +
    `still on disk: ${diskFailures.join(", ")}`
  );
}

/** Why cleanup cancels a session of this status and age, or nothing while it has time left. */
function expiryReasonForAge(status: SessionStatus, age: number): string | undefined {
  if (status === "idle" && age > DEFAULT_IDLE_CLEANUP_MS) return "Idle timeout";
  if (status === "waiting_approval" && age > DEFAULT_RUNNING_CLEANUP_MS) return "Approval timeout";
  if (status === "running" && age > DEFAULT_RUNNING_CLEANUP_MS) return "Running timeout";
  return undefined;
}

/** A finished session that has stood longer than a finished session is kept. */
function isRetentionExpired(status: SessionStatus, age: number): boolean {
  return (status === "cancelled" || status === "error") && age > DEFAULT_TERMINAL_CLEANUP_MS;
}

/** How long a session of this status lives without activity, or nothing when it does not expire. */
function ttlForStatus(status: SessionStatus): number | undefined {
  if (status === "idle") return DEFAULT_IDLE_CLEANUP_MS;
  if (status === "running" || status === "waiting_approval") return DEFAULT_RUNNING_CLEANUP_MS;
  return undefined;
}

function pollIntervalForStatus(status: SessionStatus): number | undefined {
  if (status === "waiting_approval") return WAITING_APPROVAL_POLL_INTERVAL;
  if (status === "running") return DEFAULT_POLL_INTERVAL;
  return undefined; // terminal states don't need polling
}

function buildProgressInfo(session: SessionInfo): ProgressInfo {
  return {
    phase: deriveProgressPhase(session),
    lastEventAt: session.progressState?.lastEventAt ?? session.lastActiveAt,
    activeTurnId: session.activeTurnId,
    pendingActionCount: countPendingRequests(session),
    // Every counter the wire carries is merged into progressState as it arrives —
    // by `thread/tokenUsage/updated`, by the exec turn's `usage`, and by the
    // restore path. Re-reading the finished turn here would let those older
    // counters win over a later update.
    tokens: session.progressState?.tokens,
    activity: session.progressState?.activity,
    activitySince: session.progressState?.activityAt,
    activityStandingMs: standingMs(session.progressState?.activityAt),
  };
}

/** How long ago an ISO instant was, or undefined when there is none to measure. */
function standingMs(since: string | undefined): number | undefined {
  if (since === undefined) return undefined;
  const at = Date.parse(since);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, Date.now() - at);
}

/**
 * Session status a `thread/status/changed` notification asks for, or undefined
 * when the notification carries nothing the manager should act on.
 *
 * The pending request map decides `waiting_approval`, never the notification:
 * the status change and the approval request that goes with it are two separate
 * messages, so either one can arrive first. A wait announced while the manager
 * holds no request would park the session on an action no caller can answer,
 * and an `idle` arriving while a request is still open would hide that action.
 * Codex owns the `idle` and `systemError` edges the turn lifecycle cannot see;
 * `active` never pulls a finished session back into `running`.
 */
function sessionStatusForThreadStatus(
  session: SessionInfo,
  statusType: string | undefined
): SessionStatus | undefined {
  if (session.status === "cancelled" || session.status === "error") return undefined;
  const waitingOnCaller = countPendingRequests(session) > 0;
  switch (statusType) {
    case "active":
      return waitingOnCaller ? "waiting_approval" : undefined;
    case "idle":
      return waitingOnCaller ? undefined : "idle";
    case "systemError":
      return "error";
    default:
      // "notLoaded" and whatever a newer codex adds: no session-side meaning.
      return undefined;
  }
}

function countPendingRequests(session: SessionInfo): number {
  let count = 0;
  for (const req of session.pendingRequests.values()) {
    if (!req.resolved) count++;
  }
  return count;
}

function deriveProgressPhase(session: SessionInfo): ProgressPhase {
  if (session.status === "waiting_approval") return "waiting_approval";
  if (session.status === "cancelled") return "cancelled";
  if (session.status === "error") return "error";
  if (session.status === "idle") return "finished";
  if (!session.activeTurnId) return "starting";

  const lastMethod = session.progressState?.lastMethod;
  if (typeof lastMethod === "string") {
    if (REASONING_PROGRESS_METHODS.has(lastMethod)) return "reasoning";
    if (ACTING_PROGRESS_METHODS.has(lastMethod)) return "acting";
  }
  return "running";
}

function recordProgressObservation(
  session: SessionInfo,
  method: string,
  params: Record<string, unknown>
): void {
  const next = session.progressState ?? { lastEventAt: new Date().toISOString() };
  next.lastEventAt = new Date().toISOString();
  if (method !== Methods.THREAD_TOKEN_USAGE_UPDATED) {
    next.lastMethod = method;
  }
  mergeProgressTokens(session, extractTokens(params));
  session.progressState = next;
}

function mergeProgressTokens(session: SessionInfo, tokens?: ProgressTokens): void {
  if (!tokens) return;
  const next = session.progressState ?? { lastEventAt: new Date().toISOString() };
  next.tokens = mergeTokens(next.tokens, tokens);
  session.progressState = next;
}

function mergeTokens(base?: ProgressTokens, extra?: ProgressTokens): ProgressTokens | undefined {
  if (!base && !extra) return undefined;
  return {
    input: extra?.input ?? base?.input,
    output: extra?.output ?? base?.output,
    total: extra?.total ?? base?.total,
  };
}

/**
 * Structured output of a finished turn: its final assistant message read as JSON.
 *
 * `turn/start` takes an `outputSchema` that constrains the final assistant
 * message (codex-schema/v2/TurnStartParams.json) and the protocol returns the
 * constrained value in no field of its own — the message text is it. Text that
 * is not a JSON object or array yields nothing.
 */
function parseStructuredOutput(text?: string): unknown {
  if (typeof text !== "string") return undefined;
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * The record that carries the token counters.
 *
 * `thread/tokenUsage/updated` nests them under `tokenUsage.total` and
 * `tokenUsage.last` (codex-schema/v2/ThreadTokenUsageUpdatedNotification.json);
 * the exec `token_count` event nests them under `info.total_token_usage` and
 * `info.last_token_usage` (codex-schema/EventMsg.json, TokenCountEventMsg).
 * Cumulative counts win over the last turn's. Other payloads keep the counters
 * in `usage` or in the record itself.
 */
function tokenCounterSource(value: Record<string, unknown>): Record<string, unknown> {
  const tokenUsage = isRecord(value.tokenUsage) ? value.tokenUsage : undefined;
  if (tokenUsage) {
    const nested = pickRecord(tokenUsage, ["total", "last"]);
    if (nested) return nested;
  }
  const info = isRecord(value.info) ? value.info : undefined;
  if (info) {
    const nested = pickRecord(info, ["total_token_usage", "last_token_usage"]);
    if (nested) return nested;
  }
  return isRecord(value.usage) ? value.usage : value;
}

function pickRecord(
  source: Record<string, unknown>,
  keys: string[]
): Record<string, unknown> | undefined {
  for (const key of keys) {
    const value = source[key];
    if (isRecord(value)) return value;
  }
  return undefined;
}

function extractTokens(value: unknown): ProgressTokens | undefined {
  if (!isRecord(value)) return undefined;

  const source = tokenCounterSource(value);
  const input = pickNumber(source, [
    "inputTokens",
    "input_tokens",
    "promptTokens",
    "prompt_tokens",
  ]);
  const output = pickNumber(source, [
    "outputTokens",
    "output_tokens",
    "completionTokens",
    "completion_tokens",
  ]);
  const total = pickNumber(source, [
    "totalTokens",
    "total_tokens",
    "tokenCount",
    "token_count",
    "total",
  ]);

  if (typeof input !== "number" && typeof output !== "number" && typeof total !== "number") {
    return undefined;
  }

  return { input, output, total };
}

function pickNumber(source: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

/** The answer that closes an unanswered request of a session that is going away. */
function respondCancelled(req: PendingRequest): void {
  if (!req.respond) return;
  if (req.kind === "command") req.respond({ decision: "cancel" });
  else if (req.kind === "fileChange") req.respond({ decision: "cancel" });
  else if (req.kind === "user_input") req.respond({ answers: {} });
}

function clearSessionPendingRequests(session: SessionInfo): void {
  const entries = Array.from(session.pendingRequests.entries());
  session.pendingRequests.clear();
  for (const [, req] of entries) {
    if (req.timeoutHandle) clearTimeout(req.timeoutHandle);
    // Best-effort: send cancel response so the backend isn't left waiting.
    if (!req.resolved && req.respond) {
      try {
        respondCancelled(req);
      } catch {
        // Client already exited — response delivery is best-effort
      }
    }
    req.resolved = true;
  }
}

function setTerminalErrorResult(session: SessionInfo, message: string): void {
  const completedAt = new Date().toISOString();
  const failedTurnId = session.activeTurnId ?? "";
  session.activeTurnId = undefined;
  session.lastResult = {
    turnId: failedTurnId,
    outcome: "error",
    status: "error",
    error: message,
    completedAt,
  };
  recordEvent(session, "result", {
    status: "error",
    turnId: failedTurnId,
    error: message,
    completedAt,
  });
}

function createUnrefTimeout(handler: () => void, timeoutMs: number): ReturnType<typeof setTimeout> {
  const timer = setTimeout(handler, timeoutMs);
  if (typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as { unref: () => void }).unref();
  }
  return timer;
}

function respondToTerminalSessionRequest(
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

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Answer a server-initiated request, reporting a delivery that failed.
 *
 * The client throws when it cannot write the response. Letting that escape the request
 * handler would skip the long-poll wake-up at the end of it, so a caller waiting on this
 * session would sit until its own deadline instead of hearing about the turn.
 */
function respondOrReport(sessionId: string, method: string, send: () => void): void {
  try {
    send();
  } catch (err) {
    console.error(
      `[codex-mcp] Failed to answer a server request: session=${sessionId} method=${method} ` +
        `error=${describeError(err)}`
    );
  }
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
/**
 * The answers to keep in events.jsonl.
 *
 * A question marked `isSecret` is answered with something that must not be
 * written down — a token, a password (codex-schema/ToolRequestUserInputParams.json
 * → ToolRequestUserInputQuestion.isSecret). Codex still receives the answer as
 * given; the log keeps only the fact that the question was answered.
 */
function loggableAnswers(
  params: unknown,
  answers: Record<string, { answers: string[] }>
): Record<string, { answers: string[] }> {
  const questions = isRecord(params) && Array.isArray(params.questions) ? params.questions : [];
  const secretIds = new Set<string>();
  for (const question of questions) {
    if (isRecord(question) && question.isSecret === true && typeof question.id === "string") {
      secretIds.add(question.id);
    }
  }
  if (secretIds.size === 0) return answers;

  const loggable: Record<string, { answers: string[] }> = {};
  for (const [id, value] of Object.entries(answers)) {
    loggable[id] = secretIds.has(id)
      ? { answers: (value?.answers ?? []).map(() => "<secret>") }
      : value;
  }
  return loggable;
}

function correlationIds(
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
function commandApprovalFields(approvalParams: CommandApprovalParams & Record<string, unknown>): {
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

function sendPendingRequestResponseOrThrow(
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

type EventSink = (type: SessionEventType, data: unknown, timestamp: string) => void;

/** Disk mirror per session; a dropped session takes its sink with it. */
const eventSinks = new WeakMap<SessionInfo, EventSink>();

/** Marker scanner per session; a dropped session takes its carry buffer with it. */
const activityScanners = new WeakMap<SessionInfo, ActivityMarkerScanner>();

/**
 * Who to tell when a session says what it is doing now.
 *
 * A caller holding a tool call open on this session subscribes here, so the line
 * reaches the client as a notification the moment it arrives — before the poll
 * that the same line ends returns it.
 */
const activityListeners = new WeakMap<SessionInfo, Set<(activity: string) => void>>();

function scannerOf(session: SessionInfo): ActivityMarkerScanner {
  let scanner = activityScanners.get(session);
  if (!scanner) {
    scanner = new ActivityMarkerScanner();
    activityScanners.set(session, scanner);
  }
  return scanner;
}

/**
 * Record what Codex said it is doing: overwrite the one line a poll reports,
 * stamp when it arrived, and append one `activity` record to the session's
 * events.jsonl.
 *
 * The caller wakes the long-poll waiters after it — `signalOf` carries the line,
 * so a poll answers with each new heading and the person waiting reads the work
 * as it happens. One line per heading is what travels, not the turn's stream.
 */
/** What a turn may override for the session it continues. */
interface TurnOverrides {
  model?: string;
  approvalPolicy?: ApprovalPolicy;
  effort?: EffortLevel;
  summary?: SummaryMode;
  personality?: Personality;
  sandbox?: SandboxMode;
  cwd?: string;
  outputSchema?: Record<string, unknown>;
}

/** Throw unless the session is in a state a new turn can start from. */
function assertSessionAcceptsTurn(session: SessionInfo, sessionId: string): void {
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
 * after a resume — starts from it. `reaches` answers whether the client carried
 * that override to this turn at all.
 */
function applyTurnOverrides(
  session: SessionInfo,
  overrides: TurnOverrides | undefined,
  resolvedCwd: string | undefined,
  reaches: (name: string) => boolean
): void {
  if (resolvedCwd && reaches("cwd")) session.cwd = resolvedCwd;
  if (overrides?.model) session.model = overrides.model;
  if (overrides?.approvalPolicy) {
    session.approvalPolicy = overrides.approvalPolicy as ApprovalPolicy;
  }
  if (overrides?.effort) session.effort = overrides.effort;
  if (overrides?.summary) session.summary = overrides.summary;
  if (overrides?.personality) session.personality = overrides.personality;
  if (overrides?.sandbox && reaches("sandbox")) {
    session.sandbox = overrides.sandbox as SandboxMode;
  }
}

/** The `compatWarnings` sentence naming what the turn was asked for and did not apply. */
function unappliedTurnWarning(
  unapplied: readonly string[],
  requested: Record<string, string | undefined>,
  effective: Record<string, string | undefined>
): string {
  const named = unapplied.map((name) => {
    const asked = requested[name];
    const kept = effective[name];
    if (asked !== undefined && kept !== undefined) {
      return `${name} '${asked}' (the turn keeps '${kept}')`;
    }
    return asked !== undefined ? `${name} '${asked}'` : name;
  });
  return (
    `This turn did not apply ${named.join(", ")}. Start a new session to change ` +
    `${unapplied.length === 1 ? "it" : "them"}.`
  );
}

/** The cwd a reply's override asks the turn to run in, or nothing when it names none. */
function resolveTurnCwd(
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

/** The `turn/start` parameters of a reply: the overrides it names, over what the session runs with. */
function buildTurnParams(
  session: SessionInfo,
  threadId: string,
  prompt: string,
  overrides: TurnOverrides | undefined,
  resolvedCwd: string | undefined
): TurnStartParams {
  const input: UserInput[] = [{ type: "text", text: prompt }];
  const turnParams: TurnStartParams = {
    threadId,
    input,
    model: overrides?.model,
    approvalPolicy: overrides?.approvalPolicy,
    // `turn/start` carries these on every turn; the thread holds none of them, so a
    // turn that omits one takes the value from ~/.codex/config.toml rather than the
    // one the session was started with.
    effort: overrides?.effort ?? session.effort,
    summary: overrides?.summary ?? session.summary,
    personality: overrides?.personality ?? session.personality,
    cwd: resolvedCwd,
    outputSchema: overrides?.outputSchema,
  };
  // Map sandbox string to protocol object
  if (overrides?.sandbox) {
    turnParams.sandboxPolicy = toSandboxPolicy(overrides.sandbox);
  }
  return turnParams;
}

/** The id of a finished turn, reporting a `turn/completed` that named none. */
function turnIdOfCompleted(
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

/**
 * The text a finished turn carries of its own, with the activity markers gone.
 *
 * The protocol Turn carries `{error, id, items, status}` and no final
 * text (codex-schema/ServerNotification.json → definitions.Turn), so
 * app-server mode always answers from `lastAgentMessageText`. `output`
 * is ExecClient's own addition, set from the last `item.completed`
 * agentMessage of the turn (src/app-server/exec-client.ts).
 * `output` comes straight off the exec turn and has seen no stripping yet;
 * `lastAgentMessageText` was stripped when its item completed.
 */
function outputOfCompleted(turnObj: Record<string, unknown> | undefined): string | undefined {
  const sentTurnOutput = normalizeOptionalString(turnObj?.output);
  return sentTurnOutput === undefined ? undefined : stripActivityMarkers(sentTurnOutput);
}

/** `turn/started` — the notification that opens a turn and clears the last activity. */
function onTurnStarted(session: SessionInfo, method: string, p: Record<string, unknown>): void {
  const turnObj = p.turn as Record<string, unknown> | undefined;
  const status = normalizeOptionalString(turnObj?.status);
  session.activeTurnId = normalizeOptionalString(turnObj?.id);
  // The new turn has not said what it is doing yet, and the line the
  // previous one left would read as if it had.
  scannerOf(session).reset();
  if (session.progressState) {
    session.progressState.activity = undefined;
    session.progressState.activityAt = undefined;
  }
  recordEvent(session, "progress", {
    method,
    ...p,
    turnId: session.activeTurnId,
    status,
  });
}

/** `item/started`, `item/completed` and `rawResponseItem/completed`. */
function onItemNotification(
  session: SessionInfo,
  method: string,
  p: Record<string, unknown>
): void {
  const item = p.item as Record<string, unknown> | undefined;
  const itemType = item && typeof item.type === "string" ? item.type : undefined;
  const status = normalizeOptionalString(item?.status);
  // Only `item/completed` carries a ThreadItem. `rawResponseItem/completed`
  // carries a ResponseItem — `message` (text in `content[].text`),
  // `reasoning`, `function_call` and so on
  // (codex-schema/v2/RawResponseItemCompletedNotification.json → ResponseItem)
  // — a second, lower-level view of the same turn, so the final answer is
  // read from the ThreadItem stream alone.
  const completedItem = method === Methods.ITEM_COMPLETED;
  // AgentMessageThreadItem carries `id`, `text` and an optional `phase`
  // and no status (codex-schema/v2/ItemCompletedNotification.json), so
  // the notification method is what marks the message finished. `phase`
  // is not required either: providers emit it inconsistently, and the
  // last completed message of a turn is its answer.
  if (itemType === "agentMessage" && completedItem && typeof item?.text === "string") {
    // The markers were lifted out of the deltas that built this text; what
    // stays is the answer the caller reads.
    session.lastAgentMessageText = stripActivityMarkers(item.text);
    scannerOf(session).reset();
  }
  // Keep user/agent message-like items as output; everything else is
  // progress. A PlanThreadItem (`type: "plan"`, EXPERIMENTAL, reaching
  // this server now that the client asks for `experimentalApi`) states
  // what the agent means to do rather than what it answers, and it
  // stays progress like the `item/plan/delta` that builds it.
  const eventType: SessionEventType =
    itemType === "agentMessage" || itemType === "userMessage" ? "output" : "progress";
  recordEvent(session, eventType, {
    method,
    ...p,
    item: p.item,
    status,
  });
}

function recordActivity(session: SessionInfo, activity: string, itemId?: string): void {
  const next = session.progressState ?? { lastEventAt: new Date().toISOString() };
  next.activity = activity;
  next.activityAt = new Date().toISOString();
  session.progressState = next;
  recordEvent(session, "activity", { activity, turnId: session.activeTurnId, itemId });
  for (const listener of activityListeners.get(session) ?? []) {
    try {
      listener(activity);
    } catch (err: unknown) {
      // A listener writes to a client this server does not own. Its failure is
      // the caller's to survive, and the turn goes on either way.
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[codex-mcp] Activity listener failed for session '${session.sessionId}': ${message}`
      );
    }
  }
}

function setEventSink(session: SessionInfo, sink: EventSink): void {
  eventSinks.set(session, sink);
}

/**
 * Write one event of the turn to the session's events.jsonl.
 *
 * The log is read by whoever opens the state directory, never by `codex_check`:
 * the caller is told the state of the session, and Codex's own rollout log under
 * `~/.codex/sessions/` holds the transcript.
 */
function recordEvent(session: SessionInfo, type: SessionEventType, data: unknown): void {
  eventSinks.get(session)?.(type, data, new Date().toISOString());
}

const TERMINAL_SESSION_STATUSES = new Set<SessionStatus>(["idle", "error", "cancelled"]);

/**
 * The session state a long-poll caller acts on, as one string: status, open
 * actions and the finished turn's result.
 */
/**
 * The thread said idle before the turn it was running was recorded.
 *
 * `thread/status/changed` arrives one notification ahead of `turn/completed` —
 * measured on codex app-server 0.149.1, `events.jsonl` seq 71 then 72 — and the
 * result is written by the second of them. A poll answered in between hands the
 * caller a terminal status with no `result`, which reads as a turn that finished
 * and said nothing. `TURN_COMPLETED` clears `activeTurnId`, so an active one
 * under an idle status is exactly that gap.
 */
function awaitsTurnRecord(session: SessionInfo): boolean {
  return session.status === "idle" && session.activeTurnId !== undefined;
}

function signalOf(session: SessionInfo): string {
  const openRequests = Array.from(session.pendingRequests.values())
    .filter((req) => !req.resolved)
    .map((req) => req.requestId)
    .sort()
    .join(",");
  return [
    // The status a waiter is woken by, which is the one the turn's record backs.
    awaitsTurnRecord(session) ? "running" : session.status,
    openRequests,
    session.lastResult?.completedAt ?? "",
    session.progressState?.activityAt ?? "",
  ].join("|");
}

function toPublicInfo(session: SessionInfo, owner?: SessionOwnership): PublicSessionInfo {
  return {
    sessionId: session.sessionId,
    status: session.status,
    createdAt: session.createdAt,
    lastActiveAt: session.lastActiveAt,
    cancelledAt: session.cancelledAt,
    cancelledReason: session.cancelledReason,
    model: session.model,
    approvalPolicy: session.approvalPolicy,
    sandbox: session.sandbox,
    pendingRequestCount: Array.from(session.pendingRequests.values()).filter((r) => !r.resolved)
      .length,
    activity: session.progressState?.activity,
    lastTurn: lastTurnInfo(session),
    owner,
  };
}

/**
 * What the session's last turn came to, read off the result the session kept.
 *
 * A cancel that follows a finished turn keeps that result (`performCancelSession`),
 * so this survives closing the session while `status` does not.
 */
function lastTurnInfo(session: SessionInfo): LastTurnInfo | undefined {
  const result = session.lastResult;
  if (!result) return undefined;
  return {
    turnId: result.turnId,
    outcome: result.outcome,
    status: result.status,
    completedAt: result.completedAt,
    error: result.error,
  };
}

function toSensitiveInfo(session: SessionInfo, owner?: SessionOwnership): SensitiveSessionInfo {
  return {
    ...toPublicInfo(session, owner),
    threadId: session.threadId,
    cwd: session.cwd,
    profile: session.profile,
    config: session.config,
  };
}

/** What a caller may send alongside an approval decision. */
interface ApprovalExtra {
  execpolicy_amendment?: string[];
  network_policy_amendment?: NetworkPolicyAmendment;
  denyMessage?: string;
}

/** Throw unless `decision` and `extra` are an answer this pending request accepts. */
function assertApprovalDecision(
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
function buildApprovalResponse(
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseAvailableDecisionSet(available: unknown[] | null | undefined): Set<string> | null {
  if (!Array.isArray(available) || available.length === 0) return null;
  const set = new Set<string>();
  for (const entry of available) {
    if (typeof entry === "string") {
      set.add(entry);
      continue;
    }
    if (isRecord(entry)) {
      if ("acceptWithExecpolicyAmendment" in entry) set.add("acceptWithExecpolicyAmendment");
      if ("applyNetworkPolicyAmendment" in entry) set.add("applyNetworkPolicyAmendment");
    }
  }
  return set.size > 0 ? set : null;
}

/**
 * Read the thread id of a `thread/start` or `thread/fork` response.
 *
 * Both answer `{thread: Thread}` (codex-schema/v2/ThreadStartResponse.json,
 * v2/ThreadForkResponse.json), and so does ExecClient. No response of the bundle
 * puts a thread id anywhere else, so a differently shaped answer is a backend
 * this server cannot drive: the session needs the id, so it throws rather than
 * carrying on with an id it made up.
 */
function extractThreadId(result: unknown): string {
  if (!isRecord(result)) {
    throw new Error(`Error [${ErrorCode.INTERNAL}]: Invalid thread response: expected object`);
  }

  const thread = result.thread;
  if (isRecord(thread) && typeof thread.id === "string" && thread.id.length > 0) return thread.id;

  throw new Error(`Error [${ErrorCode.INTERNAL}]: Invalid thread response: missing thread id`);
}

/**
 * Read the turn id of a `turn/start` response, which answers `{turn: Turn}`
 * (codex-schema/v2/TurnStartResponse.json).
 *
 * Optional: the id is a seed for `activeTurnId` and the `turn/started`
 * notification is what settles it. The one response of the bundle carrying a
 * bare `turnId` answers `turn/steer`, which this server never sends.
 */
function extractTurnId(result: unknown): string | undefined {
  if (!isRecord(result)) return undefined;

  const turn = result.turn;
  if (isRecord(turn) && typeof turn.id === "string" && turn.id.length > 0) return turn.id;

  return undefined;
}
