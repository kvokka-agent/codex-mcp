import { describe, expect, it, jest } from "bun:test";
import type { SessionManager } from "../src/session/manager.js";
import { executeCodexSession } from "../src/tools/codex-session.js";

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
    const cleanBackgroundTerminals = jest.fn(async () => {});
    const sessionManager = {
      getSession,
      cancelSession,
      interruptSession,
      forkSession,
      cleanBackgroundTerminals,
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
      success: true,
      message: "Background terminals cleaned for session sess_2",
    });
    expect(cleanBackgroundTerminals).toHaveBeenCalledWith("sess_2");
  });
});
