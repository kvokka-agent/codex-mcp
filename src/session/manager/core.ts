/**
 * The state every module of the manager shares, and the shapes its calls carry.
 */
import type { ICodexClient } from "../../app-server/client-interface.js";
import type {
  ApprovalPolicy,
  ApprovalsReviewer,
  EffortLevel,
  NetworkPolicyAmendment,
  Personality,
  SandboxMode,
  SessionEventType,
  SessionInfo,
  SummaryMode,
} from "../../types/index.js";
import type { SessionPersistence } from "../persistence.js";

/**
 * The one owner of everything a session outlives a call by. Every behaviour of
 * the manager is a free function over it, so no module knows another's fields.
 */
export class SessionRuntime {
  readonly sessions = new Map<string, SessionInfo>();
  readonly clients = new Map<string, ICodexClient>();
  readonly cancellationInFlight = new Map<string, Promise<void>>();
  readonly createClient: () => ICodexClient;
  /** Optional disk persistence adapter. */
  readonly persistence: SessionPersistence | null;
  /** Fingerprint of the metadata last written per session, to skip a write that changes nothing. */
  readonly lastPersistedMeta = new Map<string, string>();
  /** Sessions for which a TTL warning event has already been emitted this cycle. */
  readonly ttlWarningEmitted = new Set<string>();
  /** Sessions whose event persistence already reported a failure — keeps stderr to one line. */
  readonly eventPersistFailed = new Set<string>();
  /** Persistence failures already reported, keyed `${operation}\0${sessionId}`. */
  readonly persistFailureReported = new Set<string>();
  /** Sessions whose running turn was started with an `outputSchema`. */
  readonly schemaConstrainedTurns = new Set<string>();
  /** Long-poll notifiers: set of resolve callbacks waiting for a change in a session. */
  readonly sessionNotifiers = new Map<string, Set<() => void>>();
  /** The signal each session last woke its waiters on — see `notifyWaiters`. */
  readonly lastNotifiedSignal = new Map<string, string>();
  /** The model Codex answered a `thread/start` that named none with — see `getCodexDefaultModel`. */
  codexDefaultModel: string | null = null;

  constructor(createClient: () => ICodexClient, persistence: SessionPersistence | null) {
    this.createClient = createClient;
    this.persistence = persistence;
  }
}

export interface SessionManagerOptions {
  /** Inject client factory, so a test stands its own client in. */
  createClient?: () => ICodexClient;
  /** Disable background cleanup timer (useful for tests). */
  disableCleanup?: boolean;
  /** Disk persistence adapter (optional). */
  persistence?: SessionPersistence;
}

/** Where one session's events go on their way to disk. */
export type EventSink = (type: SessionEventType, data: unknown, timestamp: string) => void;

/** What `createSession` may be given beyond its prompt and its spawn options. */
export interface CreateSessionAdvanced {
  baseInstructions?: string;
  developerInstructions?: string;
  approvalsReviewer?: ApprovalsReviewer;
  permissions?: string;
  personality?: Personality;
  ephemeral?: boolean;
  config?: Record<string, unknown>;
  images?: string[];
  outputSchema?: Record<string, unknown>;
  summary?: SummaryMode;
  approvalTimeoutMs?: number;
}

/** What a turn may override for the session it continues. */
export interface TurnOverrides {
  model?: string;
  approvalPolicy?: ApprovalPolicy;
  approvalsReviewer?: ApprovalsReviewer;
  permissions?: string;
  effort?: EffortLevel;
  summary?: SummaryMode;
  personality?: Personality;
  sandbox?: SandboxMode;
  cwd?: string;
  outputSchema?: Record<string, unknown>;
}

/** How a pending request answers, and what it records, when its timeout fires. */
export interface PendingTimeout {
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

/** What a caller may send alongside an approval decision. */
export interface ApprovalExtra {
  execpolicy_amendment?: string[];
  network_policy_amendment?: NetworkPolicyAmendment;
  denyMessage?: string;
}
