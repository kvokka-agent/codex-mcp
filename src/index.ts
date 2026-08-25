/**
 * codex-mcp — MCP server entry point
 *
 * Starts the MCP server with stdio transport.
 * Spawns codex app-server child processes for each session,
 * or falls back to codex exec --json when app-server is unavailable.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import type { ICodexClient } from "./app-server/client-interface.js";
import { AppServerClient } from "./app-server/client.js";
import { detectClientMode } from "./app-server/detect.js";
import { ExecClient } from "./app-server/exec-client.js";
import { runStdioPreflight } from "./utils/stdio-guard.js";
import {
  checkDefaultCodexExecutableAvailability,
  getDefaultCodexExecutable,
} from "./utils/codex-executable.js";
import { SessionPersistence } from "./session/persistence.js";
import { reapOrphanProcesses } from "./session/orphan-reaper.js";
import { decideStdinShutdown } from "./utils/stdin-shutdown.js";

const STDIN_SHUTDOWN_CHECK_MS = 750;
const STDIN_SHUTDOWN_MAX_WAIT_MS = process.platform === "win32" ? 15_000 : 10_000;

async function main(): Promise<void> {
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

  // Resolve and validate the codex executable before starting the server.
  // Throws immediately if env vars are misconfigured (e.g. both set, or path missing).
  checkDefaultCodexExecutableAvailability();
  const executable = getDefaultCodexExecutable();
  const clientMode = await detectClientMode(executable.command, executable.isPath);
  console.error(`[codex-mcp] client mode: ${clientMode} (binary: ${executable.command})`);
  const createClient = (): ICodexClient =>
    clientMode === "exec" ? new ExecClient() : new AppServerClient();

  // Initialize disk persistence
  const persistence = new SessionPersistence();
  try {
    persistence.acquireLock();
    console.error("[codex-mcp] STATE_DIR lock acquired");
  } catch (err) {
    console.error("[codex-mcp] WARNING: Failed to acquire STATE_DIR lock:", err);
  }

  // Recover sessions from disk and prune old ones
  const recovered = persistence.recoverSessions();
  if (recovered.length > 0) {
    console.error(`[codex-mcp] Recovered ${recovered.length} session(s) from disk`);
  }
  const pruned = persistence.prune();
  if (pruned > 0) {
    console.error(`[codex-mcp] Pruned ${pruned} old session(s)`);
  }

  // Reap any orphaned child processes from the previous server run.
  const reaped = await reapOrphanProcesses(recovered);
  if (reaped.reaped > 0) console.error(`[codex-mcp] Reaped ${reaped.reaped} orphan process(es)`);

  const serverCwd = process.cwd();
  const ctx = createServer(serverCwd, {
    createClient,
    clientMode,
    persistence,
  });
  const server = ctx.server;
  const sessionManager = ctx.sessionManager;

  // Ingest recovered sessions into the in-memory session manager
  if (recovered.length > 0) {
    sessionManager.ingestRecovered(recovered);
  }

  const transport = new StdioServerTransport();

  // ── Graceful shutdown state ────────────────────────────────────────
  let closing = false;
  let lastExitCode = 0;
  let stdinClosedAt: number | undefined;
  let stdinClosedReason: "end" | "close" | undefined;
  let stdinShutdownTimer: ReturnType<typeof setTimeout> | undefined;

  const onStdinEnd = () => handleStdinTerminated("end");
  const onStdinClose = () => handleStdinTerminated("close");

  const clearStdinShutdownTimer = () => {
    if (stdinShutdownTimer) {
      clearTimeout(stdinShutdownTimer);
      stdinShutdownTimer = undefined;
    }
  };

  function hasActiveSessions(): boolean {
    return sessionManager
      .listSessions()
      .some((s) => s.status === "running" || s.status === "waiting_approval");
  }

  const shutdown = async (reason = "unknown") => {
    if (closing) return;
    closing = true;
    clearStdinShutdownTimer();
    // Remove stdin listeners to avoid re-entrant calls
    if (typeof process.stdin.off === "function") {
      process.stdin.off("error", handleStdinError);
      process.stdin.off("end", onStdinEnd);
      process.stdin.off("close", onStdinClose);
    }

    // Set a hard force-exit timer in case cleanup hangs
    const forceExitMs = process.platform === "win32" ? 10_000 : 5_000;
    const forceExitTimer = setTimeout(() => process.exit(lastExitCode), forceExitMs);
    if (forceExitTimer.unref) forceExitTimer.unref();

    const activeSessions = sessionManager.listSessions();
    const runningCount = activeSessions.filter(
      (s) => s.status === "running" || s.status === "waiting_approval"
    ).length;

    console.error(
      `[codex-mcp] shutdown triggered (reason=${reason}, activeSessions=${runningCount}, total=${activeSessions.length})`
    );

    try {
      if (server.isConnected()) {
        await server.sendLoggingMessage({
          level: "info",
          data: {
            event: "server_stopping",
            reason,
            activeSessions: runningCount,
            totalSessions: activeSessions.length,
          },
        });
      }
    } catch {
      // ignore — client may not support logging notifications
    }

    try {
      // Flush persistence and release lock before server close
      persistence.flushAll();
      persistence.releaseLockIfHeld();
    } catch {
      // best-effort
    }

    try {
      await server.close();
    } catch {
      // Ignore close errors during shutdown
    }

    persistence.destroy();
    process.exitCode = lastExitCode;

    try {
      await new Promise<void>((resolve) => process.stderr.write("", () => resolve()));
    } catch {
      // ignore stderr flush errors
    } finally {
      clearTimeout(forceExitTimer);
    }
  };

  function handleStdinError(error: Error) {
    console.error("[codex-mcp] stdin error:", error);
    lastExitCode = 1;
    void shutdown("stdin_error");
  }

  const evaluateStdinTermination = () => {
    if (closing || stdinClosedAt === undefined) return;

    const stdinUnavailable =
      process.stdin.destroyed || process.stdin.readableEnded || !process.stdin.readable;
    const elapsedMs = Date.now() - stdinClosedAt;
    const active = hasActiveSessions();
    const connected = server.isConnected();

    const decision = decideStdinShutdown({
      stdinUnavailable,
      elapsedMs,
      maxWaitMs: STDIN_SHUTDOWN_MAX_WAIT_MS,
      hasActiveSessions: active,
      isConnected: connected,
    });

    if (decision === "clear") {
      // Stdin stream recovered — drop this shutdown attempt.
      stdinClosedAt = undefined;
      stdinClosedReason = undefined;
      return;
    }
    if (decision === "shutdown_now") {
      console.error("[codex-mcp] stdin closed with no active sessions — shutting down");
      void shutdown(`stdin_${stdinClosedReason ?? "closed"}`);
      return;
    }
    if (decision === "shutdown_timeout") {
      console.error(
        `[codex-mcp] stdin closed and drain period (${STDIN_SHUTDOWN_MAX_WAIT_MS}ms) elapsed — forcing shutdown`
      );
      void shutdown(`stdin_${stdinClosedReason ?? "closed"}_timeout`);
      return;
    }
    // decision === "reschedule": keep waiting
    if (active) {
      console.error(
        `[codex-mcp] stdin closed; ${sessionManager.getActiveSessionCount()} active session(s) — waiting up to ${STDIN_SHUTDOWN_MAX_WAIT_MS}ms (elapsed: ${elapsedMs}ms)`
      );
    }
    stdinShutdownTimer = setTimeout(evaluateStdinTermination, STDIN_SHUTDOWN_CHECK_MS);
    if (stdinShutdownTimer.unref) stdinShutdownTimer.unref();
  };

  function handleStdinTerminated(event: "end" | "close") {
    if (closing) return;
    if (stdinClosedAt === undefined) {
      stdinClosedAt = Date.now();
      stdinClosedReason = event;
      console.error(`[codex-mcp] stdin ${event} observed — entering guarded shutdown checks`);
    }
    clearStdinShutdownTimer();
    stdinShutdownTimer = setTimeout(evaluateStdinTermination, STDIN_SHUTDOWN_CHECK_MS);
    if (stdinShutdownTimer.unref) stdinShutdownTimer.unref();
  }

  const handleUnexpectedError = (error: unknown) => {
    console.error("[codex-mcp] Unhandled runtime error:", error);
    lastExitCode = 1;
    void shutdown("runtime_error");
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  // Windows: Ctrl+Break / console close scenarios.
  process.on("SIGBREAK", () => void shutdown("SIGBREAK"));
  process.on("beforeExit", () => {
    // Do not eagerly shutdown while transport still appears connected.
    if (!server.isConnected()) {
      void shutdown("beforeExit");
    }
  });
  process.on("uncaughtException", handleUnexpectedError);
  process.on("unhandledRejection", handleUnexpectedError);

  // Keep stdin alive so the MCP stdio transport continues to receive frames.
  if (typeof process.stdin.resume === "function") {
    process.stdin.resume();
  }
  process.stdin.on("error", handleStdinError);
  // Guarded shutdown: some clients can transiently trigger stdio close-like signals.
  // We only exit after checking connection/session state.
  process.stdin.on("end", onStdinEnd);
  process.stdin.on("close", onStdinClose);

  await server.connect(transport);
  console.error(`codex-mcp server started (cwd: ${serverCwd})`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
