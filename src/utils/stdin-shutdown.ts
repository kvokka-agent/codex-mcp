export type StdinShutdownDecision = "clear" | "shutdown_now" | "shutdown_timeout" | "reschedule";

/**
 * What to do about a stdin that reported `end` or `close`.
 *
 * On stdio there is one client and it sits on the other end of this pipe, so a
 * stdin that has really ended is the end of the session: no frame can arrive
 * again, whatever the transport still says about itself. What the transport
 * says is therefore not consulted — `StdioServerTransport` subscribes to
 * neither `end` nor `close`, so `isConnected()` answers true for as long as the
 * process lives, and a shutdown gated on it never happens.
 *
 * A transient close-like signal is caught by `stdinUnavailable` instead: a
 * stream that is readable again clears the shutdown.
 *
 * Sessions still running are given `maxWaitMs` to reach an end of their own
 * before the process goes down on them.
 */
export function decideStdinShutdown(params: {
  stdinUnavailable: boolean;
  elapsedMs: number;
  maxWaitMs: number;
  hasActiveSessions: boolean;
}): StdinShutdownDecision {
  if (!params.stdinUnavailable) return "clear";
  if (!params.hasActiveSessions) return "shutdown_now";
  if (params.elapsedMs >= params.maxWaitMs) return "shutdown_timeout";
  return "reschedule";
}

/**
 * A stdin that can deliver no further frame.
 *
 * The three flags are read together because each of them alone is reached by a
 * different end: `destroyed` by a teardown, `readableEnded` by an EOF the stream
 * already delivered, `readable` by one it has yet to report.
 */
export function stdinIsUnavailable(stdin: {
  destroyed: boolean;
  readableEnded: boolean;
  readable: boolean;
}): boolean {
  return stdin.destroyed || stdin.readableEnded || !stdin.readable;
}

/** What a stdin shutdown says on stderr, and the reason it is recorded under. */
interface StdinShutdownOrder {
  message: string;
  reason: string;
}

/**
 * The order a shutdown decision carries out: the line the operator reads, and the reason
 * the shutdown is recorded under — the stdin event that started it, marked `_timeout`
 * when the drain period ran out before the sessions ended.
 */
export function stdinShutdownOrder(
  decision: "shutdown_now" | "shutdown_timeout",
  closedReason: string | undefined,
  maxWaitMs: number
): StdinShutdownOrder {
  const event = closedReason ?? "closed";
  if (decision === "shutdown_timeout") {
    return {
      message: `[codex-mcp] stdin closed and drain period (${maxWaitMs}ms) elapsed — forcing shutdown`,
      reason: `stdin_${event}_timeout`,
    };
  }
  return {
    message: "[codex-mcp] stdin closed with no active sessions — shutting down",
    reason: `stdin_${event}`,
  };
}
