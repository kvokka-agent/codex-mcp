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
