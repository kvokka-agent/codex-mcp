/**
 * AppServerClient — JSON-RPC client for codex app-server subprocess.
 *
 * Manages a single codex app-server child process via stdio. The requests it
 * waits on, the writes stdin has not taken and the routing of what comes back
 * are each their own module; this class owns the child process, and the three
 * report their failures to it.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { getDefaultCodexExecutable } from "../../utils/codex-executable.js";
import { awaitChildExit } from "../child-shutdown.js";
import { readChildOutput } from "../child-stdio.js";
import type { ICodexClient } from "../client-interface.js";
import { resolveCodexInvocation } from "../codex-bin.js";
import { type AppServerSpawnOptions, buildAppServerArgs } from "../lifecycle.js";
import {
  type GetAccountParams,
  type GetAccountResult,
  type InitializeParams,
  type InitializeResult,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type JsonRpcResponse,
  Methods,
  type PermissionProfileListParams,
  type PermissionProfileListResult,
  type RequestId,
  type ThreadBackgroundTerminalsCleanParams,
  type ThreadBackgroundTerminalsListParams,
  type ThreadBackgroundTerminalsListResult,
  type ThreadBackgroundTerminalsTerminateParams,
  type ThreadBackgroundTerminalsTerminateResult,
  type ThreadDeleteParams,
  type ThreadForkParams,
  type ThreadForkResult,
  type ThreadResumeParams,
  type ThreadResumeResult,
  type ThreadStartParams,
  type ThreadStartResult,
  type TurnInterruptParams,
  type TurnStartParams,
  type TurnStartResult,
  type TurnSteerParams,
  type TurnSteerResult,
  type WindowsSandboxReadinessResult,
} from "../wire/index.js";
import {
  MessageRouter,
  type NotificationHandler,
  type ServerRequestHandler,
} from "./message-router.js";
import { PendingRequests } from "./pending-requests.js";
import { StdinWriteQueue } from "./write-queue.js";

declare const __PKG_VERSION__: string;
const CLIENT_VERSION = typeof __PKG_VERSION__ !== "undefined" ? __PKG_VERSION__ : "0.0.0-dev";

const DEFAULT_REQUEST_TIMEOUT = 30_000;
const STARTUP_REQUEST_TIMEOUT = 90_000;

export class AppServerClient extends EventEmitter implements ICodexClient {
  private process: ChildProcess | null;
  private _destroyed: boolean;
  private lastFailure: Error | null;
  private spawnedViaCmd: boolean;
  private spawnedDetached: boolean;

  private readonly pending: PendingRequests;
  private readonly writes: StdinWriteQueue;
  private readonly router: MessageRouter;

  // The fields are set here rather than at their declarations: bun's coverage
  // counts a field initializer as a function it never marks hit.
  constructor() {
    super();
    this.process = null;
    this._destroyed = false;
    this.lastFailure = null;
    this.spawnedViaCmd = false;
    this.spawnedDetached = false;
    this.pending = new PendingRequests();
    this.writes = new StdinWriteQueue({
      stdin: () => this.process?.stdin,
      fail: (error) => this.recordFailure(error),
      terminate: (context) => this.terminateOrLog(context),
    });
    this.router = new MessageRouter({
      response: (resp) => this.pending.settle(resp),
      refuse: (id, method) =>
        this.respondErrorToServer(id, -32601, `Method not handled: ${method}`),
      parseFailure: (error) => {
        this.lastFailure ??= error;
        this.pending.failAll(error);
        this.terminateOrLog("protocol parse error");
      },
    });
  }

  get destroyed(): boolean {
    return this._destroyed;
  }

  get childPid(): number | undefined {
    return this.process?.pid ?? undefined;
  }

  /**
   * Spawn codex app-server and perform initialization handshake.
   */
  async start(opts: AppServerSpawnOptions): Promise<InitializeResult> {
    const args = buildAppServerArgs(opts);
    const env = { ...process.env };
    const stdio: ["pipe", "pipe", "pipe"] = ["pipe", "pipe", "pipe"];

    const exe = getDefaultCodexExecutable();
    const invocation = resolveCodexInvocation(args, {
      codexCommand: exe.command,
      codexIsPath: exe.isPath,
    });
    this.spawnedViaCmd = invocation.spawnedViaCmd;
    this.spawnedDetached = process.platform !== "win32";

    const proc = spawn(invocation.cmd, invocation.args, {
      stdio,
      env,
      detached: this.spawnedDetached,
      windowsHide: process.platform === "win32",
    });
    this.process = proc;

    readChildOutput(proc, (chunk) => this.router.take(chunk), "[app-server stderr]");
    proc.stdin?.on("drain", () => this.writes.flush());
    proc.stdin?.on("error", (err) => {
      this.recordFailure(err instanceof Error ? err : new Error(String(err)));
    });
    proc.stdin?.on("close", () => {
      this.lastFailure ??= new Error("app-server stdin closed");
      this.pending.failAll(this.lastFailure);
    });
    proc.on("exit", (code, signal) => {
      this.lastFailure ??= new Error(
        `app-server exited (code: ${code}, signal: ${signal ?? "null"})`
      );
      this.pending.failAll(this.lastFailure);
      if (!this._destroyed) {
        this.emit("exit", code, signal);
      }
    });
    proc.on("error", (err) => {
      this.recordFailure(err instanceof Error ? err : new Error(String(err)));
      this.emit("error", err);
    });

    // Report the process before the handshake: the spawn instant is what the
    // orphan reaper matches a live pid against, and a handshake can take
    // longer than the tolerance it allows.
    if (proc.pid !== undefined) {
      this.emit("spawn", proc.pid, new Date().toISOString());
    }

    // Initialize handshake.
    //
    // `experimentalApi` defaults to false (codex-schema/v1/InitializeParams.json →
    // InitializeCapabilities), and off it suppresses two messages this codebase
    // serves end to end: the `item/tool/requestUserInput` server request
    // (codex-schema/ServerRequest.json) that drives the whole user-input tract,
    // and the `item/plan/delta` notification
    // (codex-schema/v2/PlanDeltaNotification.json).
    //
    // Every EXPERIMENTAL marker in the bundle sits on a whole method, a whole
    // notification, a new `ThreadItem` union variant (PlanThreadItem) or an
    // optional outgoing field, so the flag only adds messages — it rewrites no
    // field this client already reads. The one experimental field on an outgoing
    // message, `TurnStartParams.collaborationMode`, is never populated here.
    const result = await this.request<InitializeResult>(Methods.INITIALIZE, {
      clientInfo: { name: "codex-mcp", version: CLIENT_VERSION },
      capabilities: { experimentalApi: true },
    } satisfies InitializeParams);

    return result;
  }

  /**
   * Register handler for server notifications.
   */
  onNotification(handler: NotificationHandler): void {
    this.router.onNotification(handler);
  }

  /**
   * Register handler for server-initiated requests (approvals, user input, etc.).
   */
  onServerRequest(handler: ServerRequestHandler): void {
    this.router.onServerRequest(handler);
  }

  /**
   * Send a JSON-RPC response to a server-initiated request.
   *
   * Throws when the write was refused, so a caller that resolved an approval
   * learns the decision never reached codex instead of treating it as sent.
   */
  respondToServer(id: RequestId, result: unknown): void {
    this.sendServerResponse(id, { jsonrpc: "2.0", id, result } as JsonRpcResponse, "response");
  }

  /**
   * Send a JSON-RPC error response to a server-initiated request.
   *
   * Throws on a refused write, like `respondToServer`.
   */
  respondErrorToServer(id: RequestId, code: number, message: string): void {
    this.sendServerResponse(
      id,
      { jsonrpc: "2.0", id, error: { code, message } } as JsonRpcResponse,
      "error response"
    );
  }

  private sendServerResponse(id: RequestId, msg: JsonRpcResponse, kind: string): void {
    try {
      this.send(msg);
    } catch (err) {
      throw new Error(
        `Failed to send JSON-RPC ${kind} for server request id=${String(id)}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err }
      );
    }
  }

  // ── High-level protocol methods ────────────────────────────────

  async threadStart(
    params: ThreadStartParams,
    timeout = STARTUP_REQUEST_TIMEOUT
  ): Promise<ThreadStartResult> {
    return this.request<ThreadStartResult>(Methods.THREAD_START, params, timeout);
  }

  async threadFork(params: ThreadForkParams): Promise<ThreadForkResult> {
    return this.request<ThreadForkResult>(Methods.THREAD_FORK, params);
  }

  async threadResume(params: ThreadResumeParams): Promise<ThreadResumeResult> {
    return this.request<ThreadResumeResult>(Methods.THREAD_RESUME, params);
  }

  async threadBackgroundTerminalsClean(
    params: ThreadBackgroundTerminalsCleanParams
  ): Promise<Record<string, never>> {
    return this.request<Record<string, never>>(Methods.THREAD_BACKGROUND_TERMINALS_CLEAN, params);
  }

  async threadBackgroundTerminalsList(
    params: ThreadBackgroundTerminalsListParams
  ): Promise<ThreadBackgroundTerminalsListResult> {
    return this.request<ThreadBackgroundTerminalsListResult>(
      Methods.THREAD_BACKGROUND_TERMINALS_LIST,
      params
    );
  }

  async threadBackgroundTerminalsTerminate(
    params: ThreadBackgroundTerminalsTerminateParams
  ): Promise<ThreadBackgroundTerminalsTerminateResult> {
    return this.request<ThreadBackgroundTerminalsTerminateResult>(
      Methods.THREAD_BACKGROUND_TERMINALS_TERMINATE,
      params
    );
  }

  async threadDelete(params: ThreadDeleteParams): Promise<Record<string, never>> {
    return this.request<Record<string, never>>(Methods.THREAD_DELETE, params);
  }

  async permissionProfileList(
    params: PermissionProfileListParams
  ): Promise<PermissionProfileListResult> {
    return this.request<PermissionProfileListResult>(Methods.PERMISSION_PROFILE_LIST, params);
  }

  async accountRead(params: GetAccountParams = {}): Promise<GetAccountResult> {
    return this.request<GetAccountResult>(Methods.ACCOUNT_READ, params);
  }

  async windowsSandboxReadiness(): Promise<WindowsSandboxReadinessResult> {
    // The schema types this method's params as null, not as an object.
    return this.request<WindowsSandboxReadinessResult>(Methods.WINDOWS_SANDBOX_READINESS, null);
  }

  async turnStart(
    params: TurnStartParams,
    timeout = STARTUP_REQUEST_TIMEOUT
  ): Promise<TurnStartResult> {
    return this.request<TurnStartResult>(Methods.TURN_START, params, timeout);
  }

  async turnInterrupt(params: TurnInterruptParams): Promise<void> {
    await this.request<void>(Methods.TURN_INTERRUPT, params);
  }

  async turnSteer(params: TurnSteerParams): Promise<TurnSteerResult> {
    return this.request<TurnSteerResult>(Methods.TURN_STEER, params);
  }

  // ── Low-level JSON-RPC ─────────────────────────────────────────

  private request<T>(
    method: string,
    params?: unknown,
    timeout = DEFAULT_REQUEST_TIMEOUT
  ): Promise<T> {
    if (this._destroyed) return Promise.reject(new Error("Client destroyed"));
    if (!this.process?.stdin?.writable) {
      return Promise.reject(
        this.lastFailure ?? new Error("app-server is not running (stdin not writable)")
      );
    }
    return this.pending.open<T>(method, timeout, (id) => {
      this.send({ jsonrpc: "2.0", id, method, params } as JsonRpcRequest);
    });
  }

  private send(msg: JsonRpcMessage): void {
    if (!this.process?.stdin) throw new Error("app-server process not started");
    if (!this.process.stdin.writable) throw new Error("app-server stdin not writable");
    this.writes.write(`${JSON.stringify(msg)}\n`);
  }

  /** Take the failure of a connection, and reject everything waiting on it. */
  private recordFailure(error: Error): void {
    this.lastFailure = error;
    this.pending.failAll(error);
  }

  /** Terminate the subprocess, reporting a refused signal rather than raising it. */
  private terminateOrLog(context: string): void {
    try {
      this.terminate("SIGTERM");
    } catch (terminateErr) {
      console.error(
        `[app-server] Failed to terminate app-server after ${context}: ${terminateErr instanceof Error ? terminateErr.message : String(terminateErr)}`
      );
    }
  }

  /**
   * Gracefully destroy the client and kill the subprocess.
   */
  async destroy(): Promise<void> {
    if (this._destroyed) return;
    this._destroyed = true;

    // Reject all pending requests
    this.pending.failAll(new Error("Client destroyed"));

    // Kill subprocess
    const proc = this.process;
    if (proc && !proc.killed) {
      const alreadyExited = proc.exitCode !== null;
      proc.stdin?.end();
      this.terminate("SIGTERM");

      await awaitChildExit(proc, alreadyExited, () => this.forceKill());
    }

    this.process = null;
    this.removeAllListeners();
  }

  /** Kill the child that outlived its `SIGTERM`, by whatever this platform offers. */
  private forceKill(): void {
    const proc = this.process;
    if (!proc || proc.killed) return;
    if (process.platform !== "win32" || !proc.pid) {
      this.terminate("SIGKILL");
      return;
    }
    try {
      spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch (err) {
      console.error(
        `[app-server] Failed to force-kill app-server via taskkill: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private terminate(signal: NodeJS.Signals): void {
    if (!this.process) return;

    // On POSIX, kill the whole process group when detached to avoid orphan children.
    if (process.platform !== "win32" && this.spawnedDetached && this.process.pid) {
      try {
        process.kill(-this.process.pid, signal);
        return;
      } catch (err) {
        console.error(
          `[app-server] Failed to kill detached process group with ${signal}, falling back to direct kill: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    try {
      this.process.kill(signal);
    } catch (err) {
      console.error(
        `[app-server] Failed to send ${signal} to app-server process: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}
