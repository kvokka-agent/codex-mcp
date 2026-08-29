/**
 * ICodexClient — what a session's codex backend must answer.
 *
 * `AppServerClient` is the implementation the server runs on. The interface is
 * also the type of `SessionManagerOptions.createClient`, so a test stands its
 * own client in without spawning a child process.
 */
import type { AppServerSpawnOptions } from "./lifecycle.js";
import type {
  InitializeResult,
  RequestId,
  ThreadBackgroundTerminalsCleanParams,
  ThreadDeleteParams,
  ThreadForkParams,
  ThreadForkResult,
  ThreadResumeParams,
  ThreadResumeResult,
  ThreadStartParams,
  ThreadStartResult,
  TurnInterruptParams,
  TurnStartParams,
  TurnStartResult,
} from "./protocol.js";

export interface ICodexClient {
  readonly destroyed: boolean;

  /** PID of the spawned codex process, undefined before start or after exit. */
  readonly childPid: number | undefined;

  /** Initialize the client (spawn subprocess / prepare resources). */
  start(opts: AppServerSpawnOptions): Promise<InitializeResult>;

  /** Create a new conversation thread. */
  threadStart(params: ThreadStartParams, timeout?: number): Promise<ThreadStartResult>;

  /** Fork an existing thread. */
  threadFork(params: ThreadForkParams): Promise<ThreadForkResult>;

  /** Resume a previously forked/saved thread. */
  threadResume(params: ThreadResumeParams): Promise<ThreadResumeResult>;

  /** Clean background terminals for a thread. */
  threadBackgroundTerminalsClean(
    params: ThreadBackgroundTerminalsCleanParams
  ): Promise<Record<string, never>>;

  /** Delete a thread and the history Codex keeps for it. */
  threadDelete(params: ThreadDeleteParams): Promise<Record<string, never>>;

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
   * never received.
   */
  respondToServer(id: RequestId, result: unknown): void;

  /** Send a JSON-RPC error response to a server-initiated request. Throws like `respondToServer`. */
  respondErrorToServer(id: RequestId, code: number, message: string): void;

  /** Gracefully destroy the client and release resources. */
  destroy(): Promise<void>;

  /** EventEmitter subset used by SessionManager. */
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  /** A codex process was spawned: its pid and the ISO instant of the spawn. Once per `start()`. */
  on(event: "spawn", listener: (pid: number, spawnedAt: string) => void): this;
}
