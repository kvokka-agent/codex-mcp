import { describe, expect, it, vi } from "vitest";
import {
  buildExecutionInfo,
  coerceProgressForStatus,
  interactionStateForStatus,
  recommendedNextActionForStatus,
  waitForCodexSessionForegroundResult,
} from "../src/utils/execution.js";
import type { SessionManager } from "../src/session/manager.js";
import type { ProgressInfo, SessionStatus } from "../src/types.js";

interface FakeManagerParts {
  statuses?: SessionStatus[];
  getSession?: (sessionId: string) => { status: SessionStatus };
  getLastResult?: (sessionId: string) => unknown;
  getPendingActionTypes?: (sessionId: string) => Array<"approval" | "user_input">;
  waitForChange?: (sessionId: string, timeoutMs: number, signal?: AbortSignal) => Promise<unknown>;
}

/** Minimal stand-in for the SessionManager dependency (not the unit under test). */
function fakeManager(parts: FakeManagerParts): SessionManager {
  const statuses = parts.statuses ? [...parts.statuses] : [];
  return {
    getSession:
      parts.getSession ??
      (() => ({ status: statuses.length > 1 ? statuses.shift()! : statuses[0]! })),
    getLastResult: parts.getLastResult ?? (() => undefined),
    getPendingActionTypes: parts.getPendingActionTypes ?? (() => []),
    waitForChange: parts.waitForChange ?? (async () => undefined),
  } as unknown as SessionManager;
}

describe("interactionStateForStatus", () => {
  it("maps every status to its interaction state", () => {
    expect(interactionStateForStatus("waiting_approval")).toBe("waiting_input");
    expect(interactionStateForStatus("idle")).toBe("finished");
    expect(interactionStateForStatus("error")).toBe("finished");
    expect(interactionStateForStatus("cancelled")).toBe("finished");
    expect(interactionStateForStatus("running")).toBe("working");
  });
});

describe("recommendedNextActionForStatus", () => {
  it("prefers user input over approval while waiting", () => {
    expect(recommendedNextActionForStatus("waiting_approval", ["approval", "user_input"])).toBe(
      "respond_user_input"
    );
  });

  it("asks for a permission answer when only an approval is pending", () => {
    expect(recommendedNextActionForStatus("waiting_approval", ["approval"])).toBe(
      "respond_permission"
    );
  });

  it("falls back to polling when waiting without a known pending action", () => {
    expect(recommendedNextActionForStatus("waiting_approval")).toBe("poll");
  });

  it("asks for nothing on a terminal status and to poll while running", () => {
    expect(recommendedNextActionForStatus("idle")).toBe("none");
    expect(recommendedNextActionForStatus("cancelled")).toBe("none");
    expect(recommendedNextActionForStatus("running")).toBe("poll");
  });
});

describe("buildExecutionInfo", () => {
  it("reports foreground when a wait was requested and the session finished", () => {
    expect(buildExecutionInfo(1_000, "idle")).toEqual({
      requested: "foreground",
      effective: "foreground",
      waitForResultMs: 1_000,
      fallbackReason: undefined,
    });
  });

  it("degrades to background and keeps the fallback reason when the session is still running", () => {
    expect(buildExecutionInfo(1_000, "running", "wait_for_result_timeout")).toEqual({
      requested: "foreground",
      effective: "background",
      waitForResultMs: 1_000,
      fallbackReason: "wait_for_result_timeout",
    });
  });

  it("treats a missing or non-positive wait as a background request", () => {
    expect(buildExecutionInfo(undefined, "idle")).toEqual({
      requested: "background",
      effective: "background",
      waitForResultMs: undefined,
      fallbackReason: undefined,
    });
    expect(buildExecutionInfo(0, "idle", "interactive_poll_required")).toEqual({
      requested: "background",
      effective: "background",
      waitForResultMs: undefined,
      fallbackReason: "interactive_poll_required",
    });
  });
});

describe("coerceProgressForStatus", () => {
  const progress: ProgressInfo = {
    phase: "running",
    lastEventAt: "2024-01-01T00:00:00.000Z",
    pendingActionCount: 2,
  };

  it("returns undefined without a progress object", () => {
    expect(coerceProgressForStatus("idle", undefined)).toBeUndefined();
  });

  it("forces the phase to match a terminal status and clears pending actions", () => {
    expect(coerceProgressForStatus("idle", progress)).toMatchObject({
      phase: "finished",
      pendingActionCount: 0,
    });
    expect(coerceProgressForStatus("error", progress)).toMatchObject({ phase: "error" });
    expect(coerceProgressForStatus("cancelled", progress)).toMatchObject({ phase: "cancelled" });
  });

  it("keeps the highest pending action count while waiting for approval", () => {
    expect(
      coerceProgressForStatus("waiting_approval", progress, { pendingActionCount: 5 })
    ).toMatchObject({ phase: "waiting_approval", pendingActionCount: 5 });
    expect(
      coerceProgressForStatus("waiting_approval", progress, { pendingActionCount: 1 })
    ).toMatchObject({ pendingActionCount: 2 });
  });

  it("keeps the reported phase and pending count while running", () => {
    expect(coerceProgressForStatus("running", progress)).toEqual({
      phase: "running",
      lastEventAt: "2024-01-01T00:00:00.000Z",
      pendingActionCount: 2,
    });
  });

  it("overrides lastEventAt with the completion timestamp when given", () => {
    expect(
      coerceProgressForStatus("idle", progress, { completedAt: "2024-02-02T00:00:00.000Z" })
    ).toMatchObject({ lastEventAt: "2024-02-02T00:00:00.000Z" });
  });
});

describe("waitForCodexSessionForegroundResult", () => {
  it("returns the stored result as soon as the session is terminal", async () => {
    const result = { completedAt: "2024-03-03T00:00:00.000Z", text: "done" };
    const manager = fakeManager({
      statuses: ["idle"],
      getLastResult: () => result,
    });

    const out = await waitForCodexSessionForegroundResult(manager, "sess_1", 5_000);
    expect(out).toEqual({
      status: "idle",
      result,
      completedAt: "2024-03-03T00:00:00.000Z",
    });
  });

  it("falls back to the current time when the result carries no completion timestamp", async () => {
    const manager = fakeManager({ statuses: ["error"], getLastResult: () => undefined });
    const out = await waitForCodexSessionForegroundResult(manager, "sess_1", 5_000);
    expect(out.status).toBe("error");
    expect(out.result).toBeUndefined();
    expect(Number.isNaN(Date.parse(out.completedAt!))).toBe(false);
  });

  it("reports the error status when the session lookup throws", async () => {
    const manager = fakeManager({
      getSession: () => {
        throw new Error("gone");
      },
    });
    const out = await waitForCodexSessionForegroundResult(manager, "sess_1", 5_000);
    expect(out.status).toBe("error");
  });

  it("returns the pending action types when the session waits for approval", async () => {
    const manager = fakeManager({
      statuses: ["waiting_approval"],
      getPendingActionTypes: () => ["approval"],
    });
    const out = await waitForCodexSessionForegroundResult(manager, "sess_1", 5_000);
    expect(out).toEqual({
      status: "waiting_approval",
      pendingActionTypes: ["approval"],
      fallbackReason: "interactive_poll_required",
    });
  });

  it("polls until the session becomes terminal", async () => {
    const waitForChange = vi.fn(async () => undefined);
    const manager = fakeManager({
      statuses: ["running", "running", "idle"],
      waitForChange,
      getLastResult: () => ({ completedAt: "2024-04-04T00:00:00.000Z" }),
    });

    const out = await waitForCodexSessionForegroundResult(manager, "sess_1", 5_000);
    expect(out.status).toBe("idle");
    expect(out.completedAt).toBe("2024-04-04T00:00:00.000Z");
    expect(waitForChange).toHaveBeenCalledTimes(2);
    expect(waitForChange.mock.calls[0]![0]).toBe("sess_1");
  });

  it("passes the abort signal down to waitForChange and reports the timeout fallback", async () => {
    const controller = new AbortController();
    const waitForChange = vi.fn(async () => {
      throw new Error("aborted");
    });
    const manager = fakeManager({ statuses: ["running"], waitForChange });

    const out = await waitForCodexSessionForegroundResult(
      manager,
      "sess_1",
      5_000,
      controller.signal
    );
    expect(out).toEqual({ status: "running", fallbackReason: "wait_for_result_timeout" });
    expect(waitForChange.mock.calls[0]![2]).toBe(controller.signal);
  });

  it("caps the per-iteration wait at five seconds", async () => {
    const waitForChange = vi.fn(async () => undefined);
    const manager = fakeManager({ statuses: ["running", "idle"], waitForChange });
    await waitForCodexSessionForegroundResult(manager, "sess_1", 120_000);
    expect(waitForChange.mock.calls[0]![1]).toBe(5_000);
  });

  it("skips the loop entirely when the requested wait already elapsed", async () => {
    const waitForChange = vi.fn(async () => undefined);
    const manager = fakeManager({ statuses: ["running"], waitForChange });
    const out = await waitForCodexSessionForegroundResult(manager, "sess_1", 0);
    expect(waitForChange).not.toHaveBeenCalled();
    expect(out).toEqual({ status: "running", fallbackReason: "wait_for_result_timeout" });
  });
});
