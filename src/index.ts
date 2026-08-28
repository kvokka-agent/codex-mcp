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
import { startDiskPersistence } from "./session/persistence.js";
import { reapOrphanProcesses } from "./session/orphan-reaper.js";
import { decideStdinShutdown } from "./utils/stdin-shutdown.js";

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

  // Open the state directory. A failure here leaves persistence undefined and is
  // reported on stderr by startDiskPersistence; the server serves requests without it.
  const { persistence, recovered, pruned } = startDiskPersistence();
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

  const serverCwd = process.cwd();
  const ctx = createServer(serverCwd, {
    createClient,
    clientMode,
    persistence,
  });
  const server = ctx.server;
  const sessionManager = ctx.sessionManager;

  // Take into memory the sessions no other running server holds.
  if (recovered.length > 0) {
    sessionManager.ingestRecovered(recovered);
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
  const reapAdoptedOrphans = async (): Promise<void> => {
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
  };

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

    // The disk comes first, and synchronously. A shutdown usually starts because
    // the client went away, and every write to that client from here on can block
    // for as long as the kernel buffer stays full: an MCP notification sent
    // afterwards would take the record of these sessions down with it.
    try {
      sessionManager.finalizeForShutdown();
    } catch (err) {
      console.error("[codex-mcp] Failed to write the sessions down on shutdown:", err);
    }

    if (server.isConnected()) {
      await withDeadline(
        server.sendLoggingMessage({
          level: "info",
          data: {
            event: "server_stopping",
            reason,
            activeSessions: runningCount,
            totalSessions: activeSessions.length,
          },
        }),
        CLIENT_WRITE_DEADLINE_MS,
        "the server_stopping notification"
      );
    }

    await withDeadline(server.close(), CLIENT_WRITE_DEADLINE_MS, "the transport close");

    persistence?.destroy();
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
    const decision = decideStdinShutdown({
      stdinUnavailable,
      elapsedMs,
      maxWaitMs: STDIN_SHUTDOWN_MAX_WAIT_MS,
      hasActiveSessions: active,
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
  // `beforeExit` fires with an empty event loop: nothing is left to serve, so the
  // sessions are written down before the process goes. `server.isConnected()`
  // cannot gate this — the stdio transport reports itself connected for the life
  // of the process — and `shutdown` runs once whatever calls it.
  process.on("beforeExit", () => void shutdown("beforeExit"));
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

  await reapAdoptedOrphans();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
