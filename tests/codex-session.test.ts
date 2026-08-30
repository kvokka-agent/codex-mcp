import { describe, expect, it, jest } from "bun:test";
import type { SessionManager } from "../src/session/manager/session-manager.js";
import { executeCodexSession } from "../src/tools/codex-session.js";
import type { SessionAction } from "../src/types/index.js";

describe("executeCodexSession", () => {
  it("lists every session of the state directory, not only the ones in memory", async () => {
    const listAllSessions = jest.fn(() => [
      { sessionId: "sess_1", status: "idle", owner: { pid: 1, state: "self" } },
      { sessionId: "sess_2", status: "abandoned", activity: "Reading src/index.ts" },
    ]);
    const sessionManager = { listAllSessions } as unknown as SessionManager;

    const result = await executeCodexSession({ action: "list" }, sessionManager);
    expect(result).toEqual({
      sessions: [
        { sessionId: "sess_1", status: "idle", owner: { pid: 1, state: "self" } },
        { sessionId: "sess_2", status: "abandoned", activity: "Reading src/index.ts" },
      ],
    });
  });

  it("resumes a session by id and refuses the action without one", async () => {
    const resumeSession = jest.fn(async () => ({
      sessionId: "sess_1",
      threadId: "thr_1",
      status: "idle" as const,
      pollInterval: 120_000,
    }));
    const sessionManager = { resumeSession } as unknown as SessionManager;

    await expect(
      executeCodexSession({ action: "resume", sessionId: "sess_1" }, sessionManager)
    ).resolves.toEqual({
      sessionId: "sess_1",
      threadId: "thr_1",
      status: "idle",
      pollInterval: 120_000,
    });
    expect(resumeSession).toHaveBeenCalledWith("sess_1");

    await expect(executeCodexSession({ action: "resume" }, sessionManager)).resolves.toEqual(
      expect.objectContaining({ isError: true, error: expect.stringContaining("INVALID_ARGUMENT") })
    );
  });

  it("returns INVALID_ARGUMENT when sessionId is missing for required actions", async () => {
    const sessionManager = {} as SessionManager;

    await expect(executeCodexSession({ action: "get" }, sessionManager)).resolves.toEqual(
      expect.objectContaining({ isError: true, error: expect.stringContaining("INVALID_ARGUMENT") })
    );
    await expect(executeCodexSession({ action: "cancel" }, sessionManager)).resolves.toEqual(
      expect.objectContaining({ isError: true, error: expect.stringContaining("INVALID_ARGUMENT") })
    );
    await expect(executeCodexSession({ action: "interrupt" }, sessionManager)).resolves.toEqual(
      expect.objectContaining({ isError: true, error: expect.stringContaining("INVALID_ARGUMENT") })
    );
    await expect(executeCodexSession({ action: "fork" }, sessionManager)).resolves.toEqual(
      expect.objectContaining({ isError: true, error: expect.stringContaining("INVALID_ARGUMENT") })
    );
    await expect(
      executeCodexSession({ action: "clean_background_terminals" }, sessionManager)
    ).resolves.toEqual(
      expect.objectContaining({ isError: true, error: expect.stringContaining("INVALID_ARGUMENT") })
    );
    await expect(
      executeCodexSession({ action: "terminate_background_terminal" }, sessionManager)
    ).resolves.toEqual(
      expect.objectContaining({ isError: true, error: expect.stringContaining("INVALID_ARGUMENT") })
    );
  });

  it("steers a session and answers with the turn the steer joined", async () => {
    const steerSession = jest.fn(async () => ({
      sessionId: "sess_2",
      threadId: "thread_2",
      turnId: "turn_running",
      status: "running" as const,
      message: "Steered turn turn_running, which was already running: no turn started.",
    }));
    const sessionManager = { steerSession } as unknown as SessionManager;

    await expect(
      executeCodexSession(
        { action: "steer", sessionId: "sess_2", prompt: "not that directory" },
        sessionManager
      )
    ).resolves.toEqual({
      sessionId: "sess_2",
      threadId: "thread_2",
      turnId: "turn_running",
      status: "running",
      message: "Steered turn turn_running, which was already running: no turn started.",
    });
    expect(steerSession).toHaveBeenCalledWith("sess_2", "not that directory");
  });

  it("returns INVALID_ARGUMENT when steer names no prompt or no session", async () => {
    const steerSession = jest.fn();
    const sessionManager = { steerSession } as unknown as SessionManager;

    await expect(
      executeCodexSession({ action: "steer", sessionId: "sess_2" }, sessionManager)
    ).resolves.toEqual(
      expect.objectContaining({
        isError: true,
        error: expect.stringContaining("prompt required for 'steer'"),
      })
    );
    await expect(
      executeCodexSession({ action: "steer", prompt: "go left" }, sessionManager)
    ).resolves.toEqual(
      expect.objectContaining({ isError: true, error: expect.stringContaining("INVALID_ARGUMENT") })
    );
    expect(steerSession).not.toHaveBeenCalled();
  });

  it("returns INVALID_ARGUMENT when terminate_background_terminal names no processId", async () => {
    const terminateBackgroundTerminal = jest.fn();
    const sessionManager = { terminateBackgroundTerminal } as unknown as SessionManager;

    await expect(
      executeCodexSession(
        { action: "terminate_background_terminal", sessionId: "sess_2" },
        sessionManager
      )
    ).resolves.toEqual(
      expect.objectContaining({
        isError: true,
        error: expect.stringContaining("processId required"),
      })
    );
    expect(terminateBackgroundTerminal).not.toHaveBeenCalled();
  });

  it("hands the clean filters to SessionManager and answers with its report", async () => {
    const cleanSessions = jest.fn(async () => ({
      removed: [{ sessionId: "sess_old", status: "cancelled" as const, diskRemoved: true }],
      kept: [],
      dryRun: false,
    }));
    const sessionManager = { cleanSessions } as unknown as SessionManager;

    await expect(
      executeCodexSession(
        {
          action: "clean",
          statuses: ["cancelled"],
          olderThanMs: 600_000,
          dryRun: false,
          includeDisk: true,
        },
        sessionManager
      )
    ).resolves.toEqual({
      removed: [{ sessionId: "sess_old", status: "cancelled", diskRemoved: true }],
      kept: [],
      dryRun: false,
    });
    expect(cleanSessions).toHaveBeenCalledWith({
      statuses: ["cancelled"],
      olderThanMs: 600_000,
      dryRun: false,
      includeDisk: true,
    });
  });

  it("returns INVALID_ARGUMENT naming the action a caller off the schema asked for", async () => {
    const sessionManager = {} as SessionManager;

    await expect(
      executeCodexSession({ action: "restart" as SessionAction }, sessionManager)
    ).resolves.toEqual({
      error: "Error [INVALID_ARGUMENT]: Unknown action 'restart'",
      isError: true,
    });
  });

  it("delegates get/cancel/interrupt/fork/clean_background_terminals actions to SessionManager", async () => {
    const getSession = jest.fn(() => ({ sessionId: "sess_2", status: "running" }));
    const cancelSession = jest.fn(async () => {});
    const interruptSession = jest.fn(async () => {});
    const forkSession = jest.fn(async () => ({
      sessionId: "sess_fork",
      threadId: "thread_fork",
      status: "idle" as const,
      pollInterval: 120000,
    }));
    const cleanBackgroundTerminals = jest.fn(async () => ({
      threadId: "thread_2",
      terminals: [{ processId: "proc_1", terminated: true, gone: true }],
      survivors: [],
      truncated: false,
    }));
    const terminateBackgroundTerminal = jest.fn(async () => ({
      threadId: "thread_2",
      terminals: [{ processId: "proc_1", terminated: false }],
    }));
    const sessionManager = {
      getSession,
      cancelSession,
      interruptSession,
      forkSession,
      cleanBackgroundTerminals,
      terminateBackgroundTerminal,
    } as unknown as SessionManager;

    await expect(
      executeCodexSession(
        { action: "get", sessionId: "sess_2", includeSensitive: true },
        sessionManager
      )
    ).resolves.toEqual({ sessionId: "sess_2", status: "running" });
    expect(getSession).toHaveBeenCalledWith("sess_2", true);

    await expect(
      executeCodexSession({ action: "cancel", sessionId: "sess_2" }, sessionManager)
    ).resolves.toEqual({ success: true, message: "Session sess_2 cancelled" });
    expect(cancelSession).toHaveBeenCalledWith("sess_2");

    await expect(
      executeCodexSession({ action: "interrupt", sessionId: "sess_2" }, sessionManager)
    ).resolves.toEqual({ success: true, message: "Session sess_2 interrupted" });
    expect(interruptSession).toHaveBeenCalledWith("sess_2");

    await expect(
      executeCodexSession({ action: "fork", sessionId: "sess_2" }, sessionManager)
    ).resolves.toEqual({
      sessionId: "sess_fork",
      threadId: "thread_fork",
      status: "idle",
      pollInterval: 120000,
    });
    expect(forkSession).toHaveBeenCalledWith("sess_2");

    await expect(
      executeCodexSession(
        { action: "clean_background_terminals", sessionId: "sess_2" },
        sessionManager
      )
    ).resolves.toEqual({
      sessionId: "sess_2",
      backgroundTerminals: {
        threadId: "thread_2",
        terminals: [{ processId: "proc_1", terminated: true, gone: true }],
        survivors: [],
        truncated: false,
      },
    });
    expect(cleanBackgroundTerminals).toHaveBeenCalledWith("sess_2");

    await expect(
      executeCodexSession(
        { action: "terminate_background_terminal", sessionId: "sess_2", processId: "proc_1" },
        sessionManager
      )
    ).resolves.toEqual({
      sessionId: "sess_2",
      backgroundTerminals: {
        threadId: "thread_2",
        terminals: [{ processId: "proc_1", terminated: false }],
      },
    });
    expect(terminateBackgroundTerminal).toHaveBeenCalledWith("sess_2", "proc_1");
  });
});
