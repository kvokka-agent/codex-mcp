/**
 * executeCodexCheck: long-polling, response shaping and the approval /
 * user-input decision branches.
 *
 * The session manager is real; only the app-server client is a stand-in, so
 * every asserted value is produced by the code under test.
 */
import { EventEmitter } from "events";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppServerClient } from "../src/app-server/client.js";
import { Methods } from "../src/app-server/protocol.js";
import { SessionManager } from "../src/session/manager.js";
import { executeCodexCheck, type CodexCheckParams } from "../src/tools/codex-check.js";
import type { CheckResult } from "../src/types.js";

class MockClient extends EventEmitter {
  notificationHandler: ((method: string, params: unknown) => void) | null = null;
  serverRequestHandler: ((id: number, method: string, params: unknown) => void) | null = null;

  supportsTurnOverrides = true;
  childPid: number | undefined = undefined;

  start = vi.fn(async () => ({ userAgent: "mock" }));
  threadStart = vi.fn(async () => ({ thread: { id: "thread_mock" } }));
  threadFork = vi.fn(async () => ({ thread: { id: "thread_forked" } }));
  threadResume = vi.fn(async () => ({ thread: { id: "thread_forked" } }));
  threadBackgroundTerminalsClean = vi.fn(async () => ({}));
  turnStart = vi.fn(async () => ({ turn: { id: "turn_mock" } }));
  turnInterrupt = vi.fn(async () => {});
  respondToServer = vi.fn();
  respondErrorToServer = vi.fn();
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

type ErrorResult = { error: string; isError: true };

function isErrorResult(value: unknown): value is ErrorResult {
  return typeof value === "object" && value !== null && (value as ErrorResult).isError === true;
}

function expectError(value: unknown): ErrorResult {
  expect(isErrorResult(value), `expected an error result, got ${JSON.stringify(value)}`).toBe(true);
  return value as ErrorResult;
}

function expectCheck(value: unknown): CheckResult {
  expect(isErrorResult(value), `expected a check result, got ${JSON.stringify(value)}`).toBe(false);
  return value as CheckResult;
}

describe("executeCodexCheck", () => {
  let manager: SessionManager;
  let client: MockClient;
  let sessionId: string;
  const workspace = path.resolve(os.tmpdir());

  beforeEach(async () => {
    client = new MockClient();
    manager = new SessionManager({
      disableCleanup: true,
      createClient: () => client as unknown as AppServerClient,
    });
    ({ sessionId } = await manager.createSession("hi", workspace, {}, "low"));
  });

  afterEach(() => {
    manager.destroy();
    vi.restoreAllMocks();
  });

  function emitOutput(delta: string, extra: Record<string, unknown> = {}): void {
    client.emitNotification(Methods.AGENT_MESSAGE_DELTA, {
      threadId: "thread_mock",
      turnId: "turn_mock",
      itemId: `item_${delta}`,
      delta,
      ...extra,
    });
  }

  function requestApproval(id = 1): void {
    client.emitServerRequest(id, Methods.COMMAND_APPROVAL, {
      itemId: "item_cmd",
      threadId: "thread_mock",
      turnId: "turn_mock",
      reason: "needs the network",
      approvalId: "appr_1",
      command: ["curl", "https://example.com"],
      availableDecisions: ["accept", "decline", "applyNetworkPolicyAmendment"],
    });
  }

  function pendingRequestId(): string {
    const actions = expectCheck(
      executeCodexCheck({ action: "poll", sessionId, cursor: 0, maxEvents: 50 }, manager)
    ).actions;
    expect(actions, "no pending actions").toBeDefined();
    return actions![0].requestId;
  }

  describe("poll", () => {
    it("rejects respond-only fields", () => {
      const res = expectError(
        executeCodexCheck({ action: "poll", sessionId, requestId: "req_1" }, manager)
      );
      expect(res.error).toContain("only valid for respond_* actions");
    });

    it("raises maxEvents to the poll minimum instead of returning nothing", () => {
      emitOutput("A");
      emitOutput("B");

      const res = expectCheck(
        executeCodexCheck({ action: "poll", sessionId, cursor: 0, maxEvents: 0 }, manager)
      );

      expect(res.events).toHaveLength(1);
      expect(res.nextCursor).toBe(1);
    });

    it("floors a fractional maxEvents", () => {
      emitOutput("A");
      emitOutput("B");
      emitOutput("C");

      const res = expectCheck(
        executeCodexCheck({ action: "poll", sessionId, cursor: 0, maxEvents: 2.9 }, manager)
      );

      expect(res.events).toHaveLength(2);
    });

    it("lets an unknown session throw so the tool layer formats it", () => {
      expect(() => executeCodexCheck({ action: "poll", sessionId: "sess_x" }, manager)).toThrow(
        "Error [SESSION_NOT_FOUND]: Session 'sess_x' not found"
      );
    });

    it("adds interaction state and next action for a running session", () => {
      const res = expectCheck(executeCodexCheck({ action: "poll", sessionId }, manager));

      expect(res.status).toBe("running");
      expect(res.interactionState).toBe("working");
      expect(res.recommendedNextAction).toBe("poll");
    });

    it("recommends answering the pending approval when one is waiting", () => {
      requestApproval();

      const res = expectCheck(executeCodexCheck({ action: "poll", sessionId }, manager));

      expect(res.status).toBe("waiting_approval");
      expect(res.interactionState).toBe("waiting_input");
      expect(res.recommendedNextAction).toBe("respond_permission");
    });

    it("recommends answering a pending user-input question", () => {
      client.emitServerRequest(7, Methods.USER_INPUT_REQUEST, {
        itemId: "item_q",
        threadId: "thread_mock",
        turnId: "turn_mock",
        questions: [{ id: "q1", prompt: "which branch?" }],
      });

      const res = expectCheck(executeCodexCheck({ action: "poll", sessionId }, manager));

      expect(res.interactionState).toBe("waiting_input");
      expect(res.recommendedNextAction).toBe("respond_user_input");
    });
  });

  describe("response shaping", () => {
    beforeEach(() => {
      client.emitNotification(Methods.COMMAND_OUTPUT_DELTA, {
        threadId: "thread_mock",
        turnId: "turn_mock",
        itemId: "item_cmd",
        delta: "hello",
        reason: "because",
        cwd: "/work",
        aggregatedOutput: "hello world",
      });
    });

    function pollWith(mode: CodexCheckParams["responseMode"]): Record<string, unknown> {
      const res = expectCheck(
        executeCodexCheck(
          { action: "poll", sessionId, cursor: 0, maxEvents: 5, responseMode: mode },
          manager
        )
      );
      expect(res.events).toHaveLength(1);
      return res.events[0].data as Record<string, unknown>;
    }

    it("keeps only the hot fields in minimal mode", () => {
      const data = pollWith("minimal");

      expect(data.method).toBe(Methods.COMMAND_OUTPUT_DELTA);
      expect(data.delta).toBe("hello");
      expect(data).not.toHaveProperty("reason");
      expect(data).not.toHaveProperty("cwd");
      expect(data).not.toHaveProperty("aggregatedOutput");
    });

    it("adds the context fields in delta_compact mode", () => {
      const data = pollWith("delta_compact");

      expect(data.delta).toBe("hello");
      expect(data.reason).toBe("because");
      expect(data.cwd).toBe("/work");
      expect(data).not.toHaveProperty("aggregatedOutput");
    });

    it("passes the whole event through in full mode", () => {
      const data = pollWith("full");

      expect(data.aggregatedOutput).toBe("hello world");
      expect(data.itemId).toBe("item_cmd");
    });

    it("defaults to minimal when responseMode is omitted", () => {
      const res = expectCheck(
        executeCodexCheck({ action: "poll", sessionId, cursor: 0, maxEvents: 5 }, manager)
      );
      expect(res.events[0].data).not.toHaveProperty("aggregatedOutput");
    });
  });

  describe("pollOptions", () => {
    beforeEach(() => {
      requestApproval();
      emitOutput("A");
    });

    it("drops events but keeps actions when includeEvents is false", () => {
      const res = expectCheck(
        executeCodexCheck(
          {
            action: "poll",
            sessionId,
            cursor: 0,
            maxEvents: 50,
            pollOptions: { includeEvents: false },
          },
          manager
        )
      );

      expect(res.events).toEqual([]);
      expect(res.actions).toHaveLength(1);
    });

    it("drops actions when includeActions is false", () => {
      const res = expectCheck(
        executeCodexCheck(
          {
            action: "poll",
            sessionId,
            cursor: 0,
            maxEvents: 50,
            pollOptions: { includeActions: false },
          },
          manager
        )
      );

      expect(res.actions).toBeUndefined();
      expect(res.events.length).toBeGreaterThan(0);
    });

    it("advances the cursor past skipped delta events", () => {
      const withDeltas = expectCheck(
        executeCodexCheck({ action: "poll", sessionId, cursor: 0, maxEvents: 50 }, manager)
      );
      const deltaEvents = withDeltas.events.filter(
        (e) => (e.data as { method?: string }).method === Methods.AGENT_MESSAGE_DELTA
      );
      expect(deltaEvents.length).toBeGreaterThan(0);

      const skipped = expectCheck(
        executeCodexCheck(
          {
            action: "poll",
            sessionId,
            cursor: 0,
            maxEvents: 50,
            pollOptions: { skipDeltas: true },
          },
          manager
        )
      );

      expect(
        skipped.events.some(
          (e) => (e.data as { method?: string }).method === Methods.AGENT_MESSAGE_DELTA
        )
      ).toBe(false);
      expect(skipped.nextCursor).toBe(withDeltas.nextCursor);
    });

    it("omits events and keeps the terminal result when finalOnly is set", () => {
      client.emitNotification(Methods.TURN_COMPLETED, {
        turn: { id: "turn_mock", output: "done", status: "completed" },
      });

      const res = expectCheck(
        executeCodexCheck(
          { action: "poll", sessionId, cursor: 0, maxEvents: 50, pollOptions: { finalOnly: true } },
          manager
        )
      );

      expect(res.events).toEqual([]);
      expect(res.result?.text).toBe("done");
      expect(res.status).toBe("idle");
      expect(res.interactionState).toBe("finished");
      expect(res.recommendedNextAction).toBe("none");
    });

    it("omits the result when includeResult is false", () => {
      client.emitNotification(Methods.TURN_COMPLETED, {
        turn: { id: "turn_mock", output: "done", status: "completed" },
      });

      const res = expectCheck(
        executeCodexCheck(
          {
            action: "poll",
            sessionId,
            cursor: 0,
            maxEvents: 50,
            pollOptions: { includeResult: false },
          },
          manager
        )
      );

      expect(res.result).toBeUndefined();
    });

    it("truncates the payload to respect maxBytes", () => {
      for (let i = 0; i < 20; i++) emitOutput(`chunk-${i}-${"x".repeat(200)}`);

      const res = expectCheck(
        executeCodexCheck(
          {
            action: "poll",
            sessionId,
            cursor: 0,
            maxEvents: 50,
            pollOptions: { maxBytes: 600 },
          },
          manager
        )
      );

      expect(res.truncated).toBe(true);
      expect(res.truncatedFields).toContain("events");
      expect(JSON.stringify(res).length).toBeLessThan(4000);
    });
  });

  describe("long-poll", () => {
    it("returns at once when events are already buffered", async () => {
      emitOutput("A");
      const started = Date.now();

      const res = expectCheck(
        await executeCodexCheck(
          { action: "poll", sessionId, cursor: 0, pollOptions: { waitMs: 5000 } },
          manager
        )
      );

      expect(res.events).toHaveLength(1);
      expect(Date.now() - started).toBeLessThan(1000);
    });

    it("returns at once when an action is pending", async () => {
      requestApproval();
      const started = Date.now();

      const res = expectCheck(
        await executeCodexCheck(
          {
            action: "poll",
            sessionId,
            cursor: 0,
            pollOptions: { waitMs: 5000, includeEvents: false },
          },
          manager
        )
      );

      expect(res.actions).toHaveLength(1);
      expect(Date.now() - started).toBeLessThan(1000);
    });

    it("wakes up as soon as an event arrives", async () => {
      const started = Date.now();
      const pending = executeCodexCheck(
        { action: "poll", sessionId, cursor: 0, pollOptions: { waitMs: 5000 } },
        manager
      );
      setTimeout(() => emitOutput("late"), 20);

      const res = expectCheck(await pending);

      expect(res.events).toHaveLength(1);
      expect((res.events[0].data as { delta?: string }).delta).toBe("late");
      expect(Date.now() - started).toBeLessThan(4000);
    });

    it("returns an empty poll when the wait window expires", async () => {
      const started = Date.now();

      const res = expectCheck(
        await executeCodexCheck(
          { action: "poll", sessionId, cursor: 0, pollOptions: { waitMs: 30 } },
          manager
        )
      );

      expect(res.events).toEqual([]);
      expect(res.status).toBe("running");
      expect(Date.now() - started).toBeGreaterThanOrEqual(20);
    });

    it("returns immediately when the request is already aborted", async () => {
      const controller = new AbortController();
      controller.abort();
      const started = Date.now();

      const res = expectCheck(
        await executeCodexCheck(
          { action: "poll", sessionId, cursor: 0, pollOptions: { waitMs: 5000 } },
          manager,
          controller.signal
        )
      );

      expect(res.events).toEqual([]);
      expect(Date.now() - started).toBeLessThan(1000);
    });

    it("stops waiting when the request is aborted mid-wait", async () => {
      const controller = new AbortController();
      const started = Date.now();
      const pending = executeCodexCheck(
        { action: "poll", sessionId, cursor: 0, pollOptions: { waitMs: 5000 } },
        manager,
        controller.signal
      );
      setTimeout(() => controller.abort(), 20);

      const res = expectCheck(await pending);

      expect(res.sessionId).toBe(sessionId);
      expect(Date.now() - started).toBeLessThan(4000);
    });

    it("caps the wait window at 120 seconds", async () => {
      const observed: number[] = [];
      vi.spyOn(manager, "waitForChange").mockImplementation(async (_id, timeoutMs) => {
        observed.push(timeoutMs);
        // Produce data so the poll loop terminates on the next iteration.
        emitOutput("A");
      });

      const res = expectCheck(
        await executeCodexCheck(
          { action: "poll", sessionId, cursor: 0, pollOptions: { waitMs: 5_000_000 } },
          manager
        )
      );

      expect(res.events).toHaveLength(1);
      expect(observed).toHaveLength(1);
      expect(observed[0]).toBeLessThanOrEqual(120_000);
      expect(observed[0]).toBeGreaterThan(115_000);
    });

    it("polls without waiting when waitMs is zero", async () => {
      const waitSpy = vi.spyOn(manager, "waitForChange");

      const res = expectCheck(
        executeCodexCheck(
          { action: "poll", sessionId, cursor: 0, pollOptions: { waitMs: 0 } },
          manager
        )
      );

      expect(res.sessionId).toBe(sessionId);
      expect(waitSpy).not.toHaveBeenCalled();
    });

    it("stops retrying when the session has no waiter slot left", async () => {
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      const blockers = new AbortController();
      // MAX_WAITERS_PER_SESSION is 4, so these fill every slot of the session.
      const held = [0, 1, 2, 3].map(() =>
        manager.waitForChange(sessionId, 60_000, blockers.signal)
      );
      const pollSpy = vi.spyOn(manager, "pollEvents");
      const started = Date.now();

      const res = expectCheck(
        await executeCodexCheck(
          { action: "poll", sessionId, cursor: 0, pollOptions: { waitMs: 200 } },
          manager
        )
      );

      expect(res.sessionId).toBe(sessionId);
      expect(res.events).toEqual([]);
      // One poll before the refused wait and one after it — no retry loop.
      expect(pollSpy).toHaveBeenCalledTimes(2);
      expect(Date.now() - started).toBeLessThan(100);
      expect(logged).toHaveBeenCalledTimes(1);
      expect(String(logged.mock.calls[0]![0])).toContain("Long-poll wait refused");

      blockers.abort();
      await Promise.all(held);
    });

    it("wakes on a notification delivered between the poll and the waiter registration", async () => {
      const started = Date.now();
      const pending = executeCodexCheck(
        { action: "poll", sessionId, cursor: 0, pollOptions: { waitMs: 120_000 } },
        manager
      );
      // The long poll has run its synchronous part: pollEvents read an empty
      // buffer and the waiter is registered. This is the exact window the
      // single-threaded loop leaves between those two steps, so a notification
      // delivered here must still end the wait.
      emitOutput("boundary");

      const res = expectCheck(await pending);

      expect(res.events).toHaveLength(1);
      expect((res.events[0].data as { delta?: string }).delta).toBe("boundary");
      expect(Date.now() - started).toBeLessThan(1000);
    });
  });

  describe("respond_permission", () => {
    beforeEach(() => {
      requestApproval();
    });

    it("requires requestId and decision", () => {
      expect(
        expectError(executeCodexCheck({ action: "respond_permission", sessionId }, manager)).error
      ).toContain("requestId and decision required");

      expect(
        expectError(
          executeCodexCheck(
            { action: "respond_permission", sessionId, requestId: "req_1" },
            manager
          )
        ).error
      ).toContain("requestId and decision required");
    });

    it("rejects answers", () => {
      const res = expectError(
        executeCodexCheck(
          {
            action: "respond_permission",
            sessionId,
            requestId: "req_1",
            decision: "accept",
            answers: { q1: { answers: ["yes"] } },
          },
          manager
        )
      );
      expect(res.error).toContain("answers is only valid for respond_user_input");
    });

    it("rejects an execpolicy amendment attached to another decision", () => {
      const res = expectError(
        executeCodexCheck(
          {
            action: "respond_permission",
            sessionId,
            requestId: "req_1",
            decision: "accept",
            execpolicy_amendment: ["ls"],
          },
          manager
        )
      );
      expect(res.error).toContain(
        "execpolicy_amendment is only valid with decision='acceptWithExecpolicyAmendment'"
      );
    });

    it("requires a non-empty execpolicy amendment for acceptWithExecpolicyAmendment", () => {
      for (const amendment of [undefined, []]) {
        const res = expectError(
          executeCodexCheck(
            {
              action: "respond_permission",
              sessionId,
              requestId: "req_1",
              decision: "acceptWithExecpolicyAmendment",
              execpolicy_amendment: amendment,
            },
            manager
          )
        );
        expect(res.error).toContain("execpolicy_amendment required");
      }
    });

    it("validates the network policy amendment", () => {
      const base = {
        action: "respond_permission" as const,
        sessionId,
        requestId: "req_1",
        decision: "applyNetworkPolicyAmendment" as const,
      };

      expect(expectError(executeCodexCheck(base, manager)).error).toContain(
        "network_policy_amendment required"
      );

      expect(
        expectError(
          executeCodexCheck(
            {
              ...base,
              network_policy_amendment: { action: "maybe" as unknown as "allow", host: "a.com" },
            },
            manager
          )
        ).error
      ).toContain("must be 'allow' or 'deny'");

      expect(
        expectError(
          executeCodexCheck(
            { ...base, network_policy_amendment: { action: "allow", host: "" } },
            manager
          )
        ).error
      ).toContain("network_policy_amendment.host required");

      expect(
        expectError(
          executeCodexCheck(
            {
              action: "respond_permission",
              sessionId,
              requestId: "req_1",
              decision: "accept",
              network_policy_amendment: { action: "allow", host: "a.com" },
            },
            manager
          )
        ).error
      ).toContain(
        "network_policy_amendment is only valid with decision='applyNetworkPolicyAmendment'"
      );
    });

    it("rejects a decision outside the known set", () => {
      const res = expectError(
        executeCodexCheck(
          {
            action: "respond_permission",
            sessionId,
            requestId: "req_1",
            decision: "maybe" as unknown as "accept",
          },
          manager
        )
      );
      expect(res.error).toBe("Error [INVALID_ARGUMENT]: Unknown decision 'maybe'");
    });

    it("surfaces a manager rejection for an unknown request id", () => {
      const res = expectError(
        executeCodexCheck(
          {
            action: "respond_permission",
            sessionId,
            requestId: "req_nope",
            decision: "accept",
          },
          manager
        )
      );
      expect(res.error).toBe(
        "Error [REQUEST_NOT_FOUND]: Request 'req_nope' not found or already resolved"
      );
    });

    it("sends the decision to the app-server and answers with a compact ACK", () => {
      const requestId = pendingRequestId();

      const res = expectCheck(
        executeCodexCheck(
          { action: "respond_permission", sessionId, requestId, decision: "accept" },
          manager
        )
      );

      expect(client.respondToServer).toHaveBeenCalledWith(1, { decision: "accept" });
      expect(res.events).toEqual([]);
      expect(res.status).toBe("running");
      expect(res.interactionState).toBe("working");
    });

    it("returns events when maxEvents is raised", () => {
      const requestId = pendingRequestId();

      const res = expectCheck(
        executeCodexCheck(
          {
            action: "respond_permission",
            sessionId,
            requestId,
            decision: "decline",
            denyMessage: "not now",
            cursor: 0,
            maxEvents: 50,
          },
          manager
        )
      );

      const decisions = res.events
        .map((e) => e.data as { decision?: string })
        .filter((d) => d.decision === "decline");
      expect(decisions.length).toBeGreaterThan(0);
    });

    it("warns when the caller sends a cursor behind the session cursor", () => {
      emitOutput("A");
      emitOutput("B");
      // Consume the buffered events so the session cursor moves forward.
      executeCodexCheck({ action: "poll", sessionId, maxEvents: 50 }, manager);
      const requestId = pendingRequestId();

      const res = expectCheck(
        executeCodexCheck(
          {
            action: "respond_permission",
            sessionId,
            requestId,
            decision: "accept",
            cursor: 0,
            maxEvents: 50,
          },
          manager
        )
      );

      expect(res.compatWarnings?.join(" ")).toContain("is stale");
    });
  });

  describe("respond_user_input", () => {
    beforeEach(() => {
      client.emitServerRequest(9, Methods.USER_INPUT_REQUEST, {
        itemId: "item_q",
        threadId: "thread_mock",
        turnId: "turn_mock",
        questions: [{ id: "q1", prompt: "which branch?" }],
      });
    });

    it("requires requestId and answers", () => {
      expect(
        expectError(executeCodexCheck({ action: "respond_user_input", sessionId }, manager)).error
      ).toContain("requestId and answers required");

      expect(
        expectError(
          executeCodexCheck(
            { action: "respond_user_input", sessionId, requestId: "req_1" },
            manager
          )
        ).error
      ).toContain("requestId and answers required");
    });

    it("rejects approval-only fields", () => {
      const base = {
        action: "respond_user_input" as const,
        sessionId,
        requestId: "req_1",
        answers: { q1: { answers: ["main"] } },
      };

      for (const extra of [
        { decision: "accept" as const },
        { execpolicy_amendment: ["ls"] },
        { network_policy_amendment: { action: "allow" as const, host: "a.com" } },
        { denyMessage: "no" },
      ]) {
        const res = expectError(executeCodexCheck({ ...base, ...extra }, manager));
        expect(res.error).toContain("only valid for respond_permission");
      }
    });

    it("surfaces a manager rejection for an unknown request id", () => {
      const res = expectError(
        executeCodexCheck(
          {
            action: "respond_user_input",
            sessionId,
            requestId: "req_nope",
            answers: { q1: { answers: ["main"] } },
          },
          manager
        )
      );
      expect(res.error).toBe("Error [REQUEST_NOT_FOUND]: User input request 'req_nope' not found");
    });

    it("forwards the answers to the app-server", () => {
      const requestId = pendingRequestId();

      const res = expectCheck(
        executeCodexCheck(
          {
            action: "respond_user_input",
            sessionId,
            requestId,
            answers: { q1: { answers: ["main"] } },
          },
          manager
        )
      );

      expect(client.respondToServer).toHaveBeenCalledWith(9, {
        answers: { q1: { answers: ["main"] } },
      });
      expect(res.events).toEqual([]);
      expect(res.status).toBe("running");
    });
  });

  it("rejects an unknown action", () => {
    const res = expectError(
      executeCodexCheck({ action: "restart" as unknown as "poll", sessionId }, manager)
    );
    expect(res.error).toBe("Error [INVALID_ARGUMENT]: Unknown action 'restart'");
  });
});
