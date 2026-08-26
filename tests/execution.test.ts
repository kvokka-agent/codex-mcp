import { describe, expect, it, vi } from "vitest";
import {
  buildExecutionInfo,
  coerceProgressForStatus,
  interactionStateForStatus,
  recommendedNextActionForStatus,
  waitForCodexSessionForegroundResult,
} from "../src/utils/execution.js";
import type { SessionManager } from "../src/session/manager.js";
import { ErrorCode, type ProgressInfo, type SessionStatus } from "../src/types.js";

interface FakeManagerParts {
  statuses?: SessionStatus[];
  getSession?: (sessionId: string) => { status: SessionStatus };
  consumeTurnResult?: (sessionId: string) => unknown;
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
    consumeTurnResult: parts.consumeTurnResult ?? (() => undefined),
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
      consumeTurnResult: () => result,
    });

    const out = await waitForCodexSessionForegroundResult(manager, "sess_1", 5_000);
    expect(out).toEqual({
      status: "idle",
      result,
      completedAt: "2024-03-03T00:00:00.000Z",
    });
  });

  it("falls back to the current time when the result carries no completion timestamp", async () => {
    const manager = fakeManager({ statuses: ["error"], consumeTurnResult: () => undefined });
    const out = await waitForCodexSessionForegroundResult(manager, "sess_1", 5_000);
    expect(out.status).toBe("error");
    expect(out.result).toBeUndefined();
    expect(Number.isNaN(Date.parse(out.completedAt!))).toBe(false);
  });

  it("lets a session evicted mid-wait reach the caller as the lookup error", async () => {
    // A status invented here would claim the turn ended, and consumeTurnResult would throw the same
    // error one line down anyway.
    const manager = fakeManager({
      getSession: () => {
        throw new Error(`Error [${ErrorCode.SESSION_NOT_FOUND}]: Session 'sess_1' not found`);
      },
      consumeTurnResult: () => {
        throw new Error("consumeTurnResult must not be reached for a session that is gone");
      },
    });

    await expect(waitForCodexSessionForegroundResult(manager, "sess_1", 5_000)).rejects.toThrow(
      ErrorCode.SESSION_NOT_FOUND
    );
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
      consumeTurnResult: () => ({ completedAt: "2024-04-04T00:00:00.000Z" }),
    });

    const out = await waitForCodexSessionForegroundResult(manager, "sess_1", 5_000);
    expect(out.status).toBe("idle");
    expect(out.completedAt).toBe("2024-04-04T00:00:00.000Z");
    expect(waitForChange).toHaveBeenCalledTimes(2);
    expect(waitForChange.mock.calls[0]![0]).toBe("sess_1");
  });

  it("reports a refused wait as such instead of as an expired budget", async () => {
    // waitForChange resolves on timeout, abort and change alike; it rejects only when the
    // session already holds the maximum number of waiters, and that happens immediately.
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const waitForChange = vi.fn(async () => {
      throw new Error("[codex-mcp] Too many concurrent long-poll waiters for session 'sess_1'");
    });
    const manager = fakeManager({ statuses: ["running"], waitForChange });

    const started = Date.now();
    const out = await waitForCodexSessionForegroundResult(manager, "sess_1", 120_000);

    expect(out).toEqual({ status: "running", fallbackReason: "wait_refused" });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(waitForChange).toHaveBeenCalledTimes(1);
    expect(errors.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
      "Foreground wait refused for session 'sess_1': [codex-mcp] Too many concurrent long-poll waiters"
    );
    errors.mockRestore();
  });

  it("passes the abort signal down and stops waiting once the caller aborts", async () => {
    const controller = new AbortController();
    // An aborted signal makes the real waitForChange resolve at once, so a loop that ignored the
    // abort would spin until the deadline.
    const waitForChange = vi.fn(async () => {
      controller.abort();
    });
    const manager = fakeManager({ statuses: ["running"], waitForChange });

    const out = await waitForCodexSessionForegroundResult(
      manager,
      "sess_1",
      120_000,
      controller.signal
    );

    expect(waitForChange).toHaveBeenCalledTimes(1);
    expect(waitForChange.mock.calls[0]![2]).toBe(controller.signal);
    // The wait ended because the caller left, so no reason is claimed for it.
    expect(out).toEqual({ status: "running" });
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
