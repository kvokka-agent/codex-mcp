/**
 * codex-mcp — MCP server entry point
 *
 * Starts the MCP server with stdio transport and spawns one
 * `codex app-server` child process per session.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { RecoveredSession } from "./persistence/index.js";
import { createServer } from "./server.js";
import type { SessionManager } from "./session/manager/session-manager.js";
import { reapOrphanProcesses } from "./session/orphan-reaper.js";
import { type SessionPersistence, startDiskPersistence } from "./session/persistence.js";
import {
  checkDefaultCodexExecutableAvailability,
  getDefaultCodexExecutable,
} from "./utils/codex-executable.js";
import { decideStdinShutdown } from "./utils/stdin-shutdown.js";
import { runStdioPreflight } from "./utils/stdio-guard.js";

const STDIN_SHUTDOWN_CHECK_MS = 750;
const STDIN_SHUTDOWN_MAX_WAIT_MS = process.platform === "win32" ? 15_000 : 10_000;
/**
 * How long a shutdown waits on a write to the client.
 *
 * A client that died leaves a pipe nothing drains: the SDK's write returns
 * false and waits for a `drain` event that never comes. The wait is bounded so
 * the shutdown finishes on its own instead of on the force-exit timer.
 */
const CLIENT_WRITE_DEADLINE_MS = 1_000;

/**
 * Await `work`, giving up after `timeoutMs` and saying which step it was.
 *
 * Nothing after a shutdown step depends on its result, so a step that failed or
 * ran out of time is reported and the shutdown carries on.
 */
async function withDeadline(
  work: Promise<unknown>,
  timeoutMs: number,
  what: string
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
    if (timer.unref) timer.unref();
  });
  try {
    const outcome = await Promise.race([work.then(() => "done" as const), deadline]);
    if (outcome === "timeout") {
      console.error(`[codex-mcp] ${what} did not finish within ${timeoutMs}ms — carrying on`);
    }
  } catch (err) {
    console.error(
      `[codex-mcp] ${what} failed: ${err instanceof Error ? err.message : String(err)}`
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Report what the stdio preflight found, and stop the server when strict mode blocks. */
function reportStdioPreflight(): void {
  const preflight = runStdioPreflight();
  for (const note of preflight.notes) {
    console.error(`[stdio] ${note}`);
  }
  if (preflight.riskLevel === "elevated") {
    console.error(`[stdio] Elevated stdout contamination risk detected (mode=${preflight.mode}).`);
    for (const reason of preflight.riskReasons) {
      console.error(`[stdio] Reason: ${reason}`);
    }
    for (const suggestion of preflight.suggestions) {
      console.error(`[stdio] Suggestion: ${suggestion}`);
    }
  }
  if (preflight.shouldBlock) {
    throw new Error(
      "STDIO preflight failed in strict mode due to blocking stdout contamination risk"
    );
  }
}

/** Say what came back from disk: the sessions this server may act on, and the ones it may not. */
function reportRecoveredSessions(recovered: RecoveredSession[], pruned: number): void {
  const held = recovered.filter((session) => session.owner.kind === "held");
  if (recovered.length > held.length) {
    console.error(`[codex-mcp] Read ${recovered.length - held.length} session(s) from disk`);
  }
  if (held.length > 0) {
    console.error(`[codex-mcp] ${held.length} session(s) belong to another running codex-mcp`);
  }
  if (pruned > 0) {
    console.error(`[codex-mcp] Pruned ${pruned} old session(s)`);
  }
}

/**
 * Reap the codex processes the adopted sessions left behind.
 *
 * It runs after the transport is connected, for two reasons. Nothing holds
 * this process's event loop until then, so an await here that resolves on a
 * timer alone lets the process exit before a client ever sees the server. And a
 * confirmed orphan is given five seconds to exit gracefully, which is five
 * seconds a client would spend waiting for a server that is already able to
 * answer.
 */
async function reapAdoptedOrphans(recovered: RecoveredSession[]): Promise<void> {
  const adopted = recovered.filter((session) => session.owner.kind !== "held");
  if (adopted.length === 0) return;
  const reaped = await reapOrphanProcesses(adopted);
  if (reaped.reaped > 0) console.error(`[codex-mcp] Reaped ${reaped.reaped} orphan process(es)`);
  if (reaped.unconfirmed > 0) {
    console.error(
      `[codex-mcp] ${reaped.unconfirmed} orphan process(es) were signalled but their exit was not` +
        ` confirmed — they may still be running; check them and kill them by hand`
    );
  }
  if (reaped.skipped > 0) {
    console.error(
      `[codex-mcp] Left ${reaped.skipped} recorded pid(s) alone: the process behind each could not` +
        ` be confirmed as ours, so no signal was sent`
    );
  }
}

/** Wait for stderr to drain, so what a shutdown reported is out before the process goes. */
function flushStderr(): Promise<void> {
  return new Promise<void>((resolve) => process.stderr.write("", () => resolve()));
}

/**
 * The graceful shutdown of one running server: what it waits for, and what
 * makes it start.
 *
 * The process signals, the runtime errors and the state of stdin all lead here,
 * and `shutdown` runs once whatever called it.
 */
class ServerLifecycle {
  private closing = false;
  private lastExitCode = 0;
  private stdinClosedAt: number | undefined;
  private stdinClosedReason: "end" | "close" | undefined;
  private stdinShutdownTimer: ReturnType<typeof setTimeout> | undefined;

  private readonly onStdinEnd = () => this.handleStdinTerminated("end");
  private readonly onStdinClose = () => this.handleStdinTerminated("close");

  private readonly handleStdinError = (error: Error) => {
    console.error("[codex-mcp] stdin error:", error);
    this.lastExitCode = 1;
    void this.shutdown("stdin_error");
  };

  private readonly handleUnexpectedError = (error: unknown) => {
    console.error("[codex-mcp] Unhandled runtime error:", error);
    this.lastExitCode = 1;
    void this.shutdown("runtime_error");
  };

  constructor(
    private readonly server: McpServer,
    private readonly sessionManager: SessionManager,
    private readonly persistence: SessionPersistence | undefined
  ) {}

  /** Register every handler that can start a shutdown, and keep stdin flowing. */
  installProcessHandlers(): void {
    process.on("SIGINT", () => void this.shutdown("SIGINT"));
    process.on("SIGTERM", () => void this.shutdown("SIGTERM"));
    // Windows: Ctrl+Break / console close scenarios.
    process.on("SIGBREAK", () => void this.shutdown("SIGBREAK"));
    // `beforeExit` fires with an empty event loop: nothing is left to serve, so the
    // sessions are written down before the process goes. `server.isConnected()`
    // cannot gate this — the stdio transport reports itself connected for the life
    // of the process — and `shutdown` runs once whatever calls it.
    process.on("beforeExit", () => void this.shutdown("beforeExit"));
    process.on("uncaughtException", this.handleUnexpectedError);
    process.on("unhandledRejection", this.handleUnexpectedError);

    // Keep stdin alive so the MCP stdio transport continues to receive frames.
    if (typeof process.stdin.resume === "function") {
      process.stdin.resume();
    }
    process.stdin.on("error", this.handleStdinError);
    // Guarded shutdown: some clients can transiently trigger stdio close-like signals.
    // We only exit after checking connection/session state.
    process.stdin.on("end", this.onStdinEnd);
    process.stdin.on("close", this.onStdinClose);
  }

  async shutdown(reason = "unknown"): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.clearStdinShutdownTimer();
    this.detachStdinListeners();

    // Set a hard force-exit timer in case cleanup hangs
    const forceExitMs = process.platform === "win32" ? 10_000 : 5_000;
    const forceExitTimer = setTimeout(() => process.exit(this.lastExitCode), forceExitMs);
    if (forceExitTimer.unref) forceExitTimer.unref();

    const activeSessions = this.sessionManager.listSessions();
    const runningCount = activeSessions.filter(
      (s) => s.status === "running" || s.status === "waiting_approval"
    ).length;

    console.error(
      `[codex-mcp] shutdown triggered (reason=${reason}, activeSessions=${runningCount}, total=${activeSessions.length})`
    );

    this.writeSessionsDown();

    if (this.server.isConnected()) {
      await withDeadline(
        this.sendStopping(reason, runningCount, activeSessions.length),
        CLIENT_WRITE_DEADLINE_MS,
        "the server_stopping notification"
      );
    }

    await withDeadline(this.server.close(), CLIENT_WRITE_DEADLINE_MS, "the transport close");

    this.persistence?.destroy();
    process.exitCode = this.lastExitCode;

    try {
      await flushStderr();
    } catch {
      // ignore stderr flush errors
    } finally {
      clearTimeout(forceExitTimer);
    }
  }

  /** Remove stdin listeners to avoid re-entrant calls */
  private detachStdinListeners(): void {
    if (typeof process.stdin.off === "function") {
      process.stdin.off("error", this.handleStdinError);
      process.stdin.off("end", this.onStdinEnd);
      process.stdin.off("close", this.onStdinClose);
    }
  }

  /**
   * The disk comes first, and synchronously. A shutdown usually starts because
   * the client went away, and every write to that client from here on can block
   * for as long as the kernel buffer stays full: an MCP notification sent
   * afterwards would take the record of these sessions down with it.
   */
  private writeSessionsDown(): void {
    try {
      this.sessionManager.finalizeForShutdown();
    } catch (err) {
      console.error("[codex-mcp] Failed to write the sessions down on shutdown:", err);
    }
  }

  private sendStopping(
    reason: string,
    activeSessions: number,
    totalSessions: number
  ): Promise<unknown> {
    return this.server.sendLoggingMessage({
      level: "info",
      data: {
        event: "server_stopping",
        reason,
        activeSessions,
        totalSessions,
      },
    });
  }

  private clearStdinShutdownTimer(): void {
    if (this.stdinShutdownTimer) {
      clearTimeout(this.stdinShutdownTimer);
      this.stdinShutdownTimer = undefined;
    }
  }

  private scheduleStdinTerminationCheck(): void {
    this.stdinShutdownTimer = setTimeout(this.evaluateStdinTermination, STDIN_SHUTDOWN_CHECK_MS);
    if (this.stdinShutdownTimer.unref) this.stdinShutdownTimer.unref();
  }

  private hasActiveSessions(): boolean {
    return this.sessionManager
      .listSessions()
      .some((s) => s.status === "running" || s.status === "waiting_approval");
  }

  private readonly evaluateStdinTermination = () => {
    if (this.closing || this.stdinClosedAt === undefined) return;

    const stdinUnavailable =
      process.stdin.destroyed || process.stdin.readableEnded || !process.stdin.readable;
    const elapsedMs = Date.now() - this.stdinClosedAt;
    const active = this.hasActiveSessions();
    const decision = decideStdinShutdown({
      stdinUnavailable,
      elapsedMs,
      maxWaitMs: STDIN_SHUTDOWN_MAX_WAIT_MS,
      hasActiveSessions: active,
    });

    if (decision === "clear") {
      // Stdin stream recovered — drop this shutdown attempt.
      this.stdinClosedAt = undefined;
      this.stdinClosedReason = undefined;
      return;
    }
    if (decision === "shutdown_now") {
      console.error("[codex-mcp] stdin closed with no active sessions — shutting down");
      void this.shutdown(`stdin_${this.stdinClosedReason ?? "closed"}`);
      return;
    }
    if (decision === "shutdown_timeout") {
      console.error(
        `[codex-mcp] stdin closed and drain period (${STDIN_SHUTDOWN_MAX_WAIT_MS}ms) elapsed — forcing shutdown`
      );
      void this.shutdown(`stdin_${this.stdinClosedReason ?? "closed"}_timeout`);
      return;
    }
    // decision === "reschedule": keep waiting
    if (active) {
      console.error(
        `[codex-mcp] stdin closed; ${this.sessionManager.getActiveSessionCount()} active session(s) — waiting up to ${STDIN_SHUTDOWN_MAX_WAIT_MS}ms (elapsed: ${elapsedMs}ms)`
      );
    }
    this.scheduleStdinTerminationCheck();
  };

  private handleStdinTerminated(event: "end" | "close"): void {
    if (this.closing) return;
    if (this.stdinClosedAt === undefined) {
      this.stdinClosedAt = Date.now();
      this.stdinClosedReason = event;
      console.error(`[codex-mcp] stdin ${event} observed — entering guarded shutdown checks`);
    }
    this.clearStdinShutdownTimer();
    this.scheduleStdinTerminationCheck();
  }
}

async function main(): Promise<void> {
  reportStdioPreflight();

  // Resolve and validate the codex executable before starting the server.
  // Throws immediately if env vars are misconfigured (e.g. both set, or path missing).
  checkDefaultCodexExecutableAvailability();
  const executable = getDefaultCodexExecutable();
  console.error(`[codex-mcp] codex binary: ${executable.command}`);

  // Open the state directory. A failure here leaves persistence undefined and is
  // reported on stderr by startDiskPersistence; the server serves requests without it.
  const { persistence, recovered, pruned } = startDiskPersistence();
  reportRecoveredSessions(recovered, pruned);

  const serverCwd = process.cwd();
  const ctx = createServer(serverCwd, { persistence });
  const server = ctx.server;
  const sessionManager = ctx.sessionManager;

  // Take into memory the sessions no other running server holds.
  if (recovered.length > 0) {
    sessionManager.ingestRecovered(recovered);
  }

  const transport = new StdioServerTransport();

  const lifecycle = new ServerLifecycle(server, sessionManager, persistence);
  lifecycle.installProcessHandlers();

  await server.connect(transport);
  console.error(`codex-mcp server started (cwd: ${serverCwd})`);

  await reapAdoptedOrphans(recovered);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
