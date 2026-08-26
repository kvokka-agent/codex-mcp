/**
 * ExecClient — codex exec --json based client.
 *
 * Fallback for codex variants that don't support app-server.
 * Spawns `codex exec "<prompt>" --json --skip-git-repo-check` per turn
 * and transforms JSONL stdout events into the app-server notification format
 * that SessionManager expects.
 */
import { spawn, type ChildProcess } from "child_process";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { EventEmitter } from "events";
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { join } from "path";
import { StringDecoder } from "string_decoder";
import type { ICodexClient } from "./client-interface.js";
import type { AppServerSpawnOptions } from "./lifecycle.js";
import {
  type RequestId,
  type InitializeResult,
  type ThreadStartParams,
  type ThreadStartResult,
  type ThreadForkParams,
  type ThreadForkResult,
  type ThreadResumeParams,
  type ThreadResumeResult,
  type ThreadBackgroundTerminalsCleanParams,
  type TurnStartParams,
  type TurnStartResult,
  type TurnInterruptParams,
  type SandboxPolicy,
  Methods,
} from "./protocol.js";
import { resolveCodexInvocation } from "./codex-bin.js";
import { ErrorCode } from "../types.js";
import { getDefaultCodexExecutable } from "../utils/codex-executable.js";

type NotificationHandler = (method: string, params: unknown) => void;
type ServerRequestHandler = (id: RequestId, method: string, params: unknown) => void;

const FORCE_KILL_TIMEOUT_MS = 5_000;

/**
 * Convert snake_case item type from exec JSONL to camelCase used by app-server protocol.
 */
function camelCaseItemType(snakeType: string): string {
  return snakeType.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Deep-transform item object: convert `type` field from snake_case to camelCase.
 */
function transformItem(item: Record<string, unknown>): Record<string, unknown> {
  const result = { ...item };
  if (typeof result.type === "string") {
    result.type = camelCaseItemType(result.type);
  }
  return result;
}

/**
 * Detect whether an exec error message describes a transient/retryable failure
 * (e.g. "Reconnecting... n/5") vs a terminal one.
 */
function isRetryableError(message: string): boolean {
  return /reconnect/i.test(message) || /\d+\/\d+/.test(message);
}

/**
 * Shape an error payload as the protocol's TurnError object: `{ message: string }`
 * plus whatever else the payload already carried. This is the only form
 * `codex app-server` puts in the `error` field of its `error` notification
 * (ErrorNotification.error → TurnError, message required), so exec mode emits
 * the same one. Fields the exec payload does not carry are not invented.
 */
function toTurnError(raw: unknown, fallbackMessage: string): Record<string, unknown> {
  if (typeof raw === "string") return { message: raw };
  if (raw !== null && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    return typeof obj.message === "string" ? obj : { ...obj, message: fallbackMessage };
  }
  return { message: fallbackMessage };
}

/**
 * Reverse-map SandboxPolicy object back to sandbox mode string for -s flag.
 */
function sandboxPolicyToMode(policy: SandboxPolicy): string | undefined {
  switch (policy.type) {
    case "readOnly":
      return "read-only";
    case "workspaceWrite":
      return "workspace-write";
    case "dangerFullAccess":
      return "danger-full-access";
    case "externalSandbox":
      // externalSandbox has no direct CLI equivalent; log and return undefined
      // so the caller falls back to thread/spawn-level sandbox.
      console.error(
        `[exec-client] SandboxPolicy type "externalSandbox" cannot be mapped to exec -s flag; using thread-level sandbox`
      );
      return undefined;
    default:
      return undefined;
  }
}

/**
 * Map exec JSONL event type (snake_case) to app-server notification method.
 * Covers all events from codex-schema/EventMsg.json that have corresponding
 * app-server notification methods in SessionManager.registerHandlers().
 */
const EXEC_EVENT_TO_METHOD: Record<string, string> = {
  // Agent message deltas
  agent_message_delta: Methods.AGENT_MESSAGE_DELTA,
  agent_message_content_delta: Methods.AGENT_MESSAGE_DELTA,

  // Command execution
  exec_command_output_delta: Methods.COMMAND_OUTPUT_DELTA,
  command_output_delta: Methods.COMMAND_OUTPUT_DELTA,
  terminal_interaction: Methods.COMMAND_TERMINAL_INTERACTION,

  // File changes
  file_change_output_delta: Methods.FILE_CHANGE_OUTPUT_DELTA,

  // Reasoning
  reasoning_content_delta: Methods.REASONING_TEXT_DELTA,
  reasoning_raw_content_delta: Methods.REASONING_TEXT_DELTA,
  agent_reasoning_delta: Methods.REASONING_TEXT_DELTA,
  agent_reasoning_raw_content_delta: Methods.REASONING_TEXT_DELTA,
  reasoning_summary_delta: Methods.REASONING_SUMMARY_DELTA,
  agent_reasoning_section_break: Methods.REASONING_SUMMARY_PART_ADDED,

  // Plan
  plan_delta: Methods.PLAN_DELTA,
  plan_update: Methods.TURN_PLAN_UPDATED,

  // Turn-level
  turn_diff: Methods.TURN_DIFF_UPDATED,
  diff_update: Methods.TURN_DIFF_UPDATED,

  // MCP
  mcp_tool_call_begin: Methods.MCP_TOOL_PROGRESS,
  mcp_tool_call_end: Methods.MCP_TOOL_PROGRESS,
  mcp_startup_update: Methods.MCP_TOOL_PROGRESS,
  mcp_startup_complete: Methods.MCP_TOOL_PROGRESS,

  // Model routing
  model_reroute: Methods.MODEL_REROUTED,

  // Thread/session events
  thread_name_updated: Methods.THREAD_NAME_UPDATED,
  token_count: Methods.THREAD_TOKEN_USAGE_UPDATED,
  session_configured: Methods.SESSION_CONFIGURED,

  // Item lifecycle (in case exec emits these outside the dot-notation variants)
  item_started: Methods.ITEM_STARTED,
  item_completed: Methods.ITEM_COMPLETED,
  raw_response_item: Methods.RAW_RESPONSE_ITEM_COMPLETED,

  // Stream errors — map to error method so retryable detection can handle it
  stream_error: Methods.ERROR,

  // Legacy turn lifecycle (v1 wire format used by older CLIs)
  // These are critical for exec fallback since it targets CLIs without app-server.
  task_started: Methods.TURN_STARTED,
  task_complete: Methods.TURN_COMPLETED,
  turn_aborted: Methods.TURN_COMPLETED,
};

export class ExecClient extends EventEmitter implements ICodexClient {
  private _destroyed = false;
  private process: ChildProcess | null = null;
  private spawnOpts: AppServerSpawnOptions | null = null;

  // Thread/turn state
  private threadId: string | null = null;
  /** Real thread ID from CLI (received via thread.started event). Used for exec resume. */
  private realThreadId: string | null = null;
  private turnId: string | null = null;
  private turnCount = 0;
  private threadStartParams: ThreadStartParams | null = null;
  private lastAgentMessageText = "";
  private turnCompleted = false;
  private schemaTmpDirs: string[] = [];
  private _unappliedTurnOverrides: string[] = [];
  /** JSONL records of the current turn that started with `{` and did not parse. */
  private unparsedLines = 0;
  /** JSONL events of the current turn this client knows how to translate. */
  private recognizedEvents = 0;
  /** JSONL events of the current turn whose type this client has no mapping for. */
  private unmappedEvents = 0;

  // Handlers
  private notificationHandler: NotificationHandler | null = null;
  private serverRequestHandler: ServerRequestHandler | null = null;

  // Stdout buffer for JSONL parsing
  private buffer = "";
  private decoder = new StringDecoder("utf8");

  get destroyed(): boolean {
    return this._destroyed;
  }

  get supportsTurnOverrides(): boolean {
    // After the first turn, exec resume does not support -s/-p/-C overrides
    return this.turnCount <= 1 || this.realThreadId == null;
  }

  get childPid(): number | undefined {
    return this.process?.pid ?? undefined;
  }

  /**
   * Overrides the last started turn asked for that its command line could not
   * carry. `codex exec resume` takes no `-s`/`-C`/`--output-schema`, so those
   * requests reach neither the CLI nor the session it resumes.
   */
  get unappliedTurnOverrides(): readonly string[] {
    return this._unappliedTurnOverrides;
  }

  async start(opts: AppServerSpawnOptions): Promise<InitializeResult> {
    if (this._destroyed) throw new Error("Client destroyed");
    this.spawnOpts = opts;
    return { userAgent: "codex-exec" };
  }

  async threadStart(params: ThreadStartParams): Promise<ThreadStartResult> {
    if (this._destroyed) throw new Error("Client destroyed");
    this.threadStartParams = params;
    this.threadId = `exec_thread_${randomUUID().slice(0, 12)}`;
    return { thread: { id: this.threadId } };
  }

  async threadFork(_params: ThreadForkParams): Promise<ThreadForkResult> {
    throw new Error(
      `Error [${ErrorCode.EXEC_NOT_SUPPORTED}]: threadFork is not supported in exec mode`
    );
  }

  async threadResume(_params: ThreadResumeParams): Promise<ThreadResumeResult> {
    throw new Error(
      `Error [${ErrorCode.EXEC_NOT_SUPPORTED}]: threadResume is not supported in exec mode`
    );
  }

  async threadBackgroundTerminalsClean(
    _params: ThreadBackgroundTerminalsCleanParams
  ): Promise<Record<string, never>> {
    throw new Error(
      `Error [${ErrorCode.EXEC_NOT_SUPPORTED}]: threadBackgroundTerminalsClean is not supported in exec mode`
    );
  }

  async turnStart(params: TurnStartParams): Promise<TurnStartResult> {
    if (this._destroyed) throw new Error("Client destroyed");
    if (!this.threadId) throw new Error("No thread started");

    // Kill any previous turn subprocess
    this.killProcess();

    this.turnCount++;
    this.turnId = `exec_turn_${randomUUID().slice(0, 12)}`;
    this.lastAgentMessageText = "";
    this.turnCompleted = false;
    this._unappliedTurnOverrides = [];
    this.unparsedLines = 0;
    this.recognizedEvents = 0;
    this.unmappedEvents = 0;
    this.buffer = "";
    this.decoder = new StringDecoder("utf8");

    // Extract prompt text from input array
    const prompt = params.input
      .filter((i): i is { type: "text"; text: string } => i.type === "text")
      .map((i) => i.text)
      .join("\n");

    // Extract image paths
    const images = params.input
      .filter((i): i is { type: "localImage"; path: string } => i.type === "localImage")
      .map((i) => i.path);

    // First turn: codex exec "<prompt>" ...
    // Subsequent turns: codex exec resume <threadId> "<prompt>" ... (multi-turn context)
    const isResume = this.turnCount > 1 && this.realThreadId != null;
    if (this.turnCount > 1 && !this.realThreadId) {
      // CLI didn't provide a thread ID (e.g. older CLI without thread.started event).
      // Fall back to fresh exec but warn — multi-turn context will be lost.
      console.error(
        "[exec-client] No realThreadId available for resume; falling back to fresh exec (context will be lost)"
      );
      this.emitNotification(Methods.ERROR, {
        threadId: this.threadId,
        turnId: this.turnId,
        error: {
          message:
            "exec mode: multi-turn context unavailable (CLI did not provide thread ID). This turn runs without prior context.",
        },
        willRetry: true, // non-terminal: session continues, just without context
      });
    }
    const args = isResume
      ? this.buildResumeArgs(prompt, params, images)
      : this.buildExecArgs(prompt, params, images);
    const executable = getDefaultCodexExecutable();
    const invocation = resolveCodexInvocation(args, {
      codexCommand: executable.command,
      codexIsPath: executable.isPath,
    });

    const proc = spawn(invocation.cmd, invocation.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
      detached: process.platform !== "win32",
      windowsHide: process.platform === "win32",
    });
    this.process = proc;
    if (proc.pid !== undefined) {
      this.emit("spawn", proc.pid, new Date().toISOString());
    }

    // Close stdin immediately — exec reads prompt from args
    proc.stdin?.end();

    proc.stdout!.on("data", (chunk: Buffer) => this.onData(chunk));
    proc.stderr!.on("data", (chunk: Buffer) => {
      console.error(`[exec-client stderr] ${chunk.toString().trimEnd()}`);
    });

    proc.on("error", (err) => {
      if (!this._destroyed) {
        this.emit("error", err);
      }
    });

    proc.on("exit", (code, signal) => {
      // If turn wasn't completed via JSONL event, synthesize completion
      if (this.turnId && !this._destroyed && !this.turnCompleted) {
        this.turnCompleted = true;
        // A clean exit whose stream this client could not read at all says
        // nothing about how the turn went: reporting it as completed would turn
        // "the CLI output was not understood" into an empty successful answer.
        const outcomeUnknown = code === 0 && this.recognizedEvents === 0;
        const failureMessage = outcomeUnknown
          ? `exec process exited with code 0 without emitting any event this client understands (${this.unmappedEvents} unmapped event(s), ${this.unparsedLines} unparseable record(s)); the turn outcome is unknown`
          : code !== 0 && code !== null
            ? `exec process exited with code ${code}`
            : signal
              ? `exec process killed by signal ${signal}`
              : undefined;

        if (outcomeUnknown || (code !== 0 && code !== null)) {
          this.emitNotification(Methods.ERROR, {
            threadId: this.threadId,
            turnId: this.turnId,
            error: { message: failureMessage },
            willRetry: false,
          });
        }
        // Synthesize TURN_COMPLETED so SessionManager transitions out of "running"
        const turnId = this.turnId ?? "";
        const failed = outcomeUnknown || code !== 0;
        this.emitTurnCompleted({
          id: turnId,
          status: failed ? "failed" : "completed",
          output: this.lastAgentMessageText || undefined,
          ...(failureMessage ? { error: { message: failureMessage } } : {}),
        });
      }
      if (!this._destroyed) {
        this.emit("exit", code, signal);
      }
      this.process = null;
    });

    const turnId = this.turnId;
    return { turn: { id: turnId } };
  }

  async turnInterrupt(_params: TurnInterruptParams): Promise<void> {
    this.killProcess();
  }

  onNotification(handler: NotificationHandler): void {
    this.notificationHandler = handler;
  }

  onServerRequest(handler: ServerRequestHandler): void {
    this.serverRequestHandler = handler;
  }

  /**
   * `codex exec` raises no server-initiated requests, so there is no request to
   * answer and no channel to answer it on. Reporting a response as sent would
   * tell the caller its approval reached codex.
   */
  respondToServer(id: RequestId, _result: unknown): void {
    throw new Error(
      `Error [${ErrorCode.EXEC_NOT_SUPPORTED}]: cannot respond to server request id=${String(id)}: exec mode raises no server requests`
    );
  }

  respondErrorToServer(id: RequestId, _code: number, _message: string): void {
    throw new Error(
      `Error [${ErrorCode.EXEC_NOT_SUPPORTED}]: cannot respond to server request id=${String(id)}: exec mode raises no server requests`
    );
  }

  async destroy(): Promise<void> {
    if (this._destroyed) return;
    this._destroyed = true;

    const proc = this.process;
    if (proc && !proc.killed) {
      const alreadyExited = proc.exitCode !== null;
      proc.stdin?.end();
      this.killProcess();

      // Force kill after timeout (matches AppServerClient behavior)
      const forceKill = setTimeout(() => {
        if (proc && !proc.killed && proc.exitCode === null) {
          if (process.platform === "win32" && proc.pid) {
            try {
              spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], {
                stdio: "ignore",
                windowsHide: true,
              });
            } catch {
              // ignore
            }
          } else {
            try {
              if (proc.pid) process.kill(-proc.pid, "SIGKILL");
              else proc.kill("SIGKILL");
            } catch {
              // ignore
            }
          }
        }
      }, FORCE_KILL_TIMEOUT_MS);
      forceKill.unref();

      if (!alreadyExited) {
        await new Promise<void>((resolve) => {
          proc.on("exit", () => {
            clearTimeout(forceKill);
            resolve();
          });
          const fallback = setTimeout(resolve, FORCE_KILL_TIMEOUT_MS + 1000);
          fallback.unref();
        });
      }
    }

    this.process = null;
    this.removeAllListeners();

    // Clean up temp schema directories
    for (const dir of this.schemaTmpDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    this.schemaTmpDirs = [];
  }

  // ── Private helpers ─────────────────────────────────────────────

  /**
   * Build args for the first turn: `codex exec "<prompt>" --json --skip-git-repo-check [flags]`.
   * No --ephemeral so the session persists for subsequent resume turns.
   */
  private buildExecArgs(prompt: string, params: TurnStartParams, images: string[]): string[] {
    const args: string[] = ["exec", prompt, "--json", "--skip-git-repo-check"];

    // Model
    const model = params.model ?? this.threadStartParams?.model ?? this.spawnOpts?.model;
    if (model) args.push("-m", model);

    // Sandbox (first turn only — exec resume does not support -s)
    let effectiveSandbox: string | undefined;
    if (params.sandboxPolicy) {
      effectiveSandbox = sandboxPolicyToMode(params.sandboxPolicy);
    }
    if (!effectiveSandbox) {
      effectiveSandbox = this.threadStartParams?.sandbox ?? this.spawnOpts?.sandbox;
    }
    if (effectiveSandbox) args.push("-s", effectiveSandbox);

    // Profile (first turn only — exec resume does not support -p)
    if (this.spawnOpts?.profile) args.push("-p", this.spawnOpts.profile);

    // CWD (first turn only — exec resume does not support -C)
    const cwd = params.cwd ?? this.threadStartParams?.cwd;
    if (cwd) args.push("-C", cwd);

    // Images
    for (const img of images) args.push("-i", img);

    // Approval policy via config override (precise, doesn't affect sandbox)
    const approvalPolicy =
      params.approvalPolicy ??
      this.threadStartParams?.approvalPolicy ??
      this.spawnOpts?.approvalPolicy;
    if (approvalPolicy) args.push("-c", `approval_policy=${approvalPolicy}`);

    // Output schema (exec supports --output-schema <file>; write to temp file).
    // A turn that cannot carry the schema is not started: the caller asked for a
    // schema-constrained answer and would otherwise read a free-form one as one.
    if (params.outputSchema && Object.keys(params.outputSchema).length > 0) {
      let schemaPath: string;
      try {
        const tmpDir = mkdtempSync(join(tmpdir(), "codex-mcp-schema-"));
        this.schemaTmpDirs.push(tmpDir);
        schemaPath = join(tmpDir, "output-schema.json");
        writeFileSync(schemaPath, JSON.stringify(params.outputSchema));
      } catch (err) {
        throw new Error(
          `Error [${ErrorCode.INTERNAL}]: Failed to write the output schema to a temp file, so the turn cannot be schema-constrained: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err }
        );
      }
      args.push("--output-schema", schemaPath);
    }

    // Config overrides
    const configs: Record<string, unknown> = {
      ...this.spawnOpts?.config,
      ...this.threadStartParams?.config,
    };
    for (const [key, value] of Object.entries(configs)) {
      const serialized =
        typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);
      args.push("-c", `${key}=${serialized}`);
    }

    return args;
  }

  /**
   * Build args for subsequent turns: `codex exec resume <threadId> "<prompt>" --json [flags]`.
   * Resumes the persisted session for multi-turn context continuity.
   * Note: exec resume only supports -m, -c, -i, --json, --skip-git-repo-check.
   *       -s, -p, -C are NOT supported and inherit from the first turn's session.
   */
  private buildResumeArgs(prompt: string, params: TurnStartParams, images: string[]): string[] {
    const args: string[] = [
      "exec",
      "resume",
      this.realThreadId!,
      prompt,
      "--json",
      "--skip-git-repo-check",
    ];

    // Record the overrides this command line cannot carry, so the caller can be
    // told what did not take effect rather than reading success as applied.
    if (params.sandboxPolicy) {
      this.recordUnappliedOverride(
        "sandbox",
        "exec resume does not support -s; the resumed session keeps the sandbox of the first turn"
      );
    }
    if (params.cwd) {
      this.recordUnappliedOverride(
        "cwd",
        "exec resume does not support -C; the resumed session keeps the cwd of the first turn"
      );
    }
    if (params.outputSchema && Object.keys(params.outputSchema).length > 0) {
      this.recordUnappliedOverride(
        "outputSchema",
        "exec resume does not support --output-schema; the turn output is not schema-constrained"
      );
    }

    // Model override (supported in resume)
    const model = params.model ?? this.threadStartParams?.model ?? this.spawnOpts?.model;
    if (model) args.push("-m", model);

    // Images (supported in resume)
    for (const img of images) args.push("-i", img);

    // Approval policy via config override (supported in resume via -c)
    const approvalPolicy =
      params.approvalPolicy ??
      this.threadStartParams?.approvalPolicy ??
      this.spawnOpts?.approvalPolicy;
    if (approvalPolicy) args.push("-c", `approval_policy=${approvalPolicy}`);

    // Config overrides (supported in resume via -c)
    const configs: Record<string, unknown> = {
      ...this.spawnOpts?.config,
      ...this.threadStartParams?.config,
    };
    for (const [key, value] of Object.entries(configs)) {
      const serialized =
        typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);
      args.push("-c", `${key}=${serialized}`);
    }

    return args;
  }

  private onData(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk);
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed[0] !== "{") continue;

      let event: Record<string, unknown>;
      try {
        event = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        // A record that opened with `{` and did not parse is a lost event, not
        // CLI banner text. Which event it was is unknowable, so the turn result
        // reports the loss instead of standing on what did arrive.
        this.unparsedLines++;
        console.error(`[exec-client] Failed to parse JSONL: ${trimmed.slice(0, 200)}`);
        continue;
      }
      this.handleExecEvent(event);
    }
  }

  /**
   * Transform exec JSONL event into app-server notification and dispatch.
   */
  private handleExecEvent(event: Record<string, unknown>): void {
    const type = event.type as string;
    // Counted as understood here; the unmapped branch at the bottom takes it back.
    this.recognizedEvents++;

    // Handle structured lifecycle events first (dot-notation from exec --json)
    switch (type) {
      case "thread.started": {
        const cliThreadId = (event.thread_id ?? event.threadId) as string | undefined;
        if (cliThreadId) {
          this.threadId = cliThreadId;
          this.realThreadId = cliThreadId;
        }
        this.emitNotification(Methods.THREAD_STARTED, {
          thread: { id: this.threadId },
        });
        return;
      }

      case "turn.started":
        this.emitNotification(Methods.TURN_STARTED, {
          turn: { id: this.turnId, status: "inProgress" },
        });
        return;

      case "item.started": {
        const item = event.item as Record<string, unknown> | undefined;
        if (item) {
          this.emitNotification(Methods.ITEM_STARTED, {
            threadId: this.threadId,
            turnId: this.turnId,
            item: transformItem(item),
          });
        }
        return;
      }

      case "item.completed": {
        const item = event.item as Record<string, unknown> | undefined;
        if (item) {
          const transformed = transformItem(item);
          if (transformed.type === "agentMessage" && typeof transformed.text === "string") {
            this.lastAgentMessageText = transformed.text;
          }
          this.emitNotification(Methods.ITEM_COMPLETED, {
            threadId: this.threadId,
            turnId: this.turnId,
            item: transformed,
          });
        }
        return;
      }

      case "turn.completed": {
        this.emitTurnCompleted({
          id: this.turnId ?? "",
          status: "completed",
          output: this.lastAgentMessageText || undefined,
          usage: event.usage,
        });
        return;
      }

      case "turn.failed": {
        this.emitTurnCompleted({
          id: this.turnId ?? "",
          status: "failed",
          error: toTurnError(event.error, "Turn failed"),
        });
        return;
      }

      case "error": {
        this.emitError(event, type);
        return;
      }

      default:
        break;
    }

    // Map snake_case event types to app-server notification methods
    const mappedMethod = EXEC_EVENT_TO_METHOD[type];
    if (mappedMethod) {
      // Legacy turn lifecycle events need turn object synthesis
      if (type === "task_started") {
        const turnId = (event.turn_id as string) ?? this.turnId;
        if (turnId) this.turnId = turnId;
        this.emitNotification(Methods.TURN_STARTED, {
          turn: { id: this.turnId, status: "inProgress" },
        });
      } else if (type === "task_complete") {
        this.emitTurnCompleted({
          id: this.turnId ?? "",
          status: "completed",
          output: this.lastAgentMessageText || undefined,
        });
      } else if (type === "turn_aborted") {
        this.emitTurnCompleted({
          id: this.turnId ?? "",
          status: "cancelled",
          error: toTurnError(event.reason, "Turn aborted"),
        });
      } else if (mappedMethod === Methods.ERROR) {
        this.emitError(event, type);
      } else {
        this.emitNotification(mappedMethod, {
          threadId: this.threadId,
          turnId: this.turnId,
          ...event,
        });
      }
      return;
    }

    // Unmapped events: log but don't emit to avoid silent drops in manager.
    // The manager's default branch ignores unknown methods, so emitting them
    // would be misleading. Logging ensures visibility during debugging.
    this.recognizedEvents--;
    this.unmappedEvents++;
    console.error(`[exec-client] Unmapped exec event type: ${type}`);
  }

  /**
   * Emit an `error` notification from an exec error event, carrying the message
   * the CLI reported. The event type stands in as the message only when the
   * event carried none.
   */
  private emitError(event: Record<string, unknown>, type: string): void {
    const error = toTurnError(event.message ?? event.error, type);
    this.emitNotification(Methods.ERROR, {
      threadId: this.threadId,
      turnId: this.turnId,
      error,
      willRetry: isRetryableError(String(error.message)),
    });
  }

  /**
   * Emit the turn's final `turn/completed` notification.
   *
   * `codex exec` puts the agent's answer in an `item.completed` record rather
   * than in the completion event, so the output reported here is the last such
   * record of the turn. An unparsed record of the same turn could have been
   * that message, which would make an earlier one the reported final answer —
   * so a turn whose stream lost a record completes as failed instead.
   */
  private emitTurnCompleted(turn: Record<string, unknown>): void {
    this.turnCompleted = true;
    let finalTurn = turn;
    if (turn.status === "completed" && this.unparsedLines > 0) {
      const withoutOutput = { ...turn };
      delete withoutOutput.output;
      finalTurn = {
        ...withoutOutput,
        status: "failed",
        error: {
          message: `exec output stream lost ${this.unparsedLines} unparseable record(s); the agent's final message cannot be determined`,
        },
      };
    }
    this.emitNotification(Methods.TURN_COMPLETED, {
      threadId: this.threadId,
      turn: finalTurn,
    });
    this.turnId = null;
  }

  /** Record an override this turn asked for that its command line cannot carry. */
  private recordUnappliedOverride(name: string, reason: string): void {
    this._unappliedTurnOverrides.push(name);
    console.error(`[exec-client] ${name} override not applied: ${reason}`);
  }

  private emitNotification(method: string, params: unknown): void {
    if (this.notificationHandler) {
      this.notificationHandler(method, params);
    }
  }

  private killProcess(): void {
    if (!this.process || this.process.killed) return;

    if (process.platform !== "win32" && this.process.pid) {
      try {
        process.kill(-this.process.pid, "SIGTERM");
        return;
      } catch {
        // Fall through to direct kill
      }
    }

    try {
      this.process.kill("SIGTERM");
    } catch {
      // ignore
    }
  }
}
