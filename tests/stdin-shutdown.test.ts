import { describe, expect, it } from "vitest";
import { decideStdinShutdown } from "../src/utils/stdin-shutdown.js";

const base = {
  stdinUnavailable: true,
  elapsedMs: 0,
  maxWaitMs: 10_000,
  hasActiveSessions: false,
};

describe("decideStdinShutdown", () => {
  it("clears the pending shutdown while stdin is available", () => {
    expect(decideStdinShutdown({ ...base, stdinUnavailable: false })).toBe("clear");
  });

  it("shuts down on an ended stdin whatever the transport reports about itself", () => {
    // StdioServerTransport never hears the end of stdin, so isConnected() stays
    // true for the life of the process and cannot gate this decision.
    expect(decideStdinShutdown({ ...base, hasActiveSessions: false, elapsedMs: 999_999 })).toBe(
      "shutdown_now"
    );
  });

  it("shuts down immediately when no session is active", () => {
    expect(decideStdinShutdown(base)).toBe("shutdown_now");
  });

  it("waits while active sessions remain inside the grace window", () => {
    expect(decideStdinShutdown({ ...base, hasActiveSessions: true, elapsedMs: 9_999 })).toBe(
      "reschedule"
    );
  });

  it("shuts down on timeout once the grace window elapsed", () => {
    expect(decideStdinShutdown({ ...base, hasActiveSessions: true, elapsedMs: 10_000 })).toBe(
      "shutdown_timeout"
    );
  });

  it("prefers the availability check over every other input", () => {
    expect(
      decideStdinShutdown({
        stdinUnavailable: false,
        elapsedMs: 10_000,
        maxWaitMs: 1,
        hasActiveSessions: true,
      })
    ).toBe("clear");
  });
});
