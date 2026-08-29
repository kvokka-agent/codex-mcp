/**
 * ProgressReporter: what a held tool call tells the client while it waits.
 *
 * Every asserted value is a notification the reporter produced, captured by the
 * send function it was built with.
 */
import { describe, expect, it, jest } from "bun:test";
import { PROGRESS_HEARTBEAT_MS, type ProgressInfo } from "../src/types.js";
import {
  activityLine,
  formatDuration,
  heartbeatIntervalMs,
  type ProgressNotification,
  ProgressReporter,
  progressReporterFor,
} from "../src/utils/progress-notifier.js";

function capture(): {
  sent: ProgressNotification[];
  send: (n: ProgressNotification) => Promise<void>;
} {
  const sent: ProgressNotification[] = [];
  return {
    sent,
    send: async (n) => {
      sent.push(n);
    },
  };
}

describe("ProgressReporter", () => {
  it("sends one notification per line, counting up", () => {
    const { sent, send } = capture();
    const reporter = new ProgressReporter("tok-1", send);

    reporter.report("Читаю тест");
    reporter.report("Правлю манифест");

    expect(sent.map((n) => n.method)).toEqual(["notifications/progress", "notifications/progress"]);
    expect(sent.map((n) => n.params.message)).toEqual(["Читаю тест", "Правлю манифест"]);
    expect(sent.map((n) => n.params.progress)).toEqual([1, 2]);
    expect(sent.every((n) => n.params.progressToken === "tok-1")).toBe(true);
    // How many activities a turn has left is not knowable, so no total is claimed.
    expect(sent.every((n) => n.params.total === undefined)).toBe(true);
  });

  it("says nothing twice, and nothing about an empty line", () => {
    const { sent, send } = capture();
    const reporter = new ProgressReporter(7, send);

    reporter.report("Читаю тест");
    reporter.report("Читаю тест");
    reporter.report("   ");
    reporter.report("");

    expect(sent).toHaveLength(1);
    expect(reporter.count).toBe(1);
  });

  it("survives a client that refuses the notification", async () => {
    const stderr = jest.spyOn(console, "error").mockImplementation(() => {});
    const reporter = new ProgressReporter("tok-1", async () => {
      throw new Error("connection closed");
    });

    expect(() => reporter.report("Читаю тест")).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();

    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("connection closed"));
    stderr.mockRestore();
  });
});

describe("progressReporterFor", () => {
  it("reports to a request that asked for progress", () => {
    const { sent, send } = capture();
    const reporter = progressReporterFor({ progressToken: "tok-9" }, send);

    reporter?.report("Читаю тест");

    expect(sent[0]?.params.progressToken).toBe("tok-9");
  });

  it("builds nothing for a request that carried no token", () => {
    const { send } = capture();
    expect(progressReporterFor(undefined, send)).toBeUndefined();
    expect(progressReporterFor({}, send)).toBeUndefined();
    expect(progressReporterFor({ progressToken: "tok-9" }, undefined)).toBeUndefined();
  });
});

describe("formatDuration", () => {
  it("reads in seconds under a minute and in whole minutes above it", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(59_999)).toBe("59s");
    expect(formatDuration(60_000)).toBe("1m");
    expect(formatDuration(15 * 60_000)).toBe("15m");
    expect(formatDuration(60 * 60_000)).toBe("1h");
    expect(formatDuration(95 * 60_000)).toBe("1h 35m");
  });

  it("reports a negative reading as none elapsed", () => {
    expect(formatDuration(-5_000)).toBe("0s");
  });
});

describe("activityLine", () => {
  const base: ProgressInfo = { phase: "acting", lastEventAt: "", pendingActionCount: 0 };

  it("says what the turn is doing and how long it has been on it", () => {
    expect(
      activityLine({ ...base, activity: "Собираю проект", activityStandingMs: 900_000 }, 5)
    ).toBe("Собираю проект — 15m");
  });

  it("falls back to the phase and to how long the call has been held", () => {
    // Codex has written no marker yet: the phase is what is actually known.
    expect(activityLine(base, 30_000)).toBe("acting — 30s");
  });
});

describe("heartbeatIntervalMs", () => {
  it("takes the interval from the environment", () => {
    expect(heartbeatIntervalMs({ CODEX_MCP_PROGRESS_HEARTBEAT_MS: "5000" })).toBe(5_000);
  });

  it("defaults when the variable says nothing", () => {
    expect(heartbeatIntervalMs({})).toBe(PROGRESS_HEARTBEAT_MS);
  });

  it("sends no heartbeat for zero and for a value it cannot read", () => {
    expect(heartbeatIntervalMs({ CODEX_MCP_PROGRESS_HEARTBEAT_MS: "0" })).toBe(0);
    expect(heartbeatIntervalMs({ CODEX_MCP_PROGRESS_HEARTBEAT_MS: "soon" })).toBe(0);
    expect(heartbeatIntervalMs({ CODEX_MCP_PROGRESS_HEARTBEAT_MS: "-1" })).toBe(0);
  });
});
