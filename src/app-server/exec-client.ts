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
import { LineReader, readChildOutput } from "./child-stdio.js";
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
 * Every key is a `type` of codex-schema/EventMsg.json, and every EventMsg type
 * an app-server notification carries is a key here. The types the app-server
 * delivers as thread items rather than as notifications — `agent_message`,
 * `user_message`, `agent_reasoning`, `exec_command_begin`/`_end`,
 * `patch_apply_begin`/`_end`, `web_search_begin`/`_end`, `collab_*` — have no
 * notification method to map onto and are handled, or dropped, elsewhere.
 */
export const EXEC_EVENT_TO_METHOD: Record<string, string> = {
  // Agent message deltas
  agent_message_delta: Methods.AGENT_MESSAGE_DELTA,
  agent_message_content_delta: Methods.AGENT_MESSAGE_DELTA,

  // Command execution
  exec_command_output_delta: Methods.COMMAND_OUTPUT_DELTA,
  terminal_interaction: Methods.COMMAND_TERMINAL_INTERACTION,

  // Reasoning
  reasoning_content_delta: Methods.REASONING_TEXT_DELTA,
  reasoning_raw_content_delta: Methods.REASONING_TEXT_DELTA,
  agent_reasoning_delta: Methods.REASONING_TEXT_DELTA,
  agent_reasoning_raw_content_delta: Methods.REASONING_TEXT_DELTA,
  agent_reasoning_section_break: Methods.REASONING_SUMMARY_PART_ADDED,

  // Plan
  plan_delta: Methods.PLAN_DELTA,
  plan_update: Methods.TURN_PLAN_UPDATED,

  // Turn-level
  turn_diff: Methods.TURN_DIFF_UPDATED,

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
  context_compacted: Methods.THREAD_COMPACTED,
  deprecation_notice: Methods.DEPRECATION_NOTICE,

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

/**
 * Per-event field renames that put an exec JSONL payload into the shape the
 * app-server notification of the same method declares, so both clients feed the
 * session handler one form.
 *
 * `exec_command_output_delta` names the chunk `chunk` and the execution
 * `call_id` (codex-schema/EventMsg.json → ExecCommandOutputDeltaEventMsg);
 * `item/commandExecution/outputDelta` names the same two `delta` and `itemId`
 * (codex-schema/v2/CommandExecutionOutputDeltaNotification.json). The delta
 * events that carry `item_id` name it `itemId` on the app-server side, which is
 * the key the session handler groups a delta stream by.
 */
const EXEC_EVENT_FIELD_RENAMES: Record<string, Record<string, string>> = {
  exec_command_output_delta: { chunk: "delta", call_id: "itemId" },
  agent_message_content_delta: { item_id: "itemId" },
  plan_delta: { item_id: "itemId" },
  reasoning_content_delta: { item_id: "itemId" },
  reasoning_raw_content_delta: { item_id: "itemId", content_index: "contentIndex" },
  agent_reasoning_section_break: { item_id: "itemId", summary_index: "summaryIndex" },
};

/**
 * Apply the renames of `EXEC_EVENT_FIELD_RENAMES` to one event.
 *
 * A field the event does not carry stays absent: the app-server form declares
 * `itemId` on every delta, but `agent_message_delta` carries no item id at all
 * (codex-schema/EventMsg.json → AgentMessageDeltaEventMsg has only `delta` and
 * `type`), and one is not minted to fill the field.
 *
 * `chunk` is renamed only when the CLI sent a string. The schema types it as
 * one, describing it as "Raw bytes from the stream (may not be valid UTF-8)";
 * anything else keeps its own name rather than being decoded into a `delta` the
 * CLI did not send.
 */
function renameExecEventFields(
  type: string,
  event: Record<string, unknown>
): Record<string, unknown> {
  const renames = EXEC_EVENT_FIELD_RENAMES[type];
  if (!renames) return event;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    const renamed = renames[key];
    if (renamed === undefined) {
      result[key] = value;
      continue;
    }
    if (renamed === "delta" && typeof value !== "string") {
      result[key] = value;
      continue;
    }
    result[renamed] = value;
  }
  return result;
}

/**
 * Kill a process that outlived the SIGTERM it was sent, with its process group
 * where the platform gives it one.
 */
function forceKillProcess(proc: ChildProcess): void {
  if (proc.killed || proc.exitCode !== null) return;

  if (process.platform === "win32" && proc.pid) {
    try {
      spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      // ignore
    }
    return;
  }

  try {
    if (proc.pid) process.kill(-proc.pid, "SIGKILL");
    else proc.kill("SIGKILL");
  } catch {
    // ignore
  }
}

function pushImageArgs(args: string[], images: string[]): void {
  for (const img of images) args.push("-i", img);
}

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

  private lines = new LineReader();

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
    this.lines.reset();

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

    readChildOutput(proc, (chunk) => this.onData(chunk), "[exec-client stderr]");

    proc.on("error", (err) => {
      if (!this._destroyed) {
        this.emit("error", err);
      }
    });

    proc.on("exit", (code, signal) => this.onProcessExit(code, signal));

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
      const forceKill = setTimeout(() => forceKillProcess(proc), FORCE_KILL_TIMEOUT_MS);
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

  private onProcessExit(code: number | null, signal: NodeJS.Signals | null): void {
    // If turn wasn't completed via JSONL event, synthesize completion
    if (this.turnId && !this._destroyed && !this.turnCompleted) {
      this.completeTurnFromExit(code, signal);
    }
    if (!this._destroyed) {
      this.emit("exit", code, signal);
    }
    this.process = null;
  }

  /** Report the turn of a subprocess that exited without stating an outcome. */
  private completeTurnFromExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.turnCompleted = true;
    const outcomeUnknown = code === 0 && this.recognizedEvents === 0;
    const failureMessage = this.exitFailureMessage(code, signal, outcomeUnknown);

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

  /**
   * How the subprocess exit failed the turn, or `undefined` when it did not.
   *
   * A clean exit whose stream this client could not read at all says nothing
   * about how the turn went: reporting it as completed would turn "the CLI
   * output was not understood" into an empty successful answer.
   */
  private exitFailureMessage(
    code: number | null,
    signal: NodeJS.Signals | null,
    outcomeUnknown: boolean
  ): string | undefined {
    if (outcomeUnknown) {
      return `exec process exited with code 0 without emitting any event this client understands (${this.unmappedEvents} unmapped event(s), ${this.unparsedLines} unparseable record(s)); the turn outcome is unknown`;
    }
    if (code !== 0 && code !== null) return `exec process exited with code ${code}`;
    if (signal) return `exec process killed by signal ${signal}`;
    return undefined;
  }

  /**
   * Build args for the first turn: `codex exec "<prompt>" --json --skip-git-repo-check [flags]`.
   * No --ephemeral so the session persists for subsequent resume turns.
   */
  private buildExecArgs(prompt: string, params: TurnStartParams, images: string[]): string[] {
    const args: string[] = ["exec", prompt, "--json", "--skip-git-repo-check"];

    this.pushModelArgs(args, params);

    // Sandbox (first turn only — exec resume does not support -s)
    const effectiveSandbox = this.resolveSandboxMode(params);
    if (effectiveSandbox) args.push("-s", effectiveSandbox);

    // Profile (first turn only — exec resume does not support -p)
    if (this.spawnOpts?.profile) args.push("-p", this.spawnOpts.profile);

    // CWD (first turn only — exec resume does not support -C)
    const cwd = params.cwd ?? this.threadStartParams?.cwd;
    if (cwd) args.push("-C", cwd);

    pushImageArgs(args, images);
    this.pushApprovalPolicyArgs(args, params);

    if (params.outputSchema && Object.keys(params.outputSchema).length > 0) {
      args.push("--output-schema", this.writeOutputSchemaFile(params.outputSchema));
    }

    this.pushConfigOverrideArgs(args);

    return args;
  }

  /**
   * The sandbox mode of the first turn. `externalSandbox` maps to no -s flag,
   * so the thread- and spawn-level sandbox stand in for it.
   */
  private resolveSandboxMode(params: TurnStartParams): string | undefined {
    let effectiveSandbox: string | undefined;
    if (params.sandboxPolicy) {
      effectiveSandbox = sandboxPolicyToMode(params.sandboxPolicy);
    }
    if (!effectiveSandbox) {
      effectiveSandbox = this.threadStartParams?.sandbox ?? this.spawnOpts?.sandbox;
    }
    return effectiveSandbox;
  }

  /**
   * Write the schema where `codex exec --output-schema <file>` reads it.
   * A turn that cannot carry the schema is not started: the caller asked for a
   * schema-constrained answer and would otherwise read a free-form one as one.
   */
  private writeOutputSchemaFile(outputSchema: Record<string, unknown>): string {
    try {
      const tmpDir = mkdtempSync(join(tmpdir(), "codex-mcp-schema-"));
      this.schemaTmpDirs.push(tmpDir);
      const schemaPath = join(tmpDir, "output-schema.json");
      writeFileSync(schemaPath, JSON.stringify(outputSchema));
      return schemaPath;
    } catch (err) {
      throw new Error(
        `Error [${ErrorCode.INTERNAL}]: Failed to write the output schema to a temp file, so the turn cannot be schema-constrained: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err }
      );
    }
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

    this.recordResumeUnappliedOverrides(params);

    this.pushModelArgs(args, params);
    pushImageArgs(args, images);
    this.pushApprovalPolicyArgs(args, params);
    this.pushConfigOverrideArgs(args);

    return args;
  }

  /**
   * Record the overrides an `exec resume` command line cannot carry, so the
   * caller can be told what did not take effect rather than reading success as
   * applied.
   */
  private recordResumeUnappliedOverrides(params: TurnStartParams): void {
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
  }

  private pushModelArgs(args: string[], params: TurnStartParams): void {
    const model = params.model ?? this.threadStartParams?.model ?? this.spawnOpts?.model;
    if (model) args.push("-m", model);
  }

  /** Approval policy travels as a config override: precise, and it leaves the sandbox alone. */
  private pushApprovalPolicyArgs(args: string[], params: TurnStartParams): void {
    const approvalPolicy =
      params.approvalPolicy ??
      this.threadStartParams?.approvalPolicy ??
      this.spawnOpts?.approvalPolicy;
    if (approvalPolicy) args.push("-c", `approval_policy=${approvalPolicy}`);
  }

  private pushConfigOverrideArgs(args: string[]): void {
    const configs: Record<string, unknown> = {
      ...this.spawnOpts?.config,
      ...this.threadStartParams?.config,
    };
    for (const [key, value] of Object.entries(configs)) {
      const serialized =
        typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);
      args.push("-c", `${key}=${serialized}`);
    }
  }

  private onData(chunk: Buffer): void {
    for (const trimmed of this.lines.take(chunk)) {
      if (trimmed[0] !== "{") continue;

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

    if (this.handleLifecycleEvent(type, event)) return;

    // Map snake_case event types to app-server notification methods
    const mappedMethod = EXEC_EVENT_TO_METHOD[type];
    if (mappedMethod) {
      this.handleMappedEvent(type, event, mappedMethod);
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
   * Handle the lifecycle events exec --json states in dot notation, and answer
   * whether the event was one of them.
   */
  private handleLifecycleEvent(type: string, event: Record<string, unknown>): boolean {
    switch (type) {
      case "thread.started":
        this.handleThreadStarted(event);
        return true;

      case "turn.started":
        this.emitNotification(Methods.TURN_STARTED, {
          turn: { id: this.turnId, status: "inProgress" },
        });
        return true;

      case "item.started":
        this.handleItemStarted(event);
        return true;

      case "item.completed":
        this.handleItemCompleted(event);
        return true;

      case "turn.completed":
        this.emitTurnCompleted({
          id: this.turnId ?? "",
          status: "completed",
          output: this.lastAgentMessageText || undefined,
          usage: event.usage,
        });
        return true;

      case "turn.failed":
        this.emitTurnCompleted({
          id: this.turnId ?? "",
          status: "failed",
          error: toTurnError(event.error, "Turn failed"),
        });
        return true;

      case "agent_message":
        // The v1 stream's finished assistant message
        // (codex-schema/EventMsg.json → AgentMessageEventMsg, `message`
        // required). The app-server delivers the same text as an `item/completed`
        // carrying an AgentMessageThreadItem, whose required `id` this event does
        // not carry, so the text becomes this turn's answer instead of being
        // republished under an item id that would have to be invented.
        if (typeof event.message === "string") {
          this.lastAgentMessageText = event.message;
        }
        return true;

      case "error":
        this.emitError(event, type);
        return true;

      default:
        return false;
    }
  }

  private handleThreadStarted(event: Record<string, unknown>): void {
    const cliThreadId = (event.thread_id ?? event.threadId) as string | undefined;
    if (cliThreadId) {
      this.threadId = cliThreadId;
      this.realThreadId = cliThreadId;
    }
    this.emitNotification(Methods.THREAD_STARTED, {
      thread: { id: this.threadId },
    });
  }

  private handleItemStarted(event: Record<string, unknown>): void {
    const item = event.item as Record<string, unknown> | undefined;
    if (item) {
      this.emitNotification(Methods.ITEM_STARTED, {
        threadId: this.threadId,
        turnId: this.turnId,
        item: transformItem(item),
      });
    }
  }

  private handleItemCompleted(event: Record<string, unknown>): void {
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
  }

  /** Emit the notification an event type carries onto its mapped method. */
  private handleMappedEvent(
    type: string,
    event: Record<string, unknown>,
    mappedMethod: string
  ): void {
    // Legacy turn lifecycle events need turn object synthesis
    if (type === "task_started") {
      const turnId = (event.turn_id as string) ?? this.turnId;
      if (turnId) this.turnId = turnId;
      this.emitNotification(Methods.TURN_STARTED, {
        turn: { id: this.turnId, status: "inProgress" },
      });
    } else if (type === "task_complete") {
      this.emitTaskComplete(event);
    } else if (type === "turn_aborted") {
      this.emitTurnCompleted({
        id: this.turnId ?? "",
        // TurnStatus (codex-schema/v2/TurnCompletedNotification.json) is
        // completed | interrupted | failed | inProgress, and an aborted turn —
        // whatever its TurnAbortReason — neither completed nor failed.
        status: "interrupted",
        error: toTurnError(event.reason, "Turn aborted"),
      });
    } else if (mappedMethod === Methods.ERROR) {
      this.emitError(event, type);
    } else {
      this.emitNotification(mappedMethod, {
        threadId: this.threadId,
        turnId: this.turnId,
        ...renameExecEventFields(type, event),
      });
    }
  }

  /**
   * `task_complete` states the turn's answer itself in `last_agent_message`
   * (codex-schema/EventMsg.json → TaskCompleteEventMsg); the messages seen
   * during the turn stand in only when it did not.
   */
  private emitTaskComplete(event: Record<string, unknown>): void {
    const lastAgentMessage = event.last_agent_message;
    const output =
      typeof lastAgentMessage === "string" && lastAgentMessage.length > 0
        ? lastAgentMessage
        : this.lastAgentMessageText;
    this.emitTurnCompleted({
      id: this.turnId ?? "",
      status: "completed",
      output: output || undefined,
    });
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
   * `codex exec` states the agent's answer outside the completion event on both
   * wire formats — in an `item.completed` record on the v2 one, in an
   * `agent_message` event on the v1 one — so the output reported here is the
   * last such record of the turn, unless `task_complete` named the answer in its
   * own `last_agent_message`. An unparsed record of the same turn could have
   * been that message, which would make an earlier one the reported final
   * answer — so a completed turn whose stream lost a record fails instead, and
   * an interrupted one, which reports no answer, carries the loss in its reason.
   */
  private emitTurnCompleted(turn: Record<string, unknown>): void {
    this.turnCompleted = true;
    let finalTurn = turn;
    if (this.unparsedLines > 0 && turn.status === "completed") {
      const withoutOutput = { ...turn };
      delete withoutOutput.output;
      finalTurn = {
        ...withoutOutput,
        status: "failed",
        error: {
          message: `exec output stream lost ${this.unparsedLines} unparseable record(s); the agent's final message cannot be determined`,
        },
      };
    } else if (this.unparsedLines > 0 && turn.status === "interrupted") {
      // An interrupted turn reports no answer, so a lost record cannot make an
      // older message pass for the final one and the outcome the CLI stated
      // stands. The loss still travels, appended to the reason the turn carries.
      const reason = toTurnError(turn.error, "Turn aborted");
      finalTurn = {
        ...turn,
        error: {
          ...reason,
          message: `${String(reason.message)} (exec output stream lost ${this.unparsedLines} unparseable record(s))`,
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
