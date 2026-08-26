import { EventEmitter } from "events";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AppServerClient } from "../src/app-server/client.js";
import { Methods } from "../src/app-server/protocol.js";
import { SessionManager } from "../src/session/manager.js";
import { SessionPersistence } from "../src/session/persistence.js";
import { DEFAULT_POLL_INTERVAL, WAITING_APPROVAL_POLL_INTERVAL } from "../src/types.js";
import { executeCodexCheck } from "../src/tools/codex-check.js";

class MockAppServerClient extends EventEmitter {
  notificationHandler: ((method: string, params: unknown) => void) | null = null;
  serverRequestHandler: ((id: number, method: string, params: unknown) => void) | null = null;

  threadStartResult: unknown = { thread: { id: "thread_mock" } };
  turnStartResult: unknown = { turn: { id: "turn_mock" } };
  threadForkResult: unknown = { thread: { id: "thread_forked" } };
  threadResumeResult: unknown = { thread: { id: "thread_forked" } };

  supportsTurnOverrides = true;
  childPid: number | undefined = undefined;
  /** Spawn instant reported with the "spawn" event, as the real clients report theirs. */
  spawnedAt = "2024-05-05T10:00:00.000Z";

  start = vi.fn(async () => {
    if (this.childPid !== undefined) this.emit("spawn", this.childPid, this.spawnedAt);
    return { userAgent: "mock" };
  });
  threadStart = vi.fn(async () => this.threadStartResult);
  threadFork = vi.fn(async () => this.threadForkResult);
  threadResume = vi.fn(async () => this.threadResumeResult);
  turnStart = vi.fn(async () => this.turnStartResult);
  turnInterrupt = vi.fn(async () => {});

  respondToServer = vi.fn((_id: number, _result: unknown) => {});
  respondErrorToServer = vi.fn((_id: number, _code: number, _message: string) => {});
  destroy = vi.fn(async () => {});

  onNotification(handler: (method: string, params: unknown) => void): void {
    this.notificationHandler = handler;
  }

  onServerRequest(handler: (id: number, method: string, params: unknown) => void): void {
    this.serverRequestHandler = handler;
  }

  emitNotification(method: string, params: unknown): void {
    this.notificationHandler?.(method, params);
  }

  emitServerRequest(id: number, method: string, params: unknown): void {
    this.serverRequestHandler?.(id, method, params);
  }
}

describe("SessionManager protocol compatibility + approvals", () => {
  let manager: SessionManager;
  let client: MockAppServerClient;
  const workspace = path.resolve(os.tmpdir(), "codex-mcp-tests");

  beforeEach(() => {
    client = new MockAppServerClient();
    manager = new SessionManager({
      disableCleanup: true,
      createClient: () => client as unknown as AppServerClient,
    });
  });

  afterEach(() => {
    manager.destroy();
  });

  it("extracts threadId from v2 thread/start response shape", async () => {
    client.threadStartResult = { thread: { id: "thread_v2" } };
    const res = await manager.createSession("hi", workspace, {}, "medium");
    expect(res.threadId).toBe("thread_v2");
  });

  it("extracts threadId from legacy v1 thread/start response shape", async () => {
    client.threadStartResult = { threadId: "thread_v1" };
    const res = await manager.createSession("hi", workspace, {}, "medium");
    expect(res.threadId).toBe("thread_v1");
  });

  it("extracts threadId from legacy v1 thread/fork response shape", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");
    client.threadForkResult = { threadId: "thread_fork_v1" };
    const forked = await manager.forkSession(sessionId);
    expect(forked.threadId).toBe("thread_fork_v1");
    // original threadId still present
    expect(threadId).toBeDefined();
  });

  it("cleans up forked session resources when the new app-server fails to start", async () => {
    const originalClient = new MockAppServerClient();
    const forkClient = new MockAppServerClient();
    forkClient.start = vi.fn(async () => {
      throw new Error("start failed");
    });

    const queue = [originalClient, forkClient];
    const forkManager = new SessionManager({
      disableCleanup: true,
      createClient: () => {
        const next = queue.shift();
        if (!next) throw new Error("No mock client available");
        return next as unknown as AppServerClient;
      },
    });

    try {
      const started = await forkManager.createSession("hi", workspace, {}, "medium");
      await expect(forkManager.forkSession(started.sessionId)).rejects.toThrow(
        "THREAD_FORK_RESUME_FAILED"
      );
      expect(forkClient.destroy).toHaveBeenCalledTimes(1);
      const sessions = forkManager.listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.sessionId).toBe(started.sessionId);
    } finally {
      forkManager.destroy();
    }
  });

  it("cleans up forked session resources when threadResume fails", async () => {
    const originalClient = new MockAppServerClient();
    const forkClient = new MockAppServerClient();
    forkClient.threadResume = vi.fn(async () => {
      throw new Error("resume failed");
    });

    const queue = [originalClient, forkClient];
    const forkManager = new SessionManager({
      disableCleanup: true,
      createClient: () => {
        const next = queue.shift();
        if (!next) throw new Error("No mock client available");
        return next as unknown as AppServerClient;
      },
    });

    try {
      const started = await forkManager.createSession("hi", workspace, {}, "medium");
      await expect(forkManager.forkSession(started.sessionId)).rejects.toThrow(
        "THREAD_FORK_RESUME_FAILED"
      );
      expect(forkClient.destroy).toHaveBeenCalledTimes(1);
      const sessions = forkManager.listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.sessionId).toBe(started.sessionId);
    } finally {
      forkManager.destroy();
    }
  });

  it("still removes forked session bookkeeping when destroy fails after fork error", async () => {
    const originalClient = new MockAppServerClient();
    const forkClient = new MockAppServerClient();
    forkClient.threadResume = vi.fn(async () => {
      throw new Error("resume failed");
    });
    forkClient.destroy = vi.fn(async () => {
      throw new Error("destroy failed");
    });

    const queue = [originalClient, forkClient];
    const forkManager = new SessionManager({
      disableCleanup: true,
      createClient: () => {
        const next = queue.shift();
        if (!next) throw new Error("No mock client available");
        return next as unknown as AppServerClient;
      },
    });

    try {
      const started = await forkManager.createSession("hi", workspace, {}, "medium");
      await expect(forkManager.forkSession(started.sessionId)).rejects.toThrow(
        "THREAD_FORK_RESUME_FAILED"
      );
      const sessions = forkManager.listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.sessionId).toBe(started.sessionId);
    } finally {
      forkManager.destroy();
    }
  });

  it("reports active session count for running/idle/waiting states", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");
    expect(manager.getActiveSessionCount()).toBe(1);

    client.emitServerRequest(11, Methods.COMMAND_APPROVAL, {
      itemId: "item_active",
      threadId,
      turnId: "turn_active",
      command: "echo hi",
      cwd: workspace,
    });
    expect(manager.getActiveSessionCount()).toBe(1);

    await manager.cancelSession(sessionId);
    expect(manager.getActiveSessionCount()).toBe(0);
  });

  it("returns poll interval hints by session status", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");

    const running = manager.pollEvents(sessionId);
    expect(running.status).toBe("running");
    expect(running.pollInterval).toBe(DEFAULT_POLL_INTERVAL);

    client.emitServerRequest(31, Methods.COMMAND_APPROVAL, {
      itemId: "item_poll_hint",
      threadId,
      turnId: "turn_1",
      command: "echo hi",
      cwd: workspace,
    });

    const waiting = manager.pollEvents(sessionId);
    expect(waiting.status).toBe("waiting_approval");
    expect(waiting.pollInterval).toBe(WAITING_APPROVAL_POLL_INTERVAL);

    await manager.cancelSession(sessionId, "done");
    const terminal = manager.pollEvents(sessionId);
    expect(terminal.pollInterval).toBeUndefined();
  });

  it("exposes best-effort observed default model from recent sessions", async () => {
    expect(manager.getObservedDefaultModel()).toBeNull();

    await manager.createSession("hi", workspace, { model: "o4-mini" }, "medium");
    expect(manager.getObservedDefaultModel()).toBe("o4-mini");

    await manager.createSession("hello", workspace, { model: "o4" }, "medium");
    expect(manager.getObservedDefaultModel()).toBe("o4");
  });

  it("defaults poll to one incremental event when maxEvents is omitted", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");

    client.emitNotification(Methods.AGENT_MESSAGE_DELTA, {
      threadId,
      turnId: "turn_1",
      itemId: "item_a",
      delta: "A",
    });
    client.emitNotification(Methods.AGENT_MESSAGE_DELTA, {
      threadId,
      turnId: "turn_1",
      itemId: "item_b",
      delta: "B",
    });

    const poll1 = executeCodexCheck(
      {
        action: "poll",
        sessionId,
        cursor: 0,
      },
      manager
    );
    expect((poll1 as { isError?: boolean }).isError).not.toBe(true);
    const r1 = poll1 as { events: Array<{ id: number }>; nextCursor: number };
    expect(r1.events).toHaveLength(1);
    expect(r1.nextCursor).toBe(r1.events[0].id + 1);

    const poll2 = executeCodexCheck(
      {
        action: "poll",
        sessionId,
      },
      manager
    );
    expect((poll2 as { isError?: boolean }).isError).not.toBe(true);
    const r2 = poll2 as { events: Array<{ id: number }> };
    expect(r2.events).toHaveLength(1);
  });

  it("treats poll maxEvents=0 as 1 to avoid no-op polling loops", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");
    client.emitNotification(Methods.AGENT_MESSAGE_DELTA, {
      threadId,
      turnId: "turn_1",
      itemId: "item_zero_guard",
      delta: "Z",
    });

    const poll = executeCodexCheck(
      {
        action: "poll",
        sessionId,
        cursor: 0,
        maxEvents: 0,
      },
      manager
    );
    expect((poll as { isError?: boolean }).isError).not.toBe(true);
    const result = poll as { events: Array<{ id: number; type: string }>; nextCursor: number };
    expect(result.events).toHaveLength(1);
    expect(result.events[0].type).toBe("output");
    expect(result.nextCursor).toBe(result.events[0].id + 1);
  });

  it("keeps session cursor monotonic when poll receives a stale explicit cursor", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");
    client.emitNotification(Methods.AGENT_MESSAGE_DELTA, {
      threadId,
      turnId: "turn_1",
      itemId: "item_cursor_a",
      delta: "A",
    });
    client.emitNotification(Methods.AGENT_MESSAGE_DELTA, {
      threadId,
      turnId: "turn_1",
      itemId: "item_cursor_b",
      delta: "B",
    });
    client.emitNotification(Methods.AGENT_MESSAGE_DELTA, {
      threadId,
      turnId: "turn_1",
      itemId: "item_cursor_c",
      delta: "C",
    });

    const poll1 = executeCodexCheck(
      {
        action: "poll",
        sessionId,
        cursor: 0,
        maxEvents: 2,
      },
      manager
    ) as { events: Array<{ id: number }>; nextCursor: number };
    expect(poll1.events).toHaveLength(2);
    expect(poll1.nextCursor).toBe(2);

    const stalePoll = executeCodexCheck(
      {
        action: "poll",
        sessionId,
        cursor: 0,
        maxEvents: 1,
      },
      manager
    ) as { events: Array<{ id: number }>; nextCursor: number };
    expect(stalePoll.events).toHaveLength(1);
    expect(stalePoll.events[0]?.id).toBe(0);

    const resumed = executeCodexCheck(
      {
        action: "poll",
        sessionId,
        maxEvents: 1,
      },
      manager
    ) as { events: Array<{ id: number }> };
    expect(resumed.events).toHaveLength(1);
    expect(resumed.events[0]?.id).toBe(2);
  });

  it("clamps nextCursor when poll receives a future explicit cursor", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");
    client.emitNotification(Methods.AGENT_MESSAGE_DELTA, {
      threadId,
      turnId: "turn_1",
      itemId: "item_future_cursor",
      delta: "A",
    });

    const future = executeCodexCheck(
      {
        action: "poll",
        sessionId,
        cursor: 999999,
        maxEvents: 1,
      },
      manager
    ) as { events: Array<{ id: number }>; nextCursor: number };
    expect(future.events).toEqual([]);
    expect(future.nextCursor).toBe(1);

    const resumed = executeCodexCheck(
      {
        action: "poll",
        sessionId,
        maxEvents: 1,
      },
      manager
    ) as { events: Array<{ id: number }> };
    expect(resumed.events).toEqual([]);
  });

  it("responds to command approval and clears pending request", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");
    client.emitServerRequest(1, Methods.COMMAND_APPROVAL, {
      itemId: "item_1",
      threadId,
      turnId: "turn_1",
      command: "echo hi",
      cwd: workspace,
      reason: "test",
    });

    const poll1 = manager.pollEvents(sessionId);
    expect(poll1.status).toBe("waiting_approval");
    expect(poll1.actions?.length).toBe(1);

    const requestId = poll1.actions![0].requestId;
    const poll2 = executeCodexCheck(
      {
        action: "respond_permission",
        sessionId,
        requestId,
        decision: "accept",
      },
      manager
    );

    expect((poll2 as { isError?: boolean }).isError).not.toBe(true);
    expect(client.respondToServer).toHaveBeenCalledWith(1, { decision: "accept" });

    const info = manager.getSession(sessionId);
    expect(info.pendingRequestCount).toBe(0);
    expect(manager.pollEvents(sessionId).actions).toBeUndefined();
  });

  it("exposes command approval context fields in actions", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");
    client.emitServerRequest(201, Methods.COMMAND_APPROVAL, {
      itemId: "item_ctx_1",
      threadId,
      turnId: "turn_1",
      command: "npm install",
      cwd: workspace,
      reason: "Install deps",
      commandActions: [{ kind: "exec", command: ["npm", "install"] }],
      proposedExecpolicyAmendment: ["allow npm install in workspace"],
      availableDecisions: [
        "accept",
        "acceptForSession",
        {
          applyNetworkPolicyAmendment: {
            network_policy_amendment: { action: "allow", host: "example.com" },
          },
        },
        "decline",
        "cancel",
      ],
      additionalPermissions: { network: true },
      networkApprovalContext: { host: "example.com", protocol: "https" },
      proposedNetworkPolicyAmendments: [{ action: "allow", host: "example.com" }],
    });

    const poll = manager.pollEvents(sessionId);
    const action = poll.actions?.[0] as
      | {
          kind?: string;
          commandActions?: unknown[] | null;
          proposedExecpolicyAmendment?: string[] | null;
          availableDecisions?: unknown[] | null;
          additionalPermissions?: unknown;
          networkApprovalContext?: unknown;
          proposedNetworkPolicyAmendments?: unknown[] | null;
        }
      | undefined;
    expect(action?.kind).toBe("command");
    expect(action?.commandActions).toEqual([{ kind: "exec", command: ["npm", "install"] }]);
    expect(action?.proposedExecpolicyAmendment).toEqual(["allow npm install in workspace"]);
    expect(Array.isArray(action?.availableDecisions)).toBe(true);
    expect(action?.additionalPermissions).toEqual({ network: true });
    expect(action?.networkApprovalContext).toEqual({ host: "example.com", protocol: "https" });
    expect(action?.proposedNetworkPolicyAmendments).toEqual([
      { action: "allow", host: "example.com" },
    ]);
  });

  it("returns INTERNAL and keeps approval pending when forwarding response fails", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");
    client.emitServerRequest(101, Methods.COMMAND_APPROVAL, {
      itemId: "item_forward_fail_cmd",
      threadId,
      turnId: "turn_1",
      command: "echo hi",
      cwd: workspace,
    });

    const poll1 = manager.pollEvents(sessionId);
    const requestId = poll1.actions?.[0]?.requestId;
    expect(requestId).toBeDefined();

    client.respondToServer.mockImplementationOnce(() => {
      throw new Error("write queue dropped");
    });
    const failed = executeCodexCheck(
      {
        action: "respond_permission",
        sessionId,
        requestId: requestId!,
        decision: "accept",
      },
      manager
    ) as { isError?: boolean; error?: string };
    expect(failed.isError).toBe(true);
    expect(failed.error).toContain("INTERNAL");

    const stillPending = manager.pollEvents(sessionId);
    expect(stillPending.status).toBe("waiting_approval");
    expect(stillPending.actions?.some((action) => action.requestId === requestId)).toBe(true);

    const retry = executeCodexCheck(
      {
        action: "respond_permission",
        sessionId,
        requestId: requestId!,
        decision: "accept",
      },
      manager
    );
    expect((retry as { isError?: boolean }).isError).not.toBe(true);
    expect(manager.getSession(sessionId).pendingRequestCount).toBe(0);
  });

  it("returns INTERNAL and keeps fileChange approval pending when forwarding response fails", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");
    client.emitServerRequest(104, Methods.FILE_CHANGE_APPROVAL, {
      itemId: "item_forward_fail_file",
      threadId,
      turnId: "turn_1",
      reason: "confirm write",
    });

    const poll1 = manager.pollEvents(sessionId);
    const requestId = poll1.actions?.[0]?.requestId;
    expect(requestId).toBeDefined();

    client.respondToServer.mockImplementationOnce(() => {
      throw new Error("write queue dropped");
    });
    const failed = executeCodexCheck(
      {
        action: "respond_permission",
        sessionId,
        requestId: requestId!,
        decision: "accept",
      },
      manager
    ) as { isError?: boolean; error?: string };
    expect(failed.isError).toBe(true);
    expect(failed.error).toContain("INTERNAL");

    const stillPending = manager.pollEvents(sessionId);
    expect(stillPending.status).toBe("waiting_approval");
    expect(stillPending.actions?.some((action) => action.requestId === requestId)).toBe(true);

    const retry = executeCodexCheck(
      {
        action: "respond_permission",
        sessionId,
        requestId: requestId!,
        decision: "accept",
      },
      manager
    );
    expect((retry as { isError?: boolean }).isError).not.toBe(true);
    expect(manager.getSession(sessionId).pendingRequestCount).toBe(0);
  });

  it("uses last poll cursor for respond_permission when cursor is omitted", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");
    client.emitNotification(Methods.AGENT_MESSAGE_DELTA, {
      threadId,
      turnId: "turn_1",
      itemId: "item_output_1",
      delta: "hello",
    });
    client.emitServerRequest(2, Methods.COMMAND_APPROVAL, {
      itemId: "item_approval_1",
      threadId,
      turnId: "turn_1",
      command: "echo hi",
      cwd: workspace,
    });

    const poll1 = manager.pollEvents(sessionId, 0, 50);
    const requestId = poll1.actions?.[0]?.requestId;
    expect(requestId).toBeDefined();

    const poll2 = executeCodexCheck(
      {
        action: "respond_permission",
        sessionId,
        requestId: requestId!,
        decision: "accept",
      },
      manager
    );

    expect((poll2 as { isError?: boolean }).isError).not.toBe(true);
    const result = poll2 as { events: Array<{ id: number; type: string }>; nextCursor: number };
    expect(result.events).toHaveLength(0);
    expect(result.nextCursor).toBe(poll1.nextCursor);

    const poll3 = manager.pollEvents(sessionId);
    expect(poll3.events.some((event) => event.type === "approval_result")).toBe(true);
  });

  it("ignores stale explicit cursor in respond_permission and continues incrementally", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");
    client.emitNotification(Methods.AGENT_MESSAGE_DELTA, {
      threadId,
      turnId: "turn_1",
      itemId: "item_output_2",
      delta: "hello",
    });
    client.emitServerRequest(3, Methods.COMMAND_APPROVAL, {
      itemId: "item_approval_2",
      threadId,
      turnId: "turn_1",
      command: "echo hi",
      cwd: workspace,
    });

    const poll1 = manager.pollEvents(sessionId, 0, 50);
    const requestId = poll1.actions?.[0]?.requestId;
    expect(requestId).toBeDefined();

    const poll2 = executeCodexCheck(
      {
        action: "respond_permission",
        sessionId,
        requestId: requestId!,
        decision: "accept",
        cursor: 0,
      },
      manager
    );

    expect((poll2 as { isError?: boolean }).isError).not.toBe(true);
    const result = poll2 as { events: Array<{ id: number; type: string }>; nextCursor: number };
    expect(result.events).toHaveLength(0);
    expect(result.nextCursor).toBe(poll1.nextCursor);

    const poll3 = manager.pollEvents(sessionId);
    expect(poll3.events.some((event) => event.type === "approval_result")).toBe(true);
  });

  it("returns events for respond_permission when maxEvents is explicitly provided", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");
    client.emitServerRequest(30, Methods.COMMAND_APPROVAL, {
      itemId: "item_approval_explicit",
      threadId,
      turnId: "turn_1",
      command: "echo hi",
      cwd: workspace,
    });

    const poll1 = manager.pollEvents(sessionId, 0, 50);
    const requestId = poll1.actions?.[0]?.requestId;
    expect(requestId).toBeDefined();

    const poll2 = executeCodexCheck(
      {
        action: "respond_permission",
        sessionId,
        requestId: requestId!,
        decision: "accept",
        maxEvents: 10,
      },
      manager
    );

    expect((poll2 as { isError?: boolean }).isError).not.toBe(true);
    const result = poll2 as { events: Array<{ id: number; type: string }> };
    expect(result.events.some((event) => event.type === "approval_result")).toBe(true);
  });

  it("responds to user input request and clears pending request", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");
    client.emitServerRequest(12, Methods.USER_INPUT_REQUEST, {
      itemId: "item_ui_1",
      threadId,
      turnId: "turn_1",
      questions: [{ id: "q1", question: "Pick one" }],
    });

    const poll1 = manager.pollEvents(sessionId);
    expect(poll1.status).toBe("waiting_approval");
    expect(poll1.actions?.length).toBe(1);
    expect(poll1.actions?.[0]?.type).toBe("user_input");

    const requestId = poll1.actions![0].requestId;
    const answers = { q1: { answers: ["A"] } };
    const poll2 = executeCodexCheck(
      {
        action: "respond_user_input",
        sessionId,
        requestId,
        answers,
      },
      manager
    );

    expect((poll2 as { isError?: boolean }).isError).not.toBe(true);
    expect(client.respondToServer).toHaveBeenCalledWith(12, { answers });
    expect(manager.getSession(sessionId).pendingRequestCount).toBe(0);
  });

  it("returns INTERNAL and keeps user_input pending when forwarding response fails", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");
    client.emitServerRequest(102, Methods.USER_INPUT_REQUEST, {
      itemId: "item_forward_fail_ui",
      threadId,
      turnId: "turn_1",
      questions: [{ id: "q1", question: "Pick one" }],
    });

    const poll1 = manager.pollEvents(sessionId);
    const requestId = poll1.actions?.[0]?.requestId;
    expect(requestId).toBeDefined();

    client.respondToServer.mockImplementationOnce(() => {
      throw new Error("write queue dropped");
    });
    const failed = executeCodexCheck(
      {
        action: "respond_user_input",
        sessionId,
        requestId: requestId!,
        answers: { q1: { answers: ["A"] } },
      },
      manager
    ) as { isError?: boolean; error?: string };
    expect(failed.isError).toBe(true);
    expect(failed.error).toContain("INTERNAL");

    const stillPending = manager.pollEvents(sessionId);
    expect(stillPending.status).toBe("waiting_approval");
    expect(stillPending.actions?.some((action) => action.requestId === requestId)).toBe(true);

    const retry = executeCodexCheck(
      {
        action: "respond_user_input",
        sessionId,
        requestId: requestId!,
        answers: { q1: { answers: ["A"] } },
      },
      manager
    );
    expect((retry as { isError?: boolean }).isError).not.toBe(true);
    expect(manager.getSession(sessionId).pendingRequestCount).toBe(0);
  });

  it("uses last poll cursor for respond_user_input when cursor is omitted", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");
    client.emitNotification(Methods.AGENT_MESSAGE_DELTA, {
      threadId,
      turnId: "turn_1",
      itemId: "item_output_ui",
      delta: "hello",
    });
    client.emitServerRequest(13, Methods.USER_INPUT_REQUEST, {
      itemId: "item_ui_2",
      threadId,
      turnId: "turn_1",
      questions: [{ id: "q1", question: "Pick one" }],
    });

    const poll1 = manager.pollEvents(sessionId, 0, 50);
    const requestId = poll1.actions?.[0]?.requestId;
    expect(requestId).toBeDefined();

    const poll2 = executeCodexCheck(
      {
        action: "respond_user_input",
        sessionId,
        requestId: requestId!,
        answers: { q1: { answers: ["A"] } },
      },
      manager
    );

    expect((poll2 as { isError?: boolean }).isError).not.toBe(true);
    const result = poll2 as { events: Array<{ id: number; type: string }>; nextCursor: number };
    expect(result.events).toHaveLength(0);
    expect(result.nextCursor).toBe(poll1.nextCursor);

    const poll3 = manager.pollEvents(sessionId);
    expect(poll3.events.some((event) => event.type === "approval_result")).toBe(true);
  });

  it("ignores stale explicit cursor in respond_user_input and continues incrementally", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");
    client.emitNotification(Methods.AGENT_MESSAGE_DELTA, {
      threadId,
      turnId: "turn_1",
      itemId: "item_output_ui_stale",
      delta: "hello",
    });
    client.emitServerRequest(14, Methods.USER_INPUT_REQUEST, {
      itemId: "item_ui_3",
      threadId,
      turnId: "turn_1",
      questions: [{ id: "q1", question: "Pick one" }],
    });

    const poll1 = manager.pollEvents(sessionId, 0, 50);
    const requestId = poll1.actions?.[0]?.requestId;
    expect(requestId).toBeDefined();

    const poll2 = executeCodexCheck(
      {
        action: "respond_user_input",
        sessionId,
        requestId: requestId!,
        answers: { q1: { answers: ["A"] } },
        cursor: 0,
      },
      manager
    );

    expect((poll2 as { isError?: boolean }).isError).not.toBe(true);
    const result = poll2 as { events: Array<{ id: number; type: string }>; nextCursor: number };
    expect(result.events).toHaveLength(0);
    expect(result.nextCursor).toBe(poll1.nextCursor);

    const poll3 = manager.pollEvents(sessionId);
    expect(poll3.events.some((event) => event.type === "approval_result")).toBe(true);
  });

  it("returns events for respond_user_input when maxEvents is explicitly provided", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");
    client.emitServerRequest(31, Methods.USER_INPUT_REQUEST, {
      itemId: "item_ui_explicit",
      threadId,
      turnId: "turn_1",
      questions: [{ id: "q1", question: "Pick one" }],
    });

    const poll1 = manager.pollEvents(sessionId, 0, 50);
    const requestId = poll1.actions?.[0]?.requestId;
    expect(requestId).toBeDefined();

    const poll2 = executeCodexCheck(
      {
        action: "respond_user_input",
        sessionId,
        requestId: requestId!,
        answers: { q1: { answers: ["A"] } },
        maxEvents: 10,
      },
      manager
    );

    expect((poll2 as { isError?: boolean }).isError).not.toBe(true);
    const result = poll2 as { events: Array<{ id: number; type: string }> };
    expect(result.events.some((event) => event.type === "approval_result")).toBe(true);
  });

  it("supports respond_permission as the primary approval action", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");
    client.emitServerRequest(41, Methods.COMMAND_APPROVAL, {
      itemId: "item_approval_primary",
      threadId,
      turnId: "turn_1",
      command: "echo hi",
      cwd: workspace,
    });

    const poll1 = manager.pollEvents(sessionId, 0, 50);
    const requestId = poll1.actions?.[0]?.requestId;
    expect(requestId).toBeDefined();

    const poll2 = executeCodexCheck(
      {
        action: "respond_permission",
        sessionId,
        requestId: requestId!,
        decision: "accept",
      },
      manager
    );

    expect((poll2 as { isError?: boolean }).isError).not.toBe(true);
    expect(client.respondToServer).toHaveBeenCalledWith(41, { decision: "accept" });
  });

  it("supports responseMode and keeps payload size minimal < delta_compact < full", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");
    client.emitNotification(Methods.COMMAND_OUTPUT_DELTA, {
      threadId,
      turnId: "turn_1",
      itemId: "item_mode_1",
      delta: "x".repeat(3000),
    });

    const full = executeCodexCheck(
      {
        action: "poll",
        sessionId,
        cursor: 0,
        maxEvents: 20,
        responseMode: "full",
      },
      manager
    ) as { events: unknown[] };
    const compact = executeCodexCheck(
      {
        action: "poll",
        sessionId,
        cursor: 0,
        maxEvents: 20,
        responseMode: "delta_compact",
      },
      manager
    ) as { events: Array<{ data: { delta?: string; deltaTruncated?: boolean } }> };
    const minimal = executeCodexCheck(
      {
        action: "poll",
        sessionId,
        cursor: 0,
        maxEvents: 20,
        responseMode: "minimal",
      },
      manager
    ) as { events: unknown[] };

    expect(full.events.length).toBeGreaterThan(0);
    expect(compact.events.length).toBeGreaterThan(0);
    expect(minimal.events.length).toBeGreaterThan(0);
    const fullBytes = Buffer.byteLength(JSON.stringify(full), "utf8");
    const compactBytes = Buffer.byteLength(JSON.stringify(compact), "utf8");
    const minimalBytes = Buffer.byteLength(JSON.stringify(minimal), "utf8");
    expect(compactBytes).toBeLessThan(fullBytes);
    expect(minimalBytes).toBeLessThan(compactBytes);
    const compactDeltaEvent = compact.events.find((event) => event.data.deltaTruncated === true);
    expect(compactDeltaEvent).toBeDefined();
    expect(compactDeltaEvent?.data.delta?.length).toBeLessThan(3000);
    expect(minimalBytes).toBeLessThan(fullBytes);
  });

  it("keeps nextCursor at cursorResetTo floor when maxBytes truncates stale-event payloads", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");
    for (let i = 0; i < 1105; i++) {
      client.emitNotification(Methods.AGENT_MESSAGE_DELTA, {
        threadId,
        turnId: "turn_1",
        itemId: `item_evicted_${i}`,
        delta: `chunk-${i}-` + "x".repeat(64),
      });
    }

    const truncated = executeCodexCheck(
      {
        action: "poll",
        sessionId,
        cursor: 0,
        maxEvents: 2000,
        responseMode: "full",
        pollOptions: { maxBytes: 1 },
      },
      manager
    ) as {
      events: Array<{ id: number }>;
      truncated?: boolean;
      truncatedFields?: string[];
      cursorResetTo?: number;
      nextCursor: number;
    };

    expect(truncated.truncated).toBe(true);
    expect(truncated.truncatedFields).toContain("events");
    expect(truncated.events).toEqual([]);
    expect(typeof truncated.cursorResetTo).toBe("number");
    expect(truncated.nextCursor).toBe(truncated.cursorResetTo);

    const resumed = executeCodexCheck(
      {
        action: "poll",
        sessionId,
        maxEvents: 1,
      },
      manager
    ) as { events: Array<{ id: number }> };

    expect(resumed.events).toHaveLength(1);
    expect(resumed.events[0]?.id).toBe(truncated.nextCursor);
  });

  it("uses cursorResetTo as nextCursor for stale polls when maxEvents=0", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");
    for (let i = 0; i < 1105; i++) {
      client.emitNotification(Methods.AGENT_MESSAGE_DELTA, {
        threadId,
        turnId: "turn_1",
        itemId: `item_stale_zero_${i}`,
        delta: `chunk-${i}`,
      });
    }

    const poll = manager.pollEvents(sessionId, 0, 0);
    expect(typeof poll.cursorResetTo).toBe("number");
    expect(poll.nextCursor).toBe(poll.cursorResetTo);
  });

  it("uses cursorResetTo floor in respond_permission default ACK path when session cursor is stale", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");
    for (let i = 0; i < 1105; i++) {
      client.emitNotification(Methods.AGENT_MESSAGE_DELTA, {
        threadId,
        turnId: "turn_1",
        itemId: `item_respond_stale_${i}`,
        delta: `chunk-${i}`,
      });
    }
    client.emitServerRequest(46, Methods.COMMAND_APPROVAL, {
      itemId: "item_approval_stale_ack",
      threadId,
      turnId: "turn_1",
      command: "echo hi",
      cwd: workspace,
    });

    const approvalPoll = executeCodexCheck(
      {
        action: "poll",
        sessionId,
        pollOptions: { includeEvents: false },
      },
      manager
    ) as { actions?: Array<{ requestId: string }> };
    const requestId = approvalPoll.actions?.[0]?.requestId;
    expect(requestId).toBeDefined();

    const ack = executeCodexCheck(
      {
        action: "respond_permission",
        sessionId,
        requestId: requestId!,
        decision: "accept",
      },
      manager
    ) as { events: unknown[]; cursorResetTo?: number; nextCursor: number };
    expect(ack.events).toEqual([]);
    expect(typeof ack.cursorResetTo).toBe("number");
    expect(ack.nextCursor).toBe(ack.cursorResetTo);

    const resumed = executeCodexCheck(
      {
        action: "poll",
        sessionId,
        maxEvents: 1,
      },
      manager
    ) as { events: Array<{ id: number }> };
    expect(resumed.events).toHaveLength(1);
    expect(resumed.events[0]?.id).toBe(ack.nextCursor);
  });

  it("keeps actionable approvals under maxBytes by compacting actions while waiting_approval", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");
    client.emitServerRequest(103, Methods.COMMAND_APPROVAL, {
      itemId: "item_compact_actions",
      threadId,
      turnId: "turn_1",
      command: `echo ${"x".repeat(4000)}`,
      cwd: workspace,
      availableDecisions: ["accept", "decline", "cancel"],
      additionalPermissions: { network: true },
      networkApprovalContext: { host: "example.com", protocol: "https" },
      proposedNetworkPolicyAmendments: [{ action: "allow", host: "example.com" }],
    });

    const shaped = executeCodexCheck(
      {
        action: "poll",
        sessionId,
        cursor: 0,
        maxEvents: 20,
        pollOptions: {
          includeEvents: false,
          maxBytes: 700,
        },
      },
      manager
    ) as {
      status: string;
      actions?: Array<{ requestId: string; params: unknown }>;
      truncated?: boolean;
      truncatedFields?: string[];
    };

    expect(shaped.status).toBe("waiting_approval");
    expect(shaped.truncated).toBe(true);
    expect(shaped.truncatedFields).toContain("actions");
    expect(shaped.actions?.length).toBe(1);
    expect(shaped.actions?.[0]?.requestId).toBeDefined();
    expect(shaped.actions?.[0]?.params).toBeUndefined();
    expect(
      Array.isArray((shaped.actions?.[0] as { availableDecisions?: unknown[] }).availableDecisions)
    ).toBe(true);
    expect(
      (shaped.actions?.[0] as { additionalPermissions?: unknown }).additionalPermissions
    ).toEqual({
      network: true,
    });
    expect(
      (shaped.actions?.[0] as { networkApprovalContext?: unknown }).networkApprovalContext
    ).toEqual({
      host: "example.com",
      protocol: "https",
    });
    expect(
      (shaped.actions?.[0] as { proposedNetworkPolicyAmendments?: unknown })
        .proposedNetworkPolicyAmendments
    ).toEqual([{ action: "allow", host: "example.com" }]);

    const ack = executeCodexCheck(
      {
        action: "respond_permission",
        sessionId,
        requestId: shaped.actions![0].requestId,
        decision: "accept",
      },
      manager
    );
    expect((ack as { isError?: boolean }).isError).not.toBe(true);
  });

  it("keeps user_input ids under maxBytes so clients can still answer", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");
    client.emitServerRequest(105, Methods.USER_INPUT_REQUEST, {
      itemId: "item_compact_user_input",
      threadId,
      turnId: "turn_1",
      questions: [
        {
          id: "q1",
          question: "A".repeat(3000),
        },
      ],
    });

    const shaped = executeCodexCheck(
      {
        action: "poll",
        sessionId,
        cursor: 0,
        maxEvents: 20,
        pollOptions: {
          includeEvents: false,
          maxBytes: 700,
        },
      },
      manager
    ) as {
      status: string;
      actions?: Array<{
        requestId: string;
        kind: string;
        params: { questions?: Array<{ id?: string }> } | undefined;
      }>;
      truncated?: boolean;
      truncatedFields?: string[];
    };

    expect(shaped.status).toBe("waiting_approval");
    expect(shaped.truncated).toBe(true);
    expect(shaped.truncatedFields).toContain("actions");
    expect(shaped.actions?.length).toBe(1);
    expect(shaped.actions?.[0]?.kind).toBe("user_input");
    expect(shaped.actions?.[0]?.params?.questions?.[0]?.id).toBe("q1");

    const ack = executeCodexCheck(
      {
        action: "respond_user_input",
        sessionId,
        requestId: shaped.actions![0].requestId,
        answers: { q1: { answers: ["A"] } },
      },
      manager
    );
    expect((ack as { isError?: boolean }).isError).not.toBe(true);
  });

  it("does not consume events when includeEvents=false", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");
    client.emitNotification(Methods.AGENT_MESSAGE_DELTA, {
      threadId,
      turnId: "turn_1",
      itemId: "item_include_events",
      delta: "hello",
    });

    const noEvents = executeCodexCheck(
      {
        action: "poll",
        sessionId,
        cursor: 0,
        maxEvents: 20,
        pollOptions: { includeEvents: false },
      },
      manager
    ) as { events: unknown[]; nextCursor: number };
    expect(noEvents.events).toEqual([]);
    expect(noEvents.nextCursor).toBe(0);

    const withEvents = executeCodexCheck(
      {
        action: "poll",
        sessionId,
        cursor: 0,
        maxEvents: 20,
      },
      manager
    ) as { events: unknown[] };
    expect(withEvents.events.length).toBeGreaterThan(0);
  });

  it("can omit actions with includeActions=false while keeping pending approvals", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");
    client.emitServerRequest(45, Methods.COMMAND_APPROVAL, {
      itemId: "item_include_actions",
      threadId,
      turnId: "turn_1",
      command: "echo hi",
      cwd: workspace,
    });

    const noActions = executeCodexCheck(
      {
        action: "poll",
        sessionId,
        cursor: 0,
        maxEvents: 20,
        pollOptions: { includeActions: false },
      },
      manager
    ) as { actions?: unknown[] };
    expect(noActions.actions).toBeUndefined();

    const withActions = executeCodexCheck(
      {
        action: "poll",
        sessionId,
      },
      manager
    ) as { actions?: unknown[] };
    expect(withActions.actions?.length).toBe(1);
  });

  it("can omit terminal result with includeResult=false", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");
    client.emitNotification(Methods.TURN_COMPLETED, {
      threadId,
      turn: { id: "turn_done", status: "completed", output: "done" },
    });

    const noResult = executeCodexCheck(
      {
        action: "poll",
        sessionId,
        cursor: 0,
        maxEvents: 20,
        pollOptions: { includeResult: false },
      },
      manager
    ) as { status: string; result?: unknown };
    expect(noResult.status).toBe("idle");
    expect(noResult.result).toBeUndefined();

    const withResult = executeCodexCheck(
      {
        action: "poll",
        sessionId,
      },
      manager
    ) as { result?: unknown };
    expect(withResult.result).toBeDefined();
  });

  it("normalizes null and non-string approval reason to undefined", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");

    client.emitServerRequest(20, Methods.COMMAND_APPROVAL, {
      itemId: "item_cmd_null_reason",
      threadId,
      turnId: "turn_1",
      command: "echo hi",
      cwd: workspace,
      reason: null,
    });
    client.emitServerRequest(21, Methods.FILE_CHANGE_APPROVAL, {
      itemId: "item_fc_invalid_reason",
      threadId,
      turnId: "turn_1",
      reason: 123,
    });

    const poll = manager.pollEvents(sessionId, 0, 50);
    expect(poll.status).toBe("waiting_approval");
    expect(poll.actions?.length).toBe(2);
    expect(poll.actions?.every((action) => action.reason === undefined)).toBe(true);

    const approvalEvents = poll.events.filter((event) => event.type === "approval_request");
    expect(approvalEvents.length).toBe(2);
    expect(
      approvalEvents.every(
        (event) => (event.data as { reason?: string | null }).reason === undefined
      )
    ).toBe(true);
  });

  it("rejects invalid decision for fileChange approval via tool wrapper", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");
    client.emitServerRequest(2, Methods.FILE_CHANGE_APPROVAL, {
      itemId: "item_fc_1",
      threadId,
      turnId: "turn_1",
      reason: "test",
    });

    const poll1 = manager.pollEvents(sessionId);
    const requestId = poll1.actions![0].requestId;
    const out = executeCodexCheck(
      {
        action: "respond_permission",
        sessionId,
        requestId,
        decision: "acceptWithExecpolicyAmendment",
        execpolicy_amendment: ["allow:rm"],
      },
      manager
    );

    expect((out as { isError?: boolean }).isError).toBe(true);
    expect((out as { error?: string }).error).toContain("INVALID_ARGUMENT");
  });

  it("requires execpolicy_amendment for acceptWithExecpolicyAmendment", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");
    client.emitServerRequest(3, Methods.COMMAND_APPROVAL, {
      itemId: "item_cmd_2",
      threadId,
      turnId: "turn_1",
      command: "rm -rf /",
      cwd: workspace,
    });

    const poll1 = manager.pollEvents(sessionId);
    const requestId = poll1.actions![0].requestId;
    const out = executeCodexCheck(
      {
        action: "respond_permission",
        sessionId,
        requestId,
        decision: "acceptWithExecpolicyAmendment",
        // missing execpolicy_amendment
      },
      manager
    );

    expect((out as { isError?: boolean }).isError).toBe(true);
    expect((out as { error?: string }).error).toContain("execpolicy_amendment required");
  });

  it("requires network_policy_amendment for applyNetworkPolicyAmendment", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");
    client.emitServerRequest(88, Methods.COMMAND_APPROVAL, {
      itemId: "item_cmd_network_1",
      threadId,
      turnId: "turn_1",
      command: "curl https://example.com",
      cwd: workspace,
      availableDecisions: [
        "accept",
        {
          applyNetworkPolicyAmendment: {
            network_policy_amendment: { action: "allow", host: "example.com" },
          },
        },
        "decline",
        "cancel",
      ],
    });

    const poll1 = manager.pollEvents(sessionId);
    const requestId = poll1.actions![0].requestId;
    const out = executeCodexCheck(
      {
        action: "respond_permission",
        sessionId,
        requestId,
        decision: "applyNetworkPolicyAmendment",
        // missing network_policy_amendment
      },
      manager
    );

    expect((out as { isError?: boolean }).isError).toBe(true);
    expect((out as { error?: string }).error).toContain("network_policy_amendment required");
  });

  it("rejects network_policy_amendment when decision is not applyNetworkPolicyAmendment", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");
    client.emitServerRequest(89, Methods.COMMAND_APPROVAL, {
      itemId: "item_cmd_network_2",
      threadId,
      turnId: "turn_1",
      command: "echo hi",
      cwd: workspace,
    });

    const poll1 = manager.pollEvents(sessionId);
    const requestId = poll1.actions![0].requestId;
    const out = executeCodexCheck(
      {
        action: "respond_permission",
        sessionId,
        requestId,
        decision: "accept",
        network_policy_amendment: { action: "allow", host: "example.com" },
      },
      manager
    );

    expect((out as { isError?: boolean }).isError).toBe(true);
    expect((out as { error?: string }).error).toContain("network_policy_amendment is only valid");
  });

  it("rejects applyNetworkPolicyAmendment when prompt lacks availableDecisions", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");
    client.emitServerRequest(90, Methods.COMMAND_APPROVAL, {
      itemId: "item_cmd_network_3",
      threadId,
      turnId: "turn_1",
      command: "curl https://example.com",
      cwd: workspace,
      // availableDecisions intentionally omitted for backward-compat check
    });

    const poll1 = manager.pollEvents(sessionId);
    const requestId = poll1.actions![0].requestId;
    const out = executeCodexCheck(
      {
        action: "respond_permission",
        sessionId,
        requestId,
        decision: "applyNetworkPolicyAmendment",
        network_policy_amendment: { action: "allow", host: "example.com" },
      },
      manager
    );

    expect((out as { isError?: boolean }).isError).toBe(true);
    expect((out as { error?: string }).error).toContain("missing availableDecisions");
  });

  it("accepts applyNetworkPolicyAmendment when advertised", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");
    client.emitServerRequest(91, Methods.COMMAND_APPROVAL, {
      itemId: "item_cmd_network_4",
      threadId,
      turnId: "turn_1",
      command: "curl https://example.com",
      cwd: workspace,
      availableDecisions: [
        "accept",
        {
          applyNetworkPolicyAmendment: {
            network_policy_amendment: { action: "allow", host: "example.com" },
          },
        },
        "decline",
        "cancel",
      ],
    });

    const poll1 = manager.pollEvents(sessionId);
    const requestId = poll1.actions![0].requestId;

    const ok = executeCodexCheck(
      {
        action: "respond_permission",
        sessionId,
        requestId,
        decision: "applyNetworkPolicyAmendment",
        network_policy_amendment: { action: "allow", host: "example.com" },
      },
      manager
    );
    expect((ok as { isError?: boolean }).isError).not.toBe(true);
    expect(client.respondToServer).toHaveBeenCalledWith(91, {
      decision: {
        applyNetworkPolicyAmendment: {
          network_policy_amendment: { action: "allow", host: "example.com" },
        },
      },
    });
  });

  it("rejects poll payloads that include respond_* fields", async () => {
    const { sessionId } = await manager.createSession("hi", workspace, {}, "medium");
    const out = executeCodexCheck(
      {
        action: "poll",
        sessionId,
        requestId: "req_should_not_exist",
      },
      manager
    );

    expect((out as { isError?: boolean }).isError).toBe(true);
    expect((out as { error?: string }).error).toContain("only valid for respond_* actions");
  });

  it("rejects respond_permission payloads that include answers", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");
    client.emitServerRequest(32, Methods.COMMAND_APPROVAL, {
      itemId: "item_approval_invalid_mix",
      threadId,
      turnId: "turn_1",
      command: "echo hi",
      cwd: workspace,
    });

    const poll1 = manager.pollEvents(sessionId, 0, 50);
    const requestId = poll1.actions?.[0]?.requestId;
    expect(requestId).toBeDefined();

    const out = executeCodexCheck(
      {
        action: "respond_permission",
        sessionId,
        requestId: requestId!,
        decision: "accept",
        answers: { q1: { answers: ["A"] } },
      },
      manager
    );

    expect((out as { isError?: boolean }).isError).toBe(true);
    expect((out as { error?: string }).error).toContain(
      "answers is only valid for respond_user_input"
    );
  });

  it("rejects respond_user_input payloads that include permission fields", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");
    client.emitServerRequest(33, Methods.USER_INPUT_REQUEST, {
      itemId: "item_user_input_invalid_mix",
      threadId,
      turnId: "turn_1",
      questions: [{ id: "q1", question: "Pick one" }],
    });

    const poll1 = manager.pollEvents(sessionId, 0, 50);
    const requestId = poll1.actions?.[0]?.requestId;
    expect(requestId).toBeDefined();

    const out = executeCodexCheck(
      {
        action: "respond_user_input",
        sessionId,
        requestId: requestId!,
        answers: { q1: { answers: ["A"] } },
        decision: "decline",
      },
      manager
    );

    expect((out as { isError?: boolean }).isError).toBe(true);
    expect((out as { error?: string }).error).toContain(
      "decision/execpolicy_amendment/network_policy_amendment/denyMessage are only valid for respond_permission"
    );
  });

  it("auto-declines approvals after approvalTimeoutMs and clears pending", async () => {
    vi.useFakeTimers();
    try {
      const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium", {
        approvalTimeoutMs: 5,
      });
      client.emitServerRequest(11, Methods.COMMAND_APPROVAL, {
        itemId: "item_timeout_1",
        threadId,
        turnId: "turn_1",
        command: "echo hi",
        cwd: workspace,
      });
      expect(manager.pollEvents(sessionId).actions?.length).toBe(1);

      await vi.advanceTimersByTimeAsync(10);

      expect(client.respondToServer).toHaveBeenCalledWith(11, { decision: "decline" });
      expect(manager.getSession(sessionId).pendingRequestCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("auto-answers user input with empty answers on timeout", async () => {
    vi.useFakeTimers();
    try {
      const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium", {
        approvalTimeoutMs: 5,
      });
      client.emitServerRequest(13, Methods.USER_INPUT_REQUEST, {
        itemId: "item_ui_timeout_1",
        threadId,
        turnId: "turn_1",
        questions: [{ id: "q1", question: "Pick one" }],
      });

      expect(manager.pollEvents(sessionId).actions?.length).toBe(1);
      await vi.advanceTimersByTimeAsync(10);

      expect(client.respondToServer).toHaveBeenCalledWith(13, { answers: {} });
      const poll = manager.pollEvents(sessionId, 0, 200);
      expect(
        poll.events.some(
          (event) =>
            event.type === "approval_result" &&
            (event.data as { timeout?: boolean; kind?: string }).timeout === true &&
            (event.data as { timeout?: boolean; kind?: string }).kind === "user_input"
        )
      ).toBe(true);
      expect(manager.getSession(sessionId).pendingRequestCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sets cursorResetTo when buffer has evicted earlier events", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");
    for (let i = 0; i < 1105; i++) {
      client.emitNotification(Methods.AGENT_MESSAGE_DELTA, {
        threadId,
        turnId: "turn_1",
        itemId: `item_${i}`,
        delta: "x",
      });
    }

    const poll = manager.pollEvents(sessionId, 0, 2000);
    expect(poll.cursorResetTo).toBe(105);
    expect(poll.events.length).toBe(1000);
  });

  it("prefers evicting approval_result before critical pinned events at hard limit", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");

    const internal = manager as unknown as {
      sessions: Map<
        string,
        {
          eventBuffer: { maxSize: number; hardMaxSize: number };
        }
      >;
    };
    const session = internal.sessions.get(sessionId);
    expect(session).toBeDefined();
    session!.eventBuffer.maxSize = 2;
    session!.eventBuffer.hardMaxSize = 2;

    client.emitServerRequest(21, Methods.COMMAND_APPROVAL, {
      itemId: "item_hard_limit",
      threadId,
      turnId: "turn_1",
      command: "echo hi",
      cwd: workspace,
    });
    const poll1 = manager.pollEvents(sessionId, 0, 50);
    const requestId = poll1.actions?.[0]?.requestId;
    expect(requestId).toBeDefined();
    manager.resolveApproval(sessionId, requestId!, "accept");

    client.emitNotification(Methods.TURN_COMPLETED, {
      threadId,
      turn: { id: "turn_1", status: "completed", output: "done" },
    });

    const poll2 = manager.pollEvents(sessionId, 0, 50);
    const eventTypes = poll2.events.map((event) => event.type);
    expect(eventTypes).toContain("approval_request");
    expect(eventTypes).toContain("result");
    expect(eventTypes).not.toContain("approval_result");
  });

  it("classifies item/completed based on item.type", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");

    client.emitNotification(Methods.ITEM_COMPLETED, {
      threadId,
      turnId: "turn_1",
      item: { id: "m1", type: "agentMessage", text: "hello" },
    });
    client.emitNotification(Methods.ITEM_COMPLETED, {
      threadId,
      turnId: "turn_1",
      item: { id: "c1", type: "commandExecution", command: "echo hi" },
    });

    const poll = manager.pollEvents(sessionId, 0, 50);
    const types = poll.events.map((e) => e.type);
    expect(types).toContain("output");
    expect(types).toContain("progress");
  });

  it("coalesces command output deltas for the same item into a single progress event", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");

    client.emitNotification(Methods.COMMAND_OUTPUT_DELTA, {
      threadId,
      turnId: "turn_1",
      itemId: "cmd_item_1",
      delta: "a",
    });
    client.emitNotification(Methods.COMMAND_OUTPUT_DELTA, {
      threadId,
      turnId: "turn_1",
      itemId: "cmd_item_1",
      delta: "b",
    });
    client.emitNotification(Methods.COMMAND_OUTPUT_DELTA, {
      threadId,
      turnId: "turn_1",
      itemId: "cmd_item_1",
      delta: "c",
    });

    const poll = manager.pollEvents(sessionId, 0, 50);
    const deltas = poll.events.filter(
      (event) =>
        event.type === "progress" &&
        (event.data as { method?: string }).method === Methods.COMMAND_OUTPUT_DELTA
    );
    expect(deltas).toHaveLength(1);
    expect((deltas[0].data as { delta?: string }).delta).toBe("abc");
  });

  it("coalesces reasoning summary deltas for the same item", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");

    client.emitNotification(Methods.REASONING_SUMMARY_DELTA, {
      threadId,
      turnId: "turn_1",
      itemId: "summary_item_1",
      delta: "hello ",
    });
    client.emitNotification(Methods.REASONING_SUMMARY_DELTA, {
      threadId,
      turnId: "turn_1",
      itemId: "summary_item_1",
      delta: "world",
    });

    const poll = manager.pollEvents(sessionId, 0, 50);
    const summaries = poll.events.filter(
      (event) =>
        event.type === "progress" &&
        (event.data as { method?: string }).method === Methods.REASONING_SUMMARY_DELTA
    );
    expect(summaries).toHaveLength(1);
    expect((summaries[0].data as { delta?: string }).delta).toBe("hello world");
  });

  it("coalesces reasoning summary deltas when itemId is missing but turnId matches", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");

    client.emitNotification(Methods.REASONING_SUMMARY_DELTA, {
      threadId,
      turnId: "turn_1",
      delta: "first ",
    });
    client.emitNotification(Methods.REASONING_SUMMARY_DELTA, {
      threadId,
      turnId: "turn_1",
      delta: "second",
    });

    const poll = manager.pollEvents(sessionId, 0, 50);
    const summaries = poll.events.filter(
      (event) =>
        event.type === "progress" &&
        (event.data as { method?: string }).method === Methods.REASONING_SUMMARY_DELTA
    );
    expect(summaries).toHaveLength(1);
    expect((summaries[0].data as { delta?: string }).delta).toBe("first second");
  });

  it("coalesces reasoning text deltas for the same turn", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");

    client.emitNotification(Methods.REASONING_TEXT_DELTA, {
      threadId,
      turnId: "turn_1",
      delta: "A",
    });
    client.emitNotification(Methods.REASONING_TEXT_DELTA, {
      threadId,
      turnId: "turn_1",
      delta: "B",
    });

    const poll = manager.pollEvents(sessionId, 0, 50);
    const reasoning = poll.events.filter(
      (event) =>
        event.type === "progress" &&
        (event.data as { method?: string }).method === Methods.REASONING_TEXT_DELTA
    );
    expect(reasoning).toHaveLength(1);
    expect((reasoning[0].data as { delta?: string }).delta).toBe("AB");
  });

  it("clears pending requests when app-server exits", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");
    client.emitServerRequest(9, Methods.COMMAND_APPROVAL, {
      itemId: "item_exit_1",
      threadId,
      turnId: "turn_1",
      command: "echo hi",
      cwd: workspace,
    });

    expect(manager.pollEvents(sessionId).actions?.length).toBe(1);

    client.emit("exit", 1, null);
    const poll = manager.pollEvents(sessionId);
    expect(poll.status).toBe("error");
    expect(poll.actions).toBeUndefined();
    expect(poll.result?.status).toBe("error");
    expect(poll.result?.error).toContain("app-server exited unexpectedly");
    expect(poll.events.some((event) => event.type === "result")).toBe(true);
    expect(manager.getSession(sessionId).pendingRequestCount).toBe(0);
  });

  it("emits reconnect progress for retryable app-server errors", async () => {
    const { sessionId } = await manager.createSession("hi", workspace, {}, "medium");

    client.emitNotification(Methods.ERROR, {
      message: "temporary disconnect",
      willRetry: true,
      retryCount: 1,
      maxRetries: 5,
    });

    const poll = manager.pollEvents(sessionId, 0, 200);
    expect(poll.status).toBe("running");
    const reconnect = poll.events.find(
      (event) =>
        event.type === "progress" &&
        (event.data as { method?: string }).method === "codex-mcp/reconnect"
    );
    expect(reconnect).toBeDefined();
    expect((reconnect!.data as { phase?: string }).phase).toBe("retrying");
    expect((reconnect!.data as { willRetry?: boolean }).willRetry).toBe(true);
    expect(poll.events.some((event) => event.type === "error")).toBe(false);
  });

  it("keeps terminal error semantics for non-retryable app-server errors", async () => {
    const { sessionId } = await manager.createSession("hi", workspace, {}, "medium");

    client.emitNotification(Methods.ERROR, {
      message: "fatal error",
      willRetry: false,
    });

    const poll = manager.pollEvents(sessionId, 0, 200);
    expect(poll.status).toBe("error");
    expect(poll.events.some((event) => event.type === "error")).toBe(true);
  });

  it("produces a terminal result when cancelled", async () => {
    const { sessionId } = await manager.createSession("hi", workspace, {}, "medium");

    await manager.cancelSession(sessionId, "Cancelled by test");

    const poll = manager.pollEvents(sessionId);
    expect(poll.status).toBe("cancelled");
    expect(poll.pollInterval).toBeUndefined();
    expect(poll.actions).toBeUndefined();
    expect(poll.result?.status).toBe("cancelled");
    expect(poll.result?.error).toContain("Cancelled by test");
  });

  it("deduplicates concurrent cancellation and destroys client once", async () => {
    let releaseDestroy: (() => void) | undefined;
    const destroyGate = new Promise<void>((resolve) => {
      releaseDestroy = resolve;
    });
    client.destroy = vi.fn(async () => {
      await destroyGate;
    });

    const { sessionId } = await manager.createSession("hi", workspace, {}, "medium");

    const cancel1 = manager.cancelSession(sessionId, "one");
    const cancel2 = manager.cancelSession(sessionId, "two");

    await Promise.resolve();
    expect(client.destroy).toHaveBeenCalledTimes(1);

    releaseDestroy?.();
    await Promise.all([cancel1, cancel2]);
    expect(manager.pollEvents(sessionId).status).toBe("cancelled");
  });

  it("responds immediately to late approval requests after cancellation", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");
    await manager.cancelSession(sessionId, "Cancelled by test");
    client.respondToServer.mockClear();

    client.emitServerRequest(77, Methods.COMMAND_APPROVAL, {
      itemId: "item_late_approval",
      threadId,
      turnId: "turn_1",
      command: "echo late",
      cwd: workspace,
    });

    const poll = manager.pollEvents(sessionId, 0, 200);
    expect(client.respondToServer).toHaveBeenCalledWith(77, { decision: "cancel" });
    expect(poll.status).toBe("cancelled");
    expect(poll.actions).toBeUndefined();
  });

  it("returns explicit unsupported error for auth refresh while running", async () => {
    const { sessionId } = await manager.createSession("hi", workspace, {}, "medium");
    client.emitServerRequest(78, Methods.AUTH_TOKEN_REFRESH, {
      reason: "unauthorized",
      previousAccountId: "acct_1",
    });

    expect(client.respondErrorToServer).toHaveBeenCalledWith(
      78,
      -32000,
      "account/chatgptAuthTokens/refresh unsupported: codex-mcp does not manage external ChatGPT auth tokens"
    );
    expect(manager.pollEvents(sessionId).actions).toBeUndefined();
  });

  it("returns explicit unsupported error for auth refresh after session is terminal", async () => {
    const { sessionId } = await manager.createSession("hi", workspace, {}, "medium");
    await manager.cancelSession(sessionId, "Cancelled by test");
    client.respondErrorToServer.mockClear();

    client.emitServerRequest(79, Methods.AUTH_TOKEN_REFRESH, {
      reason: "unauthorized",
    });

    expect(client.respondErrorToServer).toHaveBeenCalledWith(
      79,
      -32000,
      "account/chatgptAuthTokens/refresh unsupported: session is terminal"
    );
    expect(manager.pollEvents(sessionId).actions).toBeUndefined();
  });

  it("ignores late turn/completed notifications after cancellation", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");
    await manager.cancelSession(sessionId, "Cancelled by test");

    client.emitNotification(Methods.TURN_COMPLETED, {
      threadId,
      turnId: "turn_late",
      turn: { status: "completed", output: "should be ignored" },
    });

    const poll = manager.pollEvents(sessionId, 0, 200);
    expect(poll.status).toBe("cancelled");
    expect(poll.result?.status).toBe("cancelled");
    expect(
      poll.events.some(
        (event) =>
          event.type === "result" &&
          (event.data as { method?: string }).method === Methods.TURN_COMPLETED
      )
    ).toBe(false);
  });

  it("unrefs approval timeout timers so they do not block process exit", async () => {
    const unrefSpy = vi.fn();
    const timeoutHandle = { unref: unrefSpy } as unknown as ReturnType<typeof setTimeout>;
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      handler: TimerHandler,
      timeout?: number
    ) => {
      void handler;
      void timeout;
      return timeoutHandle;
    }) as unknown as typeof setTimeout);

    try {
      const { threadId } = await manager.createSession("hi", workspace, {}, "medium", {
        approvalTimeoutMs: 5,
      });
      client.emitServerRequest(91, Methods.COMMAND_APPROVAL, {
        itemId: "item_unreftimer",
        threadId,
        turnId: "turn_1",
        command: "echo hi",
        cwd: workspace,
      });

      expect(setTimeoutSpy).toHaveBeenCalled();
      expect(unrefSpy).toHaveBeenCalled();
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it("validates localImage paths before starting the turn", async () => {
    await expect(
      manager.createSession("hi", workspace, {}, "medium", { images: ["./nope.png"] })
    ).rejects.toThrow("INVALID_ARGUMENT");
    expect(client.start).not.toHaveBeenCalled();
  });

  it("tracks activeTurnId from v2 turn/started turn.id payload", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");
    client.emitNotification(Methods.TURN_STARTED, {
      threadId,
      turn: { id: "turn_v2_started", status: "in_progress" },
    });

    await manager.interruptSession(sessionId);
    expect(client.turnInterrupt).toHaveBeenCalledWith({
      threadId,
      turnId: "turn_v2_started",
    });
  });

  it("uses turn.id from v2 turn/completed payload as final turn id", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");
    client.emitNotification(Methods.TURN_STARTED, {
      threadId,
      turn: { id: "turn_v2", status: "in_progress" },
    });
    client.emitNotification(Methods.TURN_COMPLETED, {
      threadId,
      turn: { id: "turn_v2", status: "completed" },
    });

    const poll = manager.pollEvents(sessionId, 0, 200);
    expect(poll.status).toBe("idle");
    expect(poll.result?.turnId).toBe("turn_v2");
  });

  it("returns SESSION_NOT_RUNNING when interrupting an idle session", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");
    client.emitNotification(Methods.TURN_COMPLETED, {
      threadId,
      turnId: "turn_done",
      turn: { status: "completed" },
    });

    await expect(manager.interruptSession(sessionId)).rejects.toThrow("SESSION_NOT_RUNNING");
  });

  it("can interrupt immediately after codex_reply using turnStart response id (before turn/started notification)", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");

    // Put session into idle so reply is allowed.
    client.emitNotification(Methods.TURN_COMPLETED, {
      threadId,
      turnId: "turn_done",
      turn: { status: "completed" },
    });
    expect(manager.pollEvents(sessionId).status).toBe("idle");

    await manager.replyToSession(sessionId, "next");
    await manager.interruptSession(sessionId);

    expect(client.turnInterrupt).toHaveBeenCalledWith({
      threadId,
      turnId: "turn_mock",
    });
  });

  it("persists reply overrides to session metadata", async () => {
    const { sessionId, threadId } = await manager.createSession(
      "hi",
      workspace,
      {
        model: "o4-mini",
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
      },
      "medium"
    );

    client.emitNotification(Methods.TURN_COMPLETED, {
      threadId,
      turnId: "turn_done",
      turn: { status: "completed" },
    });

    await manager.replyToSession(sessionId, "next", {
      model: "o4",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      cwd: os.tmpdir(),
    });

    const info = manager.getSession(sessionId, true) as {
      model?: string;
      approvalPolicy?: string;
      sandbox?: string;
      cwd: string;
    };
    expect(info.model).toBe("o4");
    expect(info.approvalPolicy).toBe("never");
    expect(info.sandbox).toBe("danger-full-access");
    expect(info.cwd).toBe(os.tmpdir());
    expect(client.turnStart).toHaveBeenLastCalledWith(
      expect.objectContaining({
        model: "o4",
        approvalPolicy: "never",
        cwd: os.tmpdir(),
        sandboxPolicy: { type: "dangerFullAccess" },
      })
    );
  });

  // ── Thread status / lifecycle / warning notifications ──────────────

  /** Events a poll returned for one notification method, newest last. */
  function eventsFor(
    poll: ReturnType<SessionManager["pollEvents"]>,
    method: string
  ): Array<{ type: string; data: Record<string, unknown> }> {
    return poll.events
      .map((e) => ({ type: e.type as string, data: e.data as Record<string, unknown> }))
      .filter((e) => e.data?.method === method);
  }

  it("keeps a thread status change and its active flags in the event stream", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");

    client.emitNotification(Methods.THREAD_STATUS_CHANGED, {
      threadId,
      status: { type: "active", activeFlags: ["waitingOnApproval"] },
    });

    const poll = manager.pollEvents(sessionId, 0, 50);
    const [event] = eventsFor(poll, Methods.THREAD_STATUS_CHANGED);
    expect(event.type).toBe("progress");
    expect(event.data).toMatchObject({
      threadId,
      status: { type: "active", activeFlags: ["waitingOnApproval"] },
      statusType: "active",
      activeFlags: ["waitingOnApproval"],
    });
  });

  it("keeps the session running when a waiting status outruns the approval request", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");

    client.emitNotification(Methods.THREAD_STATUS_CHANGED, {
      threadId,
      status: { type: "active", activeFlags: ["waitingOnApproval"] },
    });

    // No request has arrived, so there is nothing a caller could answer yet.
    const early = manager.pollEvents(sessionId, 0, 50);
    expect(early.status).toBe("running");
    expect(early.actions).toBeUndefined();

    client.emitServerRequest(701, Methods.COMMAND_APPROVAL, {
      itemId: "item_race_early",
      threadId,
      turnId: "turn_race",
      command: "rm -rf /tmp/x",
      cwd: workspace,
    });

    const withRequest = manager.pollEvents(sessionId, 0, 50);
    expect(withRequest.status).toBe("waiting_approval");
    expect(withRequest.actions).toHaveLength(1);
  });

  it("does not re-park a session on a waiting status that trails the answered request", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");

    client.emitServerRequest(702, Methods.COMMAND_APPROVAL, {
      itemId: "item_race_late",
      threadId,
      turnId: "turn_race",
      command: "echo hi",
      cwd: workspace,
    });
    const pending = manager.pollEvents(sessionId, 0, 50);
    expect(pending.status).toBe("waiting_approval");
    manager.resolveApproval(sessionId, pending.actions![0].requestId, "accept");
    expect(manager.pollEvents(sessionId, 0, 50).status).toBe("running");

    // The status change codex sent while the request was open lands afterwards.
    client.emitNotification(Methods.THREAD_STATUS_CHANGED, {
      threadId,
      status: { type: "active", activeFlags: ["waitingOnApproval"] },
    });

    const late = manager.pollEvents(sessionId, 0, 50);
    expect(late.status).toBe("running");
    expect(late.actions).toBeUndefined();
  });

  it("holds waiting_approval while a request is open and takes idle once it is answered", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");

    client.emitServerRequest(703, Methods.COMMAND_APPROVAL, {
      itemId: "item_idle_race",
      threadId,
      turnId: "turn_idle",
      command: "echo hi",
      cwd: workspace,
    });
    const pending = manager.pollEvents(sessionId, 0, 50);

    client.emitNotification(Methods.THREAD_STATUS_CHANGED, { threadId, status: { type: "idle" } });
    expect(manager.pollEvents(sessionId, 0, 50).status).toBe("waiting_approval");

    manager.resolveApproval(sessionId, pending.actions![0].requestId, "accept");
    client.emitNotification(Methods.THREAD_STATUS_CHANGED, { threadId, status: { type: "idle" } });
    expect(manager.pollEvents(sessionId, 0, 50).status).toBe("idle");
  });

  it("leaves the session untouched for a notLoaded thread status", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");

    client.emitNotification(Methods.THREAD_STATUS_CHANGED, {
      threadId,
      status: { type: "notLoaded" },
    });

    const poll = manager.pollEvents(sessionId, 0, 50);
    expect(poll.status).toBe("running");
    expect(eventsFor(poll, Methods.THREAD_STATUS_CHANGED)[0].data.statusType).toBe("notLoaded");
  });

  it("fails the session on a systemError thread status and reports it as an error event", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");

    client.emitNotification(Methods.THREAD_STATUS_CHANGED, {
      threadId,
      status: { type: "systemError" },
    });

    const poll = manager.pollEvents(sessionId, 0, 50);
    expect(poll.status).toBe("error");
    const [event] = eventsFor(poll, Methods.THREAD_STATUS_CHANGED);
    expect(event.type).toBe("error");
    expect(event.data).toMatchObject({ threadId, statusType: "systemError" });

    // A terminal session stays terminal, whatever codex reports next.
    client.emitNotification(Methods.THREAD_STATUS_CHANGED, { threadId, status: { type: "idle" } });
    expect(manager.pollEvents(sessionId, 0, 50).status).toBe("error");
  });

  it("keeps a cancelled session cancelled when a thread status arrives late", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");
    await manager.cancelSession(sessionId, "stop");

    client.emitNotification(Methods.THREAD_STATUS_CHANGED, {
      threadId,
      status: { type: "active", activeFlags: ["waitingOnUserInput"] },
    });

    expect(manager.pollEvents(sessionId, 0, 50).status).toBe("cancelled");
  });

  it("surfaces thread closure and context compaction as session events", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");

    client.emitNotification(Methods.THREAD_COMPACTED, { threadId, turnId: "turn_compact" });
    client.emitNotification(Methods.THREAD_CLOSED, { threadId });

    const poll = manager.pollEvents(sessionId, 0, 50);
    expect(eventsFor(poll, Methods.THREAD_COMPACTED)[0]).toEqual({
      type: "progress",
      data: { method: Methods.THREAD_COMPACTED, threadId, turnId: "turn_compact" },
    });
    expect(eventsFor(poll, Methods.THREAD_CLOSED)[0]).toEqual({
      type: "progress",
      data: { method: Methods.THREAD_CLOSED, threadId },
    });
    // Neither one is a failure of the session.
    expect(poll.status).toBe("running");
  });

  it("surfaces deprecation and config warnings with the details codex sent", async () => {
    const { sessionId } = await manager.createSession("hi", workspace, {}, "medium");

    client.emitNotification(Methods.DEPRECATION_NOTICE, {
      summary: "`--profile` is deprecated",
      details: "use `--config profile=name`",
    });
    client.emitNotification(Methods.CONFIG_WARNING, {
      summary: "unknown key `sandbox_mode`",
      details: null,
      path: "/home/someone/.codex/config.toml",
      range: { start: { line: 3, column: 1 }, end: { line: 3, column: 12 } },
    });

    const poll = manager.pollEvents(sessionId, 0, 50);
    expect(eventsFor(poll, Methods.DEPRECATION_NOTICE)[0]).toEqual({
      type: "progress",
      data: {
        method: Methods.DEPRECATION_NOTICE,
        summary: "`--profile` is deprecated",
        details: "use `--config profile=name`",
      },
    });
    expect(eventsFor(poll, Methods.CONFIG_WARNING)[0]).toEqual({
      type: "progress",
      data: {
        method: Methods.CONFIG_WARNING,
        summary: "unknown key `sandbox_mode`",
        details: null,
        path: "/home/someone/.codex/config.toml",
        range: { start: { line: 3, column: 1 }, end: { line: 3, column: 12 } },
      },
    });
    expect(poll.status).toBe("running");
  });

  it("keeps a warning in the buffer while the deltas around it are evicted", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");

    client.emitNotification(Methods.CONFIG_WARNING, { summary: "unknown key `sandbox_mode`" });
    // Each delta carries its own itemId so nothing coalesces into one event.
    for (let i = 0; i < 1100; i++) {
      client.emitNotification(Methods.AGENT_MESSAGE_DELTA, {
        threadId,
        itemId: `item_${i}`,
        delta: "x",
      });
    }

    const poll = manager.pollEvents(sessionId, 0, 5000);
    expect(poll.events.length).toBeLessThan(1101);
    expect(eventsFor(poll, Methods.CONFIG_WARNING)).toHaveLength(1);
  });
});

describe("SessionManager missing protocol ids", () => {
  let manager: SessionManager;
  let client: MockAppServerClient;
  let errors: ReturnType<typeof vi.spyOn>;
  const workspace = path.resolve(os.tmpdir(), "codex-mcp-tests");

  beforeEach(() => {
    errors = vi.spyOn(console, "error").mockImplementation(() => {});
    client = new MockAppServerClient();
    manager = new SessionManager({
      disableCleanup: true,
      createClient: () => client as unknown as AppServerClient,
    });
  });

  afterEach(() => {
    manager.destroy();
    vi.restoreAllMocks();
  });

  function logged(fragment: string): boolean {
    return errors.mock.calls.some((call) => String(call[0]).includes(fragment));
  }

  it("reports an approval request that carries none of its correlation ids", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium");

    client.emitServerRequest(1, Methods.COMMAND_APPROVAL, { command: "ls" });

    expect(logged("carries no itemId, threadId, turnId")).toBe(true);
    const action = manager.pollEvents(started.sessionId, 0, 50).actions![0]!;
    expect(action.itemId).toBe("");
  });

  it("reports a file change approval that carries no itemId", async () => {
    await manager.createSession("hi", workspace, {}, "medium");

    client.emitServerRequest(2, Methods.FILE_CHANGE_APPROVAL, {
      threadId: "thread_mock",
      turnId: "turn_1",
    });

    expect(logged("carries no itemId")).toBe(true);
  });

  it("reports a user input request that carries no itemId", async () => {
    await manager.createSession("hi", workspace, {}, "medium");

    client.emitServerRequest(3, Methods.USER_INPUT_REQUEST, {
      threadId: "thread_mock",
      turnId: "turn_1",
      questions: [{ id: "q1", question: "which?" }],
    });

    expect(logged("carries no itemId")).toBe(true);
  });

  it("stays silent when every correlation id is there", async () => {
    await manager.createSession("hi", workspace, {}, "medium");

    client.emitServerRequest(4, Methods.COMMAND_APPROVAL, {
      itemId: "item_1",
      threadId: "thread_mock",
      turnId: "turn_1",
      command: "ls",
    });

    expect(logged("carries no")).toBe(false);
  });

  it("reports a turn that completed without a turn id", async () => {
    client.turnStartResult = {};
    const started = await manager.createSession("hi", workspace, {}, "medium");

    client.emitNotification(Methods.TURN_COMPLETED, {
      threadId: started.threadId,
      turn: { status: "completed", output: "done" },
    });

    expect(logged("turn/completed carries no turn id")).toBe(true);
    expect(manager.getLastResult(started.sessionId)?.turnId).toBe("");
  });

  it("falls back to the active turn id without reporting anything", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium");
    client.emitNotification(Methods.TURN_STARTED, { turn: { id: "turn_live" } });

    client.emitNotification(Methods.TURN_COMPLETED, {
      threadId: started.threadId,
      turn: { status: "completed", output: "done" },
    });

    expect(logged("turn/completed carries no turn id")).toBe(false);
    expect(manager.getLastResult(started.sessionId)?.turnId).toBe("turn_live");
  });
});

describe("SessionManager disk persistence", () => {
  const workspace = path.resolve(os.tmpdir(), "codex-mcp-tests");
  let root: string;
  let persistence: SessionPersistence;
  let manager: SessionManager;
  let client: MockAppServerClient;

  /** The manager only records a PID when the client exposes one. */
  class PidClient extends MockAppServerClient {
    childPid: number | undefined = 424242;
  }

  function eventsFile(sessionId: string): string {
    return path.join(root, "sessions", sessionId, "events.jsonl");
  }

  function readEventLines(sessionId: string): Array<Record<string, unknown>> {
    return readFileSync(eventsFile(sessionId), "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "codex-mcp-manager-persistence-"));
    persistence = new SessionPersistence(root);
    client = new PidClient();
    manager = new SessionManager({
      disableCleanup: true,
      persistence,
      createClient: () => client as unknown as AppServerClient,
    });
  });

  afterEach(() => {
    manager.destroy();
    persistence.destroy();
    rmSync(root, { recursive: true, force: true });
  });

  it("writes every buffered event into events.jsonl", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");
    client.emitNotification(Methods.AGENT_MESSAGE_DELTA, {
      threadId,
      itemId: "item_1",
      delta: "hello",
    });
    persistence.flushAll();

    const buffered = manager.pollEvents(sessionId, 0).events;
    const onDisk = readEventLines(sessionId);
    expect(onDisk).toHaveLength(buffered.length);
    // The buffered event and its log line carry one timestamp, not two clock reads.
    expect(onDisk[0]).toEqual({
      seq: buffered[0]!.id,
      type: buffered[0]!.type,
      data: buffered[0]!.data,
      timestamp: buffered[0]!.timestamp,
    });
  });

  it("flushes a critical event at once and holds a normal one until the flush", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");

    client.emitNotification(Methods.AGENT_MESSAGE_DELTA, {
      threadId,
      itemId: "item_1",
      delta: "hello",
    });
    // "output" is batched, so nothing has reached the file yet.
    expect(existsSync(eventsFile(sessionId))).toBe(false);

    client.emitNotification(Methods.TURN_COMPLETED, {
      threadId,
      turnId: "turn_done",
      turn: { status: "completed" },
    });

    // The critical "result" event flushes the batch it sits behind.
    const onDisk = readEventLines(sessionId);
    expect(onDisk.map((e) => e.type)).toEqual(["output", "result"]);
    expect(onDisk.map((e) => e.seq)).toEqual([0, 1]);
  });

  it("logs thread lifecycle and warning notifications with the buffer's numbering", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");

    client.emitNotification(Methods.CONFIG_WARNING, { summary: "unknown key `sandbox_mode`" });
    client.emitNotification(Methods.DEPRECATION_NOTICE, { summary: "`--profile` is deprecated" });
    client.emitNotification(Methods.THREAD_COMPACTED, { threadId, turnId: "turn_compact" });
    client.emitNotification(Methods.THREAD_CLOSED, { threadId });
    // A systemError status is critical, so it flushes the batch sitting behind it.
    client.emitNotification(Methods.THREAD_STATUS_CHANGED, {
      threadId,
      status: { type: "systemError" },
    });

    const buffered = manager.pollEvents(sessionId, 0, 50).events;
    const onDisk = readEventLines(sessionId);
    expect(onDisk.map((e) => e.type)).toEqual([
      "progress",
      "progress",
      "progress",
      "progress",
      "error",
    ]);
    expect(onDisk.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(onDisk.map((e) => ({ seq: e.seq, type: e.type, data: e.data }))).toEqual(
      buffered.map((e) => ({ seq: e.id, type: e.type, data: e.data }))
    );
    expect(onDisk.map((e) => e.timestamp)).toEqual(buffered.map((e) => e.timestamp));
  });

  it("restores a session's events after a restart and continues the seq numbering", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");
    client.emitNotification(Methods.AGENT_MESSAGE_DELTA, {
      threadId,
      itemId: "item_1",
      delta: "hello",
    });
    client.emitNotification(Methods.TURN_COMPLETED, {
      threadId,
      turnId: "turn_done",
      turn: { status: "completed" },
    });
    const beforeRestart = manager.pollEvents(sessionId, 0).events;
    manager.destroy();
    persistence.destroy();

    // Second run: a fresh adapter and manager over the same state dir.
    persistence = new SessionPersistence(root);
    manager = new SessionManager({
      disableCleanup: true,
      persistence,
      createClient: () => client as unknown as AppServerClient,
    });
    const recovered = persistence.recoverSessions();
    manager.ingestRecovered(recovered);

    const afterRestart = manager.pollEvents(sessionId, 0).events;
    // Timestamp included: a restored event carries the instant the client already
    // polled, not the one events.jsonl read a tick later.
    expect(afterRestart).toEqual(beforeRestart);

    // New events continue the numbering instead of overwriting seq 0.
    const seqsBefore = readEventLines(sessionId).map((e) => e.seq);
    await manager.cancelSession(sessionId, "restarted");
    const seqsAfter = readEventLines(sessionId).map((e) => e.seq);
    expect(seqsAfter).toEqual([...seqsBefore, 2, 3]);
    expect(manager.pollEvents(sessionId, 2).events.map((e) => e.id)).toEqual([2, 3]);
  });

  it("stores the pid and the model under their own keys in pid.json", async () => {
    const { sessionId } = await manager.createSession(
      "hi",
      workspace,
      { model: "gpt-5-codex" },
      "medium"
    );

    const pidInfo = JSON.parse(
      readFileSync(path.join(root, "sessions", sessionId, "pid.json"), "utf-8")
    );
    // The orphan reaper matches on pid + spawnedAt; the model only labels the process.
    expect(pidInfo.pid).toBe(client.childPid);
    expect(Number.isNaN(Date.parse(pidInfo.spawnedAt))).toBe(false);
    expect(pidInfo.model).toBe("gpt-5-codex");
    expect(pidInfo.command).toBeUndefined();

    const recoveredPid = persistence.recoverSessions()[0]!.pidInfo!;
    expect(recoveredPid.pid).toBe(client.childPid);
  });

  it("records a process the client spawns after start, as exec does per turn", async () => {
    // ExecClient has no process until its first turn, so the pid reaches disk
    // when the client reports the spawn, not when start() returns.
    const execLike = new MockAppServerClient();
    const execManager = new SessionManager({
      disableCleanup: true,
      persistence,
      createClient: () => execLike as unknown as AppServerClient,
    });
    try {
      const { sessionId } = await execManager.createSession("hi", workspace, {}, "medium");
      expect(existsSync(path.join(root, "sessions", sessionId, "pid.json"))).toBe(false);

      execLike.emit("spawn", 777, "2024-05-05T11:22:33.000Z");

      const pidInfo = JSON.parse(
        readFileSync(path.join(root, "sessions", sessionId, "pid.json"), "utf-8")
      );
      expect(pidInfo.pid).toBe(777);
    } finally {
      execManager.destroy();
    }
  });

  it("dates the pid record by the spawn, not by the end of the handshake", async () => {
    const { sessionId } = await manager.createSession(
      "hi",
      workspace,
      { model: "gpt-5-codex" },
      "medium"
    );

    const record = JSON.parse(
      readFileSync(path.join(root, "sessions", sessionId, "pid.json"), "utf-8")
    ) as { pid: number; spawnedAt: string; model?: string };

    expect(record.pid).toBe(client.childPid);
    expect(record.model).toBe("gpt-5-codex");
    // The reaper matches this against the OS start time within five seconds, so it carries
    // the spawn instant the client reported rather than the clock at write time.
    expect(record.spawnedAt).toBe(client.spawnedAt);
  });

  it("leaves nothing on disk when the session fails to start", async () => {
    client.threadStart.mockRejectedValueOnce(new Error("thread/start refused"));

    await expect(manager.createSession("hi", workspace, {}, "medium")).rejects.toThrow(
      "thread/start refused"
    );

    expect(readdirSync(path.join(root, "sessions"))).toEqual([]);
    expect(persistence.recoverSessions()).toEqual([]);
  });

  it("keeps the cancellation result readable after a restart", async () => {
    const { sessionId } = await manager.createSession("hi", workspace, {}, "medium");
    await manager.cancelSession(sessionId, "user stopped it");
    persistence.flushAll();

    const restarted = new SessionManager({ disableCleanup: true, persistence });
    try {
      restarted.ingestRecovered(persistence.recoverSessions());
      const result = restarted.getLastResult(sessionId);
      expect(result?.status).toBe("cancelled");
      expect(result?.error).toBe("user stopped it");
    } finally {
      restarted.destroy();
    }
  });

  it("keeps the session alive and reports once when the event log cannot be written", async () => {
    const errors: string[] = [];
    const consoleError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };

    try {
      const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");
      // A plain file where the session directory belongs makes every write fail.
      const dir = path.join(root, "sessions", sessionId);
      rmSync(dir, { recursive: true, force: true });
      writeFileSync(dir, "not a directory");

      client.emitNotification(Methods.AGENT_MESSAGE_DELTA, {
        threadId,
        itemId: "item_1",
        delta: "one",
      });
      client.emitNotification(Methods.AGENT_MESSAGE_DELTA, {
        threadId,
        itemId: "item_2",
        delta: "two",
      });

      expect(manager.pollEvents(sessionId, 0).events).toHaveLength(2);
      expect(errors.filter((line) => line.includes("Failed to persist events"))).toHaveLength(1);
    } finally {
      console.error = consoleError;
    }
  });

  it("redacts absolute paths inside an error notification's error object", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");
    client.emitNotification(Methods.ERROR, {
      threadId,
      error: { message: "cannot read /home/someone/secret/file.ts", type: "io" },
    });

    const errorEvent = manager.pollEvents(sessionId, 0).events.find((e) => e.type === "error") as {
      data: { error: { message: string } };
    };
    expect(errorEvent.data.error.message).toBe("cannot read <path>");
    expect(errorEvent.data.error).toMatchObject({ type: "io" });
  });
});
