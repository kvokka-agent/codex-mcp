/**
 * ICodexClient — abstract interface for codex client implementations.
 *
 * Both AppServerClient (JSON-RPC over stdio) and ExecClient (codex exec --json)
 * implement this interface, allowing SessionManager to work with either backend.
 */
import type { AppServerSpawnOptions } from "./lifecycle.js";
import type {
  RequestId,
  InitializeResult,
  ThreadStartParams,
  ThreadStartResult,
  ThreadForkParams,
  ThreadForkResult,
  ThreadResumeParams,
  ThreadResumeResult,
  ThreadBackgroundTerminalsCleanParams,
  TurnStartParams,
  TurnStartResult,
  TurnInterruptParams,
} from "./protocol.js";

export interface ICodexClient {
  readonly destroyed: boolean;

  /**
   * Whether the client supports cwd/sandbox/profile overrides on subsequent turns.
   * AppServerClient: always true (app-server supports per-turn overrides).
   * ExecClient: false after the first turn (exec resume does not support -s/-p/-C).
   */
  readonly supportsTurnOverrides: boolean;

  /** PID of the spawned codex process, undefined before start or after exit. */
  readonly childPid: number | undefined;

  /**
   * Names of the overrides the last started turn asked for and the backend did
   * not apply (for example "sandbox" when `codex exec resume` takes no `-s`).
   * Empty when every requested override reached the backend. Read it after
   * `turnStart` resolves to report what did not take effect.
   */
  readonly unappliedTurnOverrides?: readonly string[];

  /** Initialize the client (spawn subprocess / prepare resources). */
  start(opts: AppServerSpawnOptions): Promise<InitializeResult>;

  /** Create a new conversation thread. */
  threadStart(params: ThreadStartParams, timeout?: number): Promise<ThreadStartResult>;

  /** Fork an existing thread. */
  threadFork(params: ThreadForkParams): Promise<ThreadForkResult>;

  /** Resume a previously forked/saved thread. */
  threadResume(params: ThreadResumeParams): Promise<ThreadResumeResult>;

  /**
   * Clean background terminals for a thread.
   *
   * ExecClient rejects with EXEC_NOT_SUPPORTED: `codex exec` owns no background
   * terminals to clean.
   */
  threadBackgroundTerminalsClean(
    params: ThreadBackgroundTerminalsCleanParams
  ): Promise<Record<string, never>>;

  /** Start a new agent turn within a thread. */
  turnStart(params: TurnStartParams, timeout?: number): Promise<TurnStartResult>;

  /** Interrupt a running turn. */
  turnInterrupt(params: TurnInterruptParams): Promise<void>;

  /** Register handler for server notifications. */
  onNotification(handler: (method: string, params: unknown) => void): void;

  /** Register handler for server-initiated requests (approvals, user input, etc.). */
  onServerRequest(handler: (id: RequestId, method: string, params: unknown) => void): void;

  /**
   * Send a JSON-RPC response to a server-initiated request.
   *
   * Throws when the response was not handed to the backend, so a caller that
   * resolved an approval can undo that instead of reporting a decision codex
   * never received. ExecClient throws unconditionally: it raises no server
   * requests, so it has nothing to respond to.
   */
  respondToServer(id: RequestId, result: unknown): void;

  /** Send a JSON-RPC error response to a server-initiated request. Throws like `respondToServer`. */
  respondErrorToServer(id: RequestId, code: number, message: string): void;

  /** Gracefully destroy the client and release resources. */
  destroy(): Promise<void>;

  /** EventEmitter subset used by SessionManager. */
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  /**
   * A codex process was spawned: its pid and the ISO instant of the spawn.
   *
   * AppServerClient emits once per `start()`; ExecClient emits once per turn,
   * since `codex exec` runs a fresh process for every turn.
   */
  on(event: "spawn", listener: (pid: number, spawnedAt: string) => void): this;
}
