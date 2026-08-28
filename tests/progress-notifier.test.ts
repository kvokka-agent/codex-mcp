/**
 * ProgressReporter: what a held tool call tells the client while it waits.
 *
 * Every asserted value is a notification the reporter produced, captured by the
 * send function it was built with.
 */
import { describe, expect, it, vi } from "vitest";
import {
  ProgressReporter,
  progressReporterFor,
  type ProgressNotification,
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
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
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
