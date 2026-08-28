/**
 * Drive a real codex-mcp process over stdio from a test.
 *
 * The end-to-end tests measure what the process does with its own stdin, its
 * own event loop and its own state directory, so they run the built server
 * rather than importing it. `tests/helpers/fake-codex.mjs` stands in for the
 * codex CLI, which keeps the runs hermetic.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "..", "..");
export const SERVER_ENTRY = join(REPO_ROOT, "dist", "index.js");
export const FAKE_CODEX = join(HERE, "fake-codex.mjs");

/**
 * Whether this platform can run the suite at all.
 *
 * The codex stand-in is a Node script handed to the server as `CODEX_MCP_PATH`,
 * and Windows spawns an executable by its extension: a `.mjs` is not one. The
 * lifetime behaviour these tests measure — the startup event loop, the stdin
 * end, the ownership of a session directory — is covered per platform by the
 * unit tests around it.
 */
export const HARNESS_RUNS_HERE = process.platform !== "win32";

/** Newest mtime under `dir`, so a stale bundle is rebuilt before it is spawned. */
function newestMtimeMs(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtimeMs(child) : statSync(child).mtimeMs);
  }
  return newest;
}

let built = false;

/** Build the bundle the tests spawn, once per test process. */
export function ensureServerBuilt(): void {
  if (built) return;
  const bundle = statSync(SERVER_ENTRY, { throwIfNoEntry: false });
  if (!bundle || bundle.mtimeMs < newestMtimeMs(join(REPO_ROOT, "src"))) {
    execFileSync("bun", ["run", "build"], { cwd: REPO_ROOT, stdio: "pipe" });
  }
  built = true;
}

export interface ServerOptions {
  /** State directory the server owns. Defaults to a fresh temporary one. */
  stateDir?: string;
  /** Extra environment for the server process. */
  env?: Record<string, string>;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

/** A running codex-mcp process and the MCP calls a test makes on it. */
/** A JSON-RPC message the server sent with no id of its own. */
export interface ServerNotification {
  method: string;
  params: Record<string, unknown>;
}

export class ServerProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly stateDir: string;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, PendingCall>();
  private stderrText = "";
  private exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  private notifications: ServerNotification[] = [];
  private notificationWaiters = new Set<(notification: ServerNotification) => void>();

  constructor(opts: ServerOptions = {}) {
    ensureServerBuilt();
    this.stateDir = opts.stateDir ?? mkdtempSync(join(tmpdir(), "codex-mcp-e2e-"));
    // `node`, named rather than taken from `process.execPath`: the package ships
    // a Node bundle behind a `#!/usr/bin/env node` line, and that is the runtime
    // these tests measure. `process.execPath` is whatever runs the test file,
    // which under `bun test` is bun.
    this.child = spawn("node", [SERVER_ENTRY], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        CODEX_MCP_STATE_DIR: this.stateDir,
        CODEX_MCP_PATH: FAKE_CODEX,
        CODEX_MCP_MODE: "app-server",
        ...opts.env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;

    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderrText += chunk;
    });
    this.exited = new Promise((resolveExit) => {
      this.child.on("exit", (code, signal) => resolveExit({ code, signal }));
    });
  }

  get stderr(): string {
    return this.stderrText;
  }

  get pid(): number {
    return this.child.pid!;
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      const msg = JSON.parse(line) as {
        id?: number;
        method?: string;
        params?: Record<string, unknown>;
        result?: unknown;
        error?: { message: string };
      };
      if (typeof msg.id !== "number") {
        // A message with no id is a notification the server sent on its own.
        if (typeof msg.method === "string") {
          const notification = { method: msg.method, params: msg.params ?? {} };
          this.notifications.push(notification);
          for (const waiter of this.notificationWaiters) waiter(notification);
        }
        continue;
      }
      const call = this.pending.get(msg.id);
      if (!call) continue;
      this.pending.delete(msg.id);
      if (msg.error) call.reject(new Error(msg.error.message));
      else call.resolve(msg.result);
    }
  }

  private send(msg: unknown): void {
    this.child.stdin.write(JSON.stringify(msg) + "\n");
  }

  request(method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolveCall, rejectCall) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectCall(new Error(`${method} did not answer within ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolveCall(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          rejectCall(err);
        },
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  /** Run the MCP handshake. Resolves once the server has answered `initialize`. */
  async initialize(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "codex-mcp-e2e", version: "0.0.0" },
    });
    this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  /** Call a tool and return the structured content it answered with. */
  async callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = (await this.request("tools/call", { name, arguments: args })) as {
      structuredContent?: Record<string, unknown>;
      content?: Array<{ text?: string }>;
    };
    return result.structuredContent ?? JSON.parse(result.content?.[0]?.text ?? "{}");
  }

  /**
   * Call a tool asking for progress, and do not wait for it to answer.
   *
   * A held call is the only place a progress notification comes from, so the
   * test reads the notification while the call is still open. The answer, when
   * it comes, has nowhere to go and is dropped.
   */
  startToolCallWithProgress(
    name: string,
    args: Record<string, unknown>,
    progressToken: string
  ): void {
    this.send({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "tools/call",
      params: { name, arguments: args, _meta: { progressToken } },
    });
  }

  /** The first notification of this method the server sends, or a rejection. */
  waitForNotification(method: string, timeoutMs = 10_000): Promise<ServerNotification> {
    const seen = this.notifications.find((n) => n.method === method);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolveWait, rejectWait) => {
      const timer = setTimeout(() => {
        this.notificationWaiters.delete(waiter);
        rejectWait(new Error(`no ${method} notification within ${timeoutMs}ms`));
      }, timeoutMs);
      const waiter = (notification: ServerNotification): void => {
        if (notification.method !== method) return;
        clearTimeout(timer);
        this.notificationWaiters.delete(waiter);
        resolveWait(notification);
      };
      this.notificationWaiters.add(waiter);
    });
  }

  /** Close the client end of stdin, as a client that exits does. */
  endStdin(): void {
    this.child.stdin.end();
  }

  /**
   * Drop both pipes the way a client that was killed does: the server's writes
   * back up with nothing draining them.
   */
  killClientEnd(): void {
    this.child.stdout.pause();
    this.child.stdin.destroy();
  }

  /** Wait for the process to exit, or reject when it outlives `timeoutMs`. */
  async waitForExit(timeoutMs: number): Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, rejectWait) => {
      timer = setTimeout(
        () => rejectWait(new Error(`server pid ${this.pid} still running after ${timeoutMs}ms`)),
        timeoutMs
      );
    });
    try {
      return await Promise.race([this.exited, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Stop the process whatever state it is in. */
  async dispose(): Promise<void> {
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill("SIGKILL");
      await this.exited;
    }
  }
}
