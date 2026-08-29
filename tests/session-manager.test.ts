import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppServerClient } from "../src/app-server/client.js";
import { Methods } from "../src/app-server/protocol.js";
import { SessionManager } from "../src/session/manager.js";
import { SessionPersistence } from "../src/session/persistence.js";
import { executeCodexCheck } from "../src/tools/codex-check.js";
import { DEFAULT_POLL_INTERVAL, WAITING_APPROVAL_POLL_INTERVAL } from "../src/types.js";
import { advanceAsync } from "./helpers/clock.js";
import { present } from "./helpers/present.js";

class MockAppServerClient extends EventEmitter {
  notificationHandler: ((method: string, params: unknown) => void) | null = null;
  serverRequestHandler: ((id: number, method: string, params: unknown) => void) | null = null;

  threadStartResult: unknown = { thread: { id: "thread_mock" } };
  turnStartResult: unknown = { turn: { id: "turn_mock" } };
  threadForkResult: unknown = { thread: { id: "thread_forked" } };
  threadResumeResult: unknown = { thread: { id: "thread_forked" } };

  childPid: number | undefined = undefined;
  /** Spawn instant reported with the "spawn" event, as the real clients report theirs. */
  spawnedAt = "2024-05-05T10:00:00.000Z";

  start = jest.fn(async () => {
    if (this.childPid !== undefined) this.emit("spawn", this.childPid, this.spawnedAt);
    return { userAgent: "mock" };
  });
  threadStart = jest.fn(async () => this.threadStartResult);
  threadFork = jest.fn(async () => this.threadForkResult);
  threadResume = jest.fn(async () => this.threadResumeResult);
  threadDelete = jest.fn(async (_params: { threadId: string }) => ({}));
  turnStart = jest.fn(async () => this.turnStartResult);
  turnInterrupt = jest.fn(async () => {});

  respondToServer = jest.fn((_id: number, _result: unknown) => {});
  respondErrorToServer = jest.fn((_id: number, _code: number, _message: string) => {});
  destroy = jest.fn(async () => {});

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

  it("refuses a thread/start response that puts the id outside `thread`", async () => {
    // Every response of the bundle carrying a thread id carries it as
    // `thread.id` (codex-schema/v2/ThreadStartResponse.json). An id found
    // anywhere else belongs to no known backend, and adopting it would start a
    // session against a thread this server cannot address.
    client.threadStartResult = { threadId: "thread_v1" };
    await expect(manager.createSession("hi", workspace, {}, "medium")).rejects.toThrow(
      /missing thread id/
    );
  });

  it("refuses a thread/fork response that puts the id outside `thread`", async () => {
    const { sessionId } = await manager.createSession("hi", workspace, {}, "medium");
    client.threadForkResult = { threadId: "thread_fork_v1" };
    await expect(manager.forkSession(sessionId)).rejects.toThrow(/missing thread id/);
  });

  it("cleans up forked session resources when the new app-server fails to start", async () => {
    const originalClient = new MockAppServerClient();
    const forkClient = new MockAppServerClient();
    forkClient.start = jest.fn(async () => {
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
      // The fork answered and nothing else ever saw the thread, so the server
      // takes it back off the process that made it.
      expect(originalClient.threadDelete).toHaveBeenCalledWith({ threadId: "thread_forked" });
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
    forkClient.threadResume = jest.fn(async () => {
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
      // The fork answered and nothing else ever saw the thread, so the server
      // takes it back off the process that made it.
      expect(originalClient.threadDelete).toHaveBeenCalledWith({ threadId: "thread_forked" });
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
    forkClient.threadResume = jest.fn(async () => {
      throw new Error("resume failed");
    });
    forkClient.destroy = jest.fn(async () => {
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

  it("still reports the fork failure when thread/delete cannot remove the leftover", async () => {
    const originalClient = new MockAppServerClient();
    originalClient.threadDelete = jest.fn(async () => {
      throw new Error("delete failed");
    });
    const forkClient = new MockAppServerClient();
    forkClient.threadResume = jest.fn(async () => {
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
      // The caller is told why the fork failed; a leftover thread it cannot act
      // on does not change that error.
      await expect(forkManager.forkSession(started.sessionId)).rejects.toThrow(
        "THREAD_FORK_RESUME_FAILED"
      );
      expect(originalClient.threadDelete).toHaveBeenCalledTimes(1);
      expect(forkManager.listSessions()).toHaveLength(1);
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

    const running = manager.pollStatus(sessionId);
    expect(running.status).toBe("running");
    expect(running.pollInterval).toBe(DEFAULT_POLL_INTERVAL);

    client.emitServerRequest(31, Methods.COMMAND_APPROVAL, {
      itemId: "item_poll_hint",
      threadId,
      turnId: "turn_1",
      command: "echo hi",
      cwd: workspace,
    });

    const waiting = manager.pollStatus(sessionId);
    expect(waiting.status).toBe("waiting_approval");
    expect(waiting.pollInterval).toBe(WAITING_APPROVAL_POLL_INTERVAL);

    await manager.cancelSession(sessionId, "done");
    const terminal = manager.pollStatus(sessionId);
    expect(terminal.pollInterval).toBeUndefined();
  });

  it("exposes best-effort observed default model from recent sessions", async () => {
    expect(manager.getObservedDefaultModel()).toBeNull();

    await manager.createSession("hi", workspace, { model: "o4-mini" }, "medium");
    expect(manager.getObservedDefaultModel()).toBe("o4-mini");

    await manager.createSession("hello", workspace, { model: "o4" }, "medium");
    expect(manager.getObservedDefaultModel()).toBe("o4");
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

    const poll1 = manager.pollStatus(sessionId);
    expect(poll1.status).toBe("waiting_approval");
    expect(poll1.actions?.length).toBe(1);

    const requestId = poll1.actions[0].requestId;
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
    expect(manager.pollStatus(sessionId).actions).toEqual([]);
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

    const poll = manager.pollStatus(sessionId);
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

    const poll1 = manager.pollStatus(sessionId);
    const capturedRequestId = poll1.actions?.[0]?.requestId;
    expect(capturedRequestId).toBeDefined();
    const requestId = present(capturedRequestId, "the pending request id");

    client.respondToServer.mockImplementationOnce(() => {
      throw new Error("write queue dropped");
    });
    const failed = executeCodexCheck(
      {
        action: "respond_permission",
        sessionId,
        requestId,
        decision: "accept",
      },
      manager
    ) as { isError?: boolean; error?: string };
    expect(failed.isError).toBe(true);
    expect(failed.error).toContain("INTERNAL");

    const stillPending = manager.pollStatus(sessionId);
    expect(stillPending.status).toBe("waiting_approval");
    expect(stillPending.actions?.some((action) => action.requestId === requestId)).toBe(true);

    const retry = executeCodexCheck(
      {
        action: "respond_permission",
        sessionId,
        requestId,
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

    const poll1 = manager.pollStatus(sessionId);
    const capturedRequestId = poll1.actions?.[0]?.requestId;
    expect(capturedRequestId).toBeDefined();
    const requestId = present(capturedRequestId, "the pending request id");

    client.respondToServer.mockImplementationOnce(() => {
      throw new Error("write queue dropped");
    });
    const failed = executeCodexCheck(
      {
        action: "respond_permission",
        sessionId,
        requestId,
        decision: "accept",
      },
      manager
    ) as { isError?: boolean; error?: string };
    expect(failed.isError).toBe(true);
    expect(failed.error).toContain("INTERNAL");

    const stillPending = manager.pollStatus(sessionId);
    expect(stillPending.status).toBe("waiting_approval");
    expect(stillPending.actions?.some((action) => action.requestId === requestId)).toBe(true);

    const retry = executeCodexCheck(
      {
        action: "respond_permission",
        sessionId,
        requestId,
        decision: "accept",
      },
      manager
    );
    expect((retry as { isError?: boolean }).isError).not.toBe(true);
    expect(manager.getSession(sessionId).pendingRequestCount).toBe(0);
  });

  it("responds to user input request and clears pending request", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");
    client.emitServerRequest(12, Methods.USER_INPUT_REQUEST, {
      itemId: "item_ui_1",
      threadId,
      turnId: "turn_1",
      questions: [{ id: "q1", question: "Pick one" }],
    });

    const poll1 = manager.pollStatus(sessionId);
    expect(poll1.status).toBe("waiting_approval");
    expect(poll1.actions?.length).toBe(1);
    expect(poll1.actions?.[0]?.type).toBe("user_input");

    const requestId = poll1.actions[0].requestId;
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

  it("sends a secret answer to codex unchanged and clears the request", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");
    // ToolRequestUserInputQuestion marks a question whose answer must not be
    // written down (codex-schema/ToolRequestUserInputParams.json).
    client.emitServerRequest(120, Methods.USER_INPUT_REQUEST, {
      itemId: "item_ui_secret",
      threadId,
      turnId: "turn_1",
      questions: [
        { id: "token", header: "Auth", question: "API key?", isSecret: true },
        { id: "env", header: "Env", question: "Which environment?" },
      ],
    });

    const requestId = manager.pollStatus(sessionId).actions[0].requestId;
    const answers = { token: { answers: ["sk-live-123"] }, env: { answers: ["staging"] } };
    manager.resolveUserInput(sessionId, requestId, answers);

    expect(client.respondToServer).toHaveBeenCalledWith(120, { answers });
    expect(manager.pollStatus(sessionId).actions).toEqual([]);
  });

  it("returns INTERNAL and keeps user_input pending when forwarding response fails", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");
    client.emitServerRequest(102, Methods.USER_INPUT_REQUEST, {
      itemId: "item_forward_fail_ui",
      threadId,
      turnId: "turn_1",
      questions: [{ id: "q1", question: "Pick one" }],
    });

    const poll1 = manager.pollStatus(sessionId);
    const capturedRequestId = poll1.actions?.[0]?.requestId;
    expect(capturedRequestId).toBeDefined();
    const requestId = present(capturedRequestId, "the pending request id");

    client.respondToServer.mockImplementationOnce(() => {
      throw new Error("write queue dropped");
    });
    const failed = executeCodexCheck(
      {
        action: "respond_user_input",
        sessionId,
        requestId,
        answers: { q1: { answers: ["A"] } },
      },
      manager
    ) as { isError?: boolean; error?: string };
    expect(failed.isError).toBe(true);
    expect(failed.error).toContain("INTERNAL");

    const stillPending = manager.pollStatus(sessionId);
    expect(stillPending.status).toBe("waiting_approval");
    expect(stillPending.actions?.some((action) => action.requestId === requestId)).toBe(true);

    const retry = executeCodexCheck(
      {
        action: "respond_user_input",
        sessionId,
        requestId,
        answers: { q1: { answers: ["A"] } },
      },
      manager
    );
    expect((retry as { isError?: boolean }).isError).not.toBe(true);
    expect(manager.getSession(sessionId).pendingRequestCount).toBe(0);
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

    const poll1 = manager.pollStatus(sessionId);
    const capturedRequestId = poll1.actions?.[0]?.requestId;
    expect(capturedRequestId).toBeDefined();
    const requestId = present(capturedRequestId, "the pending request id");

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
    expect(client.respondToServer).toHaveBeenCalledWith(41, { decision: "accept" });
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

    const poll = manager.pollStatus(sessionId);
    expect(poll.status).toBe("waiting_approval");
    expect(poll.actions?.length).toBe(2);
    expect(poll.actions?.every((action) => action.reason === undefined)).toBe(true);
  });

  it("rejects invalid decision for fileChange approval via tool wrapper", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");
    client.emitServerRequest(2, Methods.FILE_CHANGE_APPROVAL, {
      itemId: "item_fc_1",
      threadId,
      turnId: "turn_1",
      reason: "test",
    });

    const poll1 = manager.pollStatus(sessionId);
    const requestId = poll1.actions[0].requestId;
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

    const poll1 = manager.pollStatus(sessionId);
    const requestId = poll1.actions[0].requestId;
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

    const poll1 = manager.pollStatus(sessionId);
    const requestId = poll1.actions[0].requestId;
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

    const poll1 = manager.pollStatus(sessionId);
    const requestId = poll1.actions[0].requestId;
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

    const poll1 = manager.pollStatus(sessionId);
    const requestId = poll1.actions[0].requestId;
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

    const poll1 = manager.pollStatus(sessionId);
    const requestId = poll1.actions[0].requestId;

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

    const poll1 = manager.pollStatus(sessionId);
    const capturedRequestId = poll1.actions?.[0]?.requestId;
    expect(capturedRequestId).toBeDefined();
    const requestId = present(capturedRequestId, "the pending request id");

    const out = executeCodexCheck(
      {
        action: "respond_permission",
        sessionId,
        requestId,
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

    const poll1 = manager.pollStatus(sessionId);
    const capturedRequestId = poll1.actions?.[0]?.requestId;
    expect(capturedRequestId).toBeDefined();
    const requestId = present(capturedRequestId, "the pending request id");

    const out = executeCodexCheck(
      {
        action: "respond_user_input",
        sessionId,
        requestId,
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
    jest.useFakeTimers();
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
      expect(manager.pollStatus(sessionId).actions?.length).toBe(1);

      await advanceAsync(10);

      expect(client.respondToServer).toHaveBeenCalledWith(11, { decision: "decline" });
      expect(manager.getSession(sessionId).pendingRequestCount).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it("auto-answers user input with empty answers on timeout", async () => {
    jest.useFakeTimers();
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

      expect(manager.pollStatus(sessionId).actions?.length).toBe(1);
      await advanceAsync(10);

      expect(client.respondToServer).toHaveBeenCalledWith(13, { answers: {} });
      const poll = manager.pollStatus(sessionId);
      expect(poll.actions).toEqual([]);
      expect(poll.status).toBe("running");
      expect(manager.getSession(sessionId).pendingRequestCount).toBe(0);
    } finally {
      jest.useRealTimers();
    }
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

    expect(manager.pollStatus(sessionId).actions?.length).toBe(1);

    client.emit("exit", 1, null);
    const poll = manager.pollStatus(sessionId);
    expect(poll.status).toBe("error");
    expect(poll.actions).toEqual([]);
    expect(poll.result?.status).toBe("error");
    expect(poll.result?.error).toContain("app-server exited unexpectedly");
    expect(manager.getSession(sessionId).pendingRequestCount).toBe(0);
  });

  it("keeps the session running while the backend says it will retry", async () => {
    const { sessionId } = await manager.createSession("hi", workspace, {}, "medium");

    // ErrorNotification carries [error, threadId, turnId, willRetry]
    // (codex-schema/v2/ErrorNotification.json); the text lives in error.message.
    client.emitNotification(Methods.ERROR, {
      threadId: "thread_mock",
      turnId: "turn_mock",
      error: { message: "temporary disconnect" },
      willRetry: true,
    });

    const poll = manager.pollStatus(sessionId);
    expect(poll.status).toBe("running");
    expect(poll.result).toBeUndefined();
  });

  it("keeps terminal error semantics for non-retryable app-server errors", async () => {
    const { sessionId } = await manager.createSession("hi", workspace, {}, "medium");

    client.emitNotification(Methods.ERROR, {
      threadId: "thread_mock",
      turnId: "turn_mock",
      error: { message: "fatal error" },
      willRetry: false,
    });

    const poll = manager.pollStatus(sessionId);
    expect(poll.status).toBe("error");
  });

  it("produces a terminal result when cancelled", async () => {
    const { sessionId } = await manager.createSession("hi", workspace, {}, "medium");

    await manager.cancelSession(sessionId, "Cancelled by test");

    const poll = manager.pollStatus(sessionId);
    expect(poll.status).toBe("cancelled");
    expect(poll.pollInterval).toBeUndefined();
    expect(poll.actions).toEqual([]);
    expect(poll.result?.status).toBe("cancelled");
    expect(poll.result?.error).toContain("Cancelled by test");
  });

  it("deduplicates concurrent cancellation and destroys client once", async () => {
    let releaseDestroy: (() => void) | undefined;
    const destroyGate = new Promise<void>((resolve) => {
      releaseDestroy = resolve;
    });
    client.destroy = jest.fn(async () => {
      await destroyGate;
    });

    const { sessionId } = await manager.createSession("hi", workspace, {}, "medium");

    const cancel1 = manager.cancelSession(sessionId, "one");
    const cancel2 = manager.cancelSession(sessionId, "two");

    await Promise.resolve();
    expect(client.destroy).toHaveBeenCalledTimes(1);

    releaseDestroy?.();
    await Promise.all([cancel1, cancel2]);
    expect(manager.pollStatus(sessionId).status).toBe("cancelled");
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

    const poll = manager.pollStatus(sessionId);
    expect(client.respondToServer).toHaveBeenCalledWith(77, { decision: "cancel" });
    expect(poll.status).toBe("cancelled");
    expect(poll.actions).toEqual([]);
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
    expect(manager.pollStatus(sessionId).actions).toEqual([]);
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
    expect(manager.pollStatus(sessionId).actions).toEqual([]);
  });

  it("ignores late turn/completed notifications after cancellation", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");
    await manager.cancelSession(sessionId, "Cancelled by test");

    client.emitNotification(Methods.TURN_COMPLETED, {
      threadId,
      turnId: "turn_late",
      turn: { status: "completed", output: "should be ignored" },
    });

    const poll = manager.pollStatus(sessionId);
    expect(poll.status).toBe("cancelled");
    expect(poll.result?.status).toBe("cancelled");
    expect(poll.result?.turnId).not.toBe("turn_late");
  });

  it("unrefs approval timeout timers so they do not block process exit", async () => {
    const unrefSpy = jest.fn();
    const timeoutHandle = { unref: unrefSpy } as unknown as ReturnType<typeof setTimeout>;
    const setTimeoutSpy = jest.spyOn(globalThis, "setTimeout").mockImplementation(((
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

    const poll = manager.pollStatus(sessionId);
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
    expect(manager.pollStatus(sessionId).status).toBe("idle");

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
  it("keeps the session running when a waiting status outruns the approval request", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");

    client.emitNotification(Methods.THREAD_STATUS_CHANGED, {
      threadId,
      status: { type: "active", activeFlags: ["waitingOnApproval"] },
    });

    // No request has arrived, so there is nothing a caller could answer yet.
    const early = manager.pollStatus(sessionId);
    expect(early.status).toBe("running");
    expect(early.actions).toEqual([]);

    client.emitServerRequest(701, Methods.COMMAND_APPROVAL, {
      itemId: "item_race_early",
      threadId,
      turnId: "turn_race",
      command: "rm -rf /tmp/x",
      cwd: workspace,
    });

    const withRequest = manager.pollStatus(sessionId);
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
    const pending = manager.pollStatus(sessionId);
    expect(pending.status).toBe("waiting_approval");
    manager.resolveApproval(sessionId, pending.actions[0].requestId, "accept");
    expect(manager.pollStatus(sessionId).status).toBe("running");

    // The status change codex sent while the request was open lands afterwards.
    client.emitNotification(Methods.THREAD_STATUS_CHANGED, {
      threadId,
      status: { type: "active", activeFlags: ["waitingOnApproval"] },
    });

    const late = manager.pollStatus(sessionId);
    expect(late.status).toBe("running");
    expect(late.actions).toEqual([]);
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
    const pending = manager.pollStatus(sessionId);

    client.emitNotification(Methods.THREAD_STATUS_CHANGED, { threadId, status: { type: "idle" } });
    expect(manager.pollStatus(sessionId).status).toBe("waiting_approval");

    manager.resolveApproval(sessionId, pending.actions[0].requestId, "accept");
    client.emitNotification(Methods.THREAD_STATUS_CHANGED, { threadId, status: { type: "idle" } });
    expect(manager.pollStatus(sessionId).status).toBe("idle");
  });

  it("leaves the session untouched for a notLoaded thread status", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");

    client.emitNotification(Methods.THREAD_STATUS_CHANGED, {
      threadId,
      status: { type: "notLoaded" },
    });

    expect(manager.pollStatus(sessionId).status).toBe("running");
  });

  it("fails the session on a systemError thread status and keeps it failed", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");

    client.emitNotification(Methods.THREAD_STATUS_CHANGED, {
      threadId,
      status: { type: "systemError" },
    });

    expect(manager.pollStatus(sessionId).status).toBe("error");

    // A terminal session stays terminal, whatever codex reports next.
    client.emitNotification(Methods.THREAD_STATUS_CHANGED, { threadId, status: { type: "idle" } });
    expect(manager.pollStatus(sessionId).status).toBe("error");
  });

  it("keeps a cancelled session cancelled when a thread status arrives late", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");
    await manager.cancelSession(sessionId, "stop");

    client.emitNotification(Methods.THREAD_STATUS_CHANGED, {
      threadId,
      status: { type: "active", activeFlags: ["waitingOnUserInput"] },
    });

    expect(manager.pollStatus(sessionId).status).toBe("cancelled");
  });
});

describe("SessionManager missing protocol ids", () => {
  let manager: SessionManager;
  let client: MockAppServerClient;
  let errors: ReturnType<typeof jest.spyOn>;
  const workspace = path.resolve(os.tmpdir(), "codex-mcp-tests");

  beforeEach(() => {
    errors = jest.spyOn(console, "error").mockImplementation(() => {});
    client = new MockAppServerClient();
    manager = new SessionManager({
      disableCleanup: true,
      createClient: () => client as unknown as AppServerClient,
    });
  });

  afterEach(() => {
    manager.destroy();
    jest.restoreAllMocks();
  });

  function logged(fragment: string): boolean {
    return errors.mock.calls.some((call) => String(call[0]).includes(fragment));
  }

  it("reports an approval request that carries none of its correlation ids", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium");

    client.emitServerRequest(1, Methods.COMMAND_APPROVAL, { command: "ls" });

    expect(logged("carries no itemId, threadId, turnId")).toBe(true);
    const action = manager.pollStatus(started.sessionId).actions[0];
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

  it("writes the events of a turn into events.jsonl", async () => {
    // The caller is told the session state; the events of the turn go to disk, for
    // whoever opens the state directory.
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");
    client.emitNotification(Methods.AGENT_MESSAGE_DELTA, {
      threadId,
      itemId: "item_1",
      delta: "hello",
    });
    persistence.flushAll();

    const onDisk = readEventLines(sessionId);
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0].seq).toBe(0);
    expect(onDisk[0].type).toBe("output");
    expect(onDisk[0].data).toEqual({
      method: Methods.AGENT_MESSAGE_DELTA,
      delta: "hello",
      itemId: "item_1",
    });
    expect(Number.isNaN(Date.parse(String(onDisk[0].timestamp)))).toBe(false);
    // And nothing of it reaches the caller.
    expect(manager.pollStatus(sessionId)).not.toHaveProperty("events");
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

  it("logs thread lifecycle and warning notifications in order", async () => {
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

    const onDisk = readEventLines(sessionId);
    expect(onDisk.map((e) => e.type)).toEqual([
      "progress",
      "progress",
      "progress",
      "progress",
      "error",
    ]);
    expect(onDisk.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]);
    expect((onDisk[0].data as { summary?: string }).summary).toBe("unknown key `sandbox_mode`");
    expect(manager.pollStatus(sessionId).status).toBe("error");
  });

  it("continues the event-log numbering after a restart", async () => {
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

    // The recovered session reports the result the previous run wrote.
    expect(manager.pollStatus(sessionId).result).toMatchObject({ status: "completed" });

    // New events continue the numbering instead of overwriting seq 0.
    const seqsBefore = readEventLines(sessionId).map((e) => e.seq);
    expect(seqsBefore).toEqual([0, 1]);
    await manager.cancelSession(sessionId, "restarted");
    const seqsAfter = readEventLines(sessionId).map((e) => e.seq);
    expect(seqsAfter).toEqual([...seqsBefore, 2, 3]);
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

    const recoveredPid = present(
      persistence.recoverSessions()[0].pidInfo,
      "the pid info of the recovered session"
    );
    expect(recoveredPid.pid).toBe(client.childPid);
  });

  it("records the pid when the client reports the spawn, not when start resolves", async () => {
    const lateSpawn = new MockAppServerClient();
    const lateManager = new SessionManager({
      disableCleanup: true,
      persistence,
      createClient: () => lateSpawn as unknown as AppServerClient,
    });
    try {
      const { sessionId } = await lateManager.createSession("hi", workspace, {}, "medium");
      expect(existsSync(path.join(root, "sessions", sessionId, "pid.json"))).toBe(false);

      lateSpawn.emit("spawn", 777, "2024-05-05T11:22:33.000Z");

      const pidInfo = JSON.parse(
        readFileSync(path.join(root, "sessions", sessionId, "pid.json"), "utf-8")
      );
      expect(pidInfo.pid).toBe(777);
    } finally {
      lateManager.destroy();
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

      // The session goes on from memory, and the failure is reported once.
      expect(manager.pollStatus(sessionId).status).toBe("running");
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

    persistence.flushAll();
    const errorLine = readEventLines(sessionId).find((line) => line.type === "error") as {
      data: { error: { message: string; type: string } };
    };
    expect(errorLine.data.error.message).toBe("cannot read <path>");
    expect(errorLine.data.error).toMatchObject({ type: "io" });
  });

  function sessionFile(sessionId: string, name: string): string {
    return path.join(root, "sessions", sessionId, name);
  }

  function readSessionJson(sessionId: string, name: string): Record<string, unknown> {
    return JSON.parse(readFileSync(sessionFile(sessionId, name), "utf-8")) as Record<
      string,
      unknown
    >;
  }

  it("keeps the answer of the finished turn in result.json when a cancel follows it", async () => {
    // A caller that polls the result and then cancels the session leaves the session
    // with an answer; result.json is that answer, and the cancel is recorded beside it.
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "medium");
    client.emitNotification(Methods.ITEM_COMPLETED, {
      threadId,
      item: { id: "item_1", type: "agentMessage", text: "42" },
    });
    client.emitNotification(Methods.TURN_COMPLETED, {
      threadId,
      turn: { id: "turn_done", status: "completed" },
    });
    const delivered = manager.pollStatus(sessionId).result;
    expect(delivered).toMatchObject({ turnId: "turn_done", status: "completed", text: "42" });

    await manager.cancelSession(sessionId, "caller took the result");
    persistence.flushAll();

    expect(readSessionJson(sessionId, "result.json")).toEqual(delivered);
    expect(readSessionJson(sessionId, "meta.json")).toMatchObject({
      status: "cancelled",
      cancelledReason: "caller took the result",
    });
    // The cancellation is not lost: the event log carries it after the turn's result.
    expect(
      readEventLines(sessionId)
        .filter((line) => line.type === "result")
        .map((line) => (line.data as { status?: string }).status)
    ).toEqual(["completed", "cancelled"]);
  });

  it("writes the cancellation to result.json when the cancel cuts a running turn", async () => {
    const { sessionId } = await manager.createSession("hi", workspace, {}, "medium");
    await manager.cancelSession(sessionId, "user stopped it");

    expect(readSessionJson(sessionId, "result.json")).toMatchObject({
      status: "cancelled",
      error: "user stopped it",
    });
  });

  it("records every thread parameter a resumed turn needs in meta.json", async () => {
    const { sessionId } = await manager.createSession(
      "hi",
      workspace,
      {
        model: "gpt-5-codex",
        profile: "work",
        approvalPolicy: "never",
        sandbox: "read-only",
        config: { model_provider: "oss" },
      },
      "high",
      {
        summary: "detailed",
        personality: "friendly",
        baseInstructions: "be terse",
        approvalTimeoutMs: 4242,
      }
    );

    expect(readSessionJson(sessionId, "meta.json")).toMatchObject({
      model: "gpt-5-codex",
      profile: "work",
      approvalPolicy: "never",
      sandbox: "read-only",
      config: { model_provider: "oss" },
      effort: "high",
      summary: "detailed",
      personality: "friendly",
      baseInstructions: "be terse",
      approvalTimeoutMs: 4242,
    });
  });

  it("runs the turn after a restart and resume with the effort the session was started with", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "high", {
      summary: "detailed",
      personality: "friendly",
      baseInstructions: "be terse",
    });
    client.emitNotification(Methods.TURN_COMPLETED, {
      threadId,
      turn: { id: "turn_done", status: "completed" },
    });

    // Second run: a fresh adapter and manager, so every parameter comes off disk.
    manager.destroy();
    persistence.destroy();
    persistence = new SessionPersistence(root);
    manager = new SessionManager({
      disableCleanup: true,
      persistence,
      createClient: () => client as unknown as AppServerClient,
    });
    manager.ingestRecovered(persistence.recoverSessions());

    await manager.resumeSession(sessionId);
    const [resumeParams] = client.threadResume.mock.calls.at(-1) as [
      { personality?: string; baseInstructions?: string },
    ];
    expect(resumeParams).toMatchObject({ personality: "friendly", baseInstructions: "be terse" });

    await manager.replyToSession(sessionId, "and again");
    const [turnParams] = client.turnStart.mock.calls.at(-1) as [
      { effort?: string; summary?: string; personality?: string },
    ];
    expect(turnParams).toMatchObject({
      effort: "high",
      summary: "detailed",
      personality: "friendly",
    });
  });

  it("keeps the newest turn override as the session's own parameter", async () => {
    const { sessionId, threadId } = await manager.createSession("hi", workspace, {}, "low");
    client.emitNotification(Methods.TURN_COMPLETED, {
      threadId,
      turn: { id: "turn_done", status: "completed" },
    });

    await manager.replyToSession(sessionId, "harder", { effort: "xhigh" });
    expect(readSessionJson(sessionId, "meta.json")).toMatchObject({ effort: "xhigh" });

    client.emitNotification(Methods.TURN_COMPLETED, {
      threadId,
      turn: { id: "turn_two", status: "completed" },
    });
    await manager.replyToSession(sessionId, "again");
    const [turnParams] = client.turnStart.mock.calls.at(-1) as [{ effort?: string }];
    expect(turnParams.effort).toBe("xhigh");
  });
});
