/**
 * AppServerClient — JSON-RPC client for codex app-server subprocess.
 *
 * Manages a single codex app-server child process via stdio.
 * Handles request/response correlation, notifications, and server-initiated requests.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import type { Writable } from "node:stream";
import { ErrorCode } from "../types.js";
import { getDefaultCodexExecutable } from "../utils/codex-executable.js";
import { awaitChildExit } from "./child-shutdown.js";
import { LineReader, readChildOutput } from "./child-stdio.js";
import type { ICodexClient } from "./client-interface.js";
import { resolveCodexInvocation } from "./codex-bin.js";
import { type AppServerSpawnOptions, buildAppServerArgs } from "./lifecycle.js";
import {
  type InitializeParams,
  type InitializeResult,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  Methods,
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
} from "./protocol.js";

declare const __PKG_VERSION__: string;
const CLIENT_VERSION = typeof __PKG_VERSION__ !== "undefined" ? __PKG_VERSION__ : "0.0.0-dev";

const DEFAULT_REQUEST_TIMEOUT = 30_000;
const STARTUP_REQUEST_TIMEOUT = 90_000;
const MAX_WRITE_QUEUE_BYTES = 5 * 1024 * 1024; // 5MB

interface PendingRpcRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

type NotificationHandler = (method: string, params: unknown) => void;
type ServerRequestHandler = (id: RequestId, method: string, params: unknown) => void;

export class AppServerClient extends EventEmitter implements ICodexClient {
  private process: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<RequestId, PendingRpcRequest>();
  private lines = new LineReader();
  private _destroyed = false;
  private lastFailure: Error | null = null;
  private backpressure = false;
  private writeQueue: string[] = [];
  private queuedBytes = 0;
  private spawnedViaCmd = false;
  private spawnedDetached = false;

  private notificationHandler: NotificationHandler | null = null;
  private serverRequestHandler: ServerRequestHandler | null = null;

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

    readChildOutput(proc, (chunk) => this.onData(chunk), "[app-server stderr]");
    proc.stdin?.on("drain", () => this.flushWriteQueue());
    proc.stdin?.on("error", (err) => {
      this.lastFailure = err instanceof Error ? err : new Error(String(err));
      this.failAllPending(this.lastFailure);
    });
    proc.stdin?.on("close", () => {
      this.lastFailure ??= new Error("app-server stdin closed");
      this.failAllPending(this.lastFailure);
    });
    proc.on("exit", (code, signal) => {
      this.lastFailure ??= new Error(
        `app-server exited (code: ${code}, signal: ${signal ?? "null"})`
      );
      this.failAllPending(this.lastFailure);
      if (!this._destroyed) {
        this.emit("exit", code, signal);
      }
    });
    proc.on("error", (err) => {
      this.lastFailure = err instanceof Error ? err : new Error(String(err));
      this.failAllPending(this.lastFailure);
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
    this.notificationHandler = handler;
  }

  /**
   * Register handler for server-initiated requests (approvals, user input, etc.).
   */
  onServerRequest(handler: ServerRequestHandler): void {
    this.serverRequestHandler = handler;
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

  async turnStart(
    params: TurnStartParams,
    timeout = STARTUP_REQUEST_TIMEOUT
  ): Promise<TurnStartResult> {
    return this.request<TurnStartResult>(Methods.TURN_START, params, timeout);
  }

  async turnInterrupt(params: TurnInterruptParams): Promise<void> {
    await this.request<void>(Methods.TURN_INTERRUPT, params);
  }

  // ── Low-level JSON-RPC ─────────────────────────────────────────

  private request<T>(
    method: string,
    params?: unknown,
    timeout = DEFAULT_REQUEST_TIMEOUT
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this._destroyed) {
        reject(new Error("Client destroyed"));
        return;
      }
      if (!this.process?.stdin?.writable) {
        reject(this.lastFailure ?? new Error("app-server is not running (stdin not writable)"));
        return;
      }

      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request ${method} timed out after ${timeout}ms`));
      }, timeout);
      if (timer.unref) timer.unref();

      this.pending.set(id, {
        resolve: resolve as (result: unknown) => void,
        reject,
        timer,
      });

      try {
        this.send({ jsonrpc: "2.0", id, method, params } as JsonRpcRequest);
      } catch (err) {
        const pending = this.pending.get(id);
        if (pending) {
          this.pending.delete(id);
          clearTimeout(pending.timer);
        }
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private send(msg: JsonRpcMessage): void {
    if (!this.process?.stdin) throw new Error("app-server process not started");
    if (!this.process.stdin.writable) throw new Error("app-server stdin not writable");
    const payload = `${JSON.stringify(msg)}\n`;
    this.enqueueWrite(payload);
  }

  private onData(chunk: Buffer): void {
    for (const trimmed of this.lines.take(chunk)) {
      // Fast path: app-server should emit JSON per line; ignore any non-JSON noise safely.
      if (trimmed[0] !== "{" && trimmed[0] !== "[") {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed) as unknown;
      } catch {
        this.reportParseFailure(trimmed);
        continue;
      }

      // Dispatch outside the parse guard: a throwing handler is not a parse
      // error and must not be reported or acted on as one.
      this.dispatchParsed(parsed);
    }
  }

  /** Fail the pending requests of a stream this client can no longer follow, and stop it. */
  private reportParseFailure(trimmed: string): void {
    const error = new Error(
      `Error [${ErrorCode.PROTOCOL_PARSE_ERROR}]: app-server protocol error: failed to parse JSON line: ${trimmed.slice(0, 200)}`
    );
    console.error(`[app-server] ${error.message}`);
    this.lastFailure ??= error;
    this.failAllPending(error);
    this.terminateOrLog("protocol parse error");
  }

  private dispatchParsed(parsed: unknown): void {
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (item && typeof item === "object") {
          this.handleMessage(item as JsonRpcMessage);
        }
      }
    } else if (parsed && typeof parsed === "object") {
      this.handleMessage(parsed as JsonRpcMessage);
    }
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

  private enqueueWrite(payload: string): void {
    const stdin = this.process?.stdin;
    if (!stdin?.writable) throw new Error("app-server stdin not writable");

    if (this.backpressure || this.writeQueue.length > 0) {
      this.queueWrite(payload);
      return;
    }

    try {
      this.writeToStdin(stdin, payload);
    } catch (err) {
      throw this.recordWriteFailure(err);
    }
  }

  /** Hold a payload until stdin drains, up to the queue limit. */
  private queueWrite(payload: string): void {
    if (this.queuedBytes + payload.length > MAX_WRITE_QUEUE_BYTES) {
      const error = new Error(
        `Error [${ErrorCode.WRITE_QUEUE_DROPPED}]: app-server stdin backpressure: write queue exceeded limit`
      );
      this.lastFailure = error;
      this.failAllPending(error);
      this.writeQueue = [];
      this.queuedBytes = 0;
      this.terminateOrLog("write queue overflow");
      throw error;
    }
    this.writeQueue.push(payload);
    this.queuedBytes += payload.length;
  }

  private writeToStdin(stdin: Writable, payload: string): void {
    const ok = stdin.write(payload);
    if (!ok) this.backpressure = true;
  }

  /** Carry a refused write to every pending request, and hand the error back to the caller. */
  private recordWriteFailure(err: unknown): Error {
    const error = err instanceof Error ? err : new Error(String(err));
    this.lastFailure = error;
    this.failAllPending(error);
    return error;
  }

  private flushWriteQueue(): void {
    const stdin = this.process?.stdin;
    if (!stdin?.writable) {
      const dropped = this.dropQueuedWrites("stdin is not writable while flushing");
      if (dropped) {
        this.terminateOrLog("dropping queued writes");
      }
      return;
    }
    this.backpressure = false;
    while (!this.backpressure) {
      const next = this.writeQueue.shift();
      if (next === undefined) break;
      this.queuedBytes -= next.length;
      try {
        this.writeToStdin(stdin, next);
      } catch (err) {
        this.recordWriteFailure(err);
        this.writeQueue = [];
        this.queuedBytes = 0;
        return;
      }
    }
  }

  private dropQueuedWrites(reason: string): boolean {
    if (this.writeQueue.length === 0) return false;
    const error = new Error(`Error [${ErrorCode.WRITE_QUEUE_DROPPED}]: ${reason}`);
    console.error(
      `[app-server] Dropping ${this.writeQueue.length} queued writes (${this.queuedBytes} bytes): ${reason}`
    );
    this.lastFailure = error;
    this.failAllPending(error);
    this.writeQueue = [];
    this.queuedBytes = 0;
    return true;
  }

  private handleMessage(msg: JsonRpcMessage): void {
    // Response to our request
    if ("id" in msg && ("result" in msg || "error" in msg)) {
      this.settlePending(msg as JsonRpcResponse);
      return;
    }

    // Server-initiated request (has id + method, no result/error)
    if ("id" in msg && "method" in msg) {
      this.dispatchServerRequest(msg as JsonRpcRequest);
      return;
    }

    // Notification (no id)
    if ("method" in msg && !("id" in msg)) {
      this.dispatchNotification(msg as JsonRpcNotification);
      return;
    }
  }

  private settlePending(resp: JsonRpcResponse): void {
    const pending = this.pending.get(resp.id);
    if (pending) {
      this.pending.delete(resp.id);
      clearTimeout(pending.timer);
      if (resp.error) {
        pending.reject(new Error(`RPC error ${resp.error.code}: ${resp.error.message}`));
      } else {
        pending.resolve(resp.result);
      }
    }
  }

  private dispatchServerRequest(req: JsonRpcRequest): void {
    const handler = this.serverRequestHandler;
    if (handler) {
      this.runHandler(() => handler(req.id, req.method, req.params), req.method);
    } else {
      // No handler — respond with error to avoid hanging
      this.runHandler(
        () => this.respondErrorToServer(req.id, -32601, `Method not handled: ${req.method}`),
        req.method
      );
    }
  }

  private dispatchNotification(notif: JsonRpcNotification): void {
    const handler = this.notificationHandler;
    if (handler) {
      this.runHandler(() => handler(notif.method, notif.params), notif.method);
    }
  }

  /**
   * Run a message handler, keeping its failure out of the stdout reader: an
   * exception thrown here would otherwise abort the loop over the remaining
   * lines of the same chunk.
   */
  private runHandler(fn: () => void, method: string): void {
    try {
      fn();
    } catch (err) {
      console.error(
        `[app-server] Handler for ${method} threw: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private failAllPending(error: Error): void {
    if (this.pending.size === 0) return;
    const entries = Array.from(this.pending.entries());
    this.pending.clear();
    for (const [, pending] of entries) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  /**
   * Gracefully destroy the client and kill the subprocess.
   */
  async destroy(): Promise<void> {
    if (this._destroyed) return;
    this._destroyed = true;

    // Reject all pending requests
    this.failAllPending(new Error("Client destroyed"));

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
