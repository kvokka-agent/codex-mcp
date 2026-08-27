/**
 * executeCodexCheck: the status payload, long-polling, and the approval /
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
import { executeCodexCheck } from "../src/tools/codex-check.js";
import { POLL_WINDOW_MARGIN_MS, PollWindow } from "../src/utils/poll-window.js";
import { DEFAULT_APPROVAL_TIMEOUT_MS, MAX_LONG_POLL_WAIT_MS } from "../src/types.js";
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
    const actions = expectCheck(executeCodexCheck({ action: "poll", sessionId }, manager)).actions;
    expect(actions.length, "no pending actions").toBeGreaterThan(0);
    return actions[0]!.requestId;
  }

  function completeTurn(text = "done"): void {
    client.emitNotification(Methods.TURN_COMPLETED, {
      turn: { id: "turn_mock", output: text, status: "completed" },
    });
  }

  describe("poll", () => {
    it("rejects respond-only fields", () => {
      const res = expectError(
        executeCodexCheck({ action: "poll", sessionId, requestId: "req_1" }, manager)
      );
      expect(res.error).toContain("only valid for respond_* actions");
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

  describe("the status payload", () => {
    it("carries no event and no delta, whatever the turn produced", async () => {
      // Everything a turn can put on the wire: deltas, items, reasoning, token
      // counters, an approval, an error, and the end of the turn.
      requestApproval();
      for (let i = 0; i < 5; i++) emitOutput(`chunk-${i}`);
      client.emitNotification(Methods.REASONING_TEXT_DELTA, {
        threadId: "thread_mock",
        turnId: "turn_mock",
        delta: "thinking about it",
      });
      client.emitNotification(Methods.ITEM_COMPLETED, {
        threadId: "thread_mock",
        turnId: "turn_mock",
        item: { id: "item_1", type: "commandExecution", command: "ls" },
      });
      client.emitNotification(Methods.THREAD_TOKEN_USAGE_UPDATED, {
        threadId: "thread_mock",
        turnId: "turn_mock",
        tokenUsage: { total: { inputTokens: 7, outputTokens: 3, totalTokens: 10 } },
      });

      const waiting = expectCheck(executeCodexCheck({ action: "poll", sessionId }, manager));
      const answered = expectCheck(
        executeCodexCheck(
          {
            action: "respond_permission",
            sessionId,
            requestId: waiting.actions[0]!.requestId,
            decision: "accept",
          },
          manager
        )
      );
      completeTurn("the final answer");
      const finished = expectCheck(
        await executeCodexCheck({ action: "poll", sessionId, waitMs: 0 }, manager)
      );

      for (const res of [waiting, answered, finished]) {
        expect(Object.keys(res).sort()).toEqual([
          "actions",
          "interactionState",
          "pollInterval",
          "progress",
          "recommendedNextAction",
          "result",
          "sessionId",
          "status",
        ]);
        const serialized = JSON.stringify(res);
        expect(serialized).not.toContain("chunk-");
        expect(serialized).not.toContain("thinking about it");
        expect(serialized).not.toContain("delta");
      }

      expect(waiting.actions).toHaveLength(1);
      expect(finished.result?.text).toBe("the final answer");
      // The counters are carried as counts, which is all of that traffic the
      // caller ever sees.
      expect(finished.progress.tokens).toEqual({ input: 7, output: 3, total: 10 });
    });

    it("reports the phase, the pending count and the active turn", () => {
      requestApproval();

      const res = expectCheck(executeCodexCheck({ action: "poll", sessionId }, manager));

      expect(res.progress.phase).toBe("waiting_approval");
      expect(res.progress.pendingActionCount).toBe(1);
      expect(res.progress.activeTurnId).toBe("turn_mock");
      expect(Number.isNaN(Date.parse(res.progress.lastEventAt))).toBe(false);
      expect(res.progress).not.toHaveProperty("lastMethod");
    });

    it("hands the finished turn's answer over exactly once", () => {
      completeTurn("the answer");

      const first = expectCheck(executeCodexCheck({ action: "poll", sessionId }, manager));
      const second = expectCheck(executeCodexCheck({ action: "poll", sessionId }, manager));
      const third = expectCheck(executeCodexCheck({ action: "poll", sessionId }, manager));

      expect(first.result?.text).toBe("the answer");
      expect(second.result).toBeUndefined();
      expect(third.result).toBeUndefined();
      // The status stays readable after the answer was handed over.
      for (const res of [first, second, third]) {
        expect(res.status).toBe("idle");
        expect(res.recommendedNextAction).toBe("none");
      }
    });

    it("carries the answer of the next turn after a reply", async () => {
      completeTurn("first answer");
      expect(
        expectCheck(executeCodexCheck({ action: "poll", sessionId }, manager)).result?.text
      ).toBe("first answer");

      await manager.replyToSession(sessionId, "and now?");
      const running = expectCheck(executeCodexCheck({ action: "poll", sessionId }, manager));
      expect(running.status).toBe("running");
      expect(running.result).toBeUndefined();

      completeTurn("second answer");
      expect(
        expectCheck(executeCodexCheck({ action: "poll", sessionId }, manager)).result?.text
      ).toBe("second answer");
    });

    it("carries an approval through to the app-server and back to running", () => {
      requestApproval(7);

      const waiting = expectCheck(executeCodexCheck({ action: "poll", sessionId }, manager));
      expect(waiting.status).toBe("waiting_approval");
      expect(waiting.recommendedNextAction).toBe("respond_permission");
      const action = waiting.actions[0]!;
      expect(action.kind).toBe("command");
      expect(action.reason).toBe("needs the network");
      expect(action.approvalId).toBe("appr_1");
      expect(action.availableDecisions).toEqual([
        "accept",
        "decline",
        "applyNetworkPolicyAmendment",
      ]);

      const answered = expectCheck(
        executeCodexCheck(
          {
            action: "respond_permission",
            sessionId,
            requestId: action.requestId,
            decision: "applyNetworkPolicyAmendment",
            network_policy_amendment: { action: "allow", host: "example.com" },
          },
          manager
        )
      );

      expect(client.respondToServer).toHaveBeenCalledWith(7, {
        decision: {
          applyNetworkPolicyAmendment: {
            network_policy_amendment: { action: "allow", host: "example.com" },
          },
        },
      });
      expect(answered.status).toBe("running");
      expect(answered.actions).toEqual([]);
      expect(answered.progress.pendingActionCount).toBe(0);
    });
  });

  describe("long-poll", () => {
    it("answers at once when an action is already pending", async () => {
      requestApproval();
      const started = Date.now();

      const res = expectCheck(
        await executeCodexCheck({ action: "poll", sessionId, waitMs: 5000 }, manager)
      );

      expect(res.actions).toHaveLength(1);
      expect(Date.now() - started).toBeLessThan(1000);
    });

    it("answers at once when the turn is already over", async () => {
      completeTurn();
      const started = Date.now();

      const res = expectCheck(
        await executeCodexCheck({ action: "poll", sessionId, waitMs: 5000 }, manager)
      );

      expect(res.status).toBe("idle");
      expect(res.result?.text).toBe("done");
      expect(Date.now() - started).toBeLessThan(1000);
    });

    it("sleeps through a stream of deltas and token-counter updates", async () => {
      const started = Date.now();
      const pending = executeCodexCheck({ action: "poll", sessionId, waitMs: 120 }, manager);

      for (let i = 0; i < 50; i++) {
        emitOutput(`chunk-${i}`);
        client.emitNotification(Methods.THREAD_TOKEN_USAGE_UPDATED, {
          threadId: "thread_mock",
          turnId: "turn_mock",
          tokenUsage: { total: { inputTokens: i, outputTokens: i, totalTokens: 2 * i } },
        });
      }

      const res = expectCheck(await pending);

      // The wait ran its full window: none of that traffic is a change to act on.
      expect(Date.now() - started).toBeGreaterThanOrEqual(100);
      expect(res.status).toBe("running");
      expect(res.actions).toEqual([]);
      // The counters the run produced still reach the caller, as a count.
      expect(res.progress.tokens?.total).toBe(98);
    });

    it("wakes on a new action", async () => {
      const started = Date.now();
      const pending = executeCodexCheck({ action: "poll", sessionId, waitMs: 5000 }, manager);
      setTimeout(() => requestApproval(), 20);

      const res = expectCheck(await pending);

      expect(res.actions).toHaveLength(1);
      expect(res.status).toBe("waiting_approval");
      expect(res.recommendedNextAction).toBe("respond_permission");
      expect(Date.now() - started).toBeLessThan(4000);
    });

    it("wakes when the turn ends and carries its answer", async () => {
      const started = Date.now();
      const pending = executeCodexCheck({ action: "poll", sessionId, waitMs: 5000 }, manager);
      setTimeout(() => completeTurn("the answer"), 20);

      const res = expectCheck(await pending);

      expect(res.status).toBe("idle");
      expect(res.result?.text).toBe("the answer");
      expect(res.interactionState).toBe("finished");
      expect(Date.now() - started).toBeLessThan(4000);
    });

    it("wakes on a status change with nothing to answer", async () => {
      const started = Date.now();
      const pending = executeCodexCheck({ action: "poll", sessionId, waitMs: 5000 }, manager);
      setTimeout(() => void manager.cancelSession(sessionId, "stopped by test"), 20);

      const res = expectCheck(await pending);

      expect(res.status).toBe("cancelled");
      expect(Date.now() - started).toBeLessThan(4000);
    });

    it("reports the state it found when the wait window expires", async () => {
      const started = Date.now();

      const res = expectCheck(
        await executeCodexCheck({ action: "poll", sessionId, waitMs: 30 }, manager)
      );

      expect(res.status).toBe("running");
      expect(res.actions).toEqual([]);
      expect(res.result).toBeUndefined();
      expect(Date.now() - started).toBeGreaterThanOrEqual(20);
    });

    it("returns immediately when the request is already aborted", async () => {
      const controller = new AbortController();
      controller.abort();
      const started = Date.now();

      const res = expectCheck(
        await executeCodexCheck(
          { action: "poll", sessionId, waitMs: 5000 },
          manager,
          controller.signal
        )
      );

      expect(res.status).toBe("running");
      expect(Date.now() - started).toBeLessThan(1000);
    });

    it("stops waiting when the request is aborted mid-wait", async () => {
      const controller = new AbortController();
      const started = Date.now();
      const pending = executeCodexCheck(
        { action: "poll", sessionId, waitMs: 5000 },
        manager,
        controller.signal
      );
      setTimeout(() => controller.abort(), 20);

      const res = expectCheck(await pending);

      expect(res.sessionId).toBe(sessionId);
      expect(Date.now() - started).toBeLessThan(4000);
    });

    it("cuts the wait down to what the client tolerates", async () => {
      const window = new PollWindow({ MCP_TOOL_TIMEOUT: "600000" });
      const observed: number[] = [];
      vi.spyOn(manager, "waitForChange").mockImplementation(async (_id, timeoutMs) => {
        observed.push(timeoutMs);
        // End the turn so the loop stops on the next read.
        completeTurn();
      });

      const res = expectCheck(
        await executeCodexCheck(
          { action: "poll", sessionId, waitMs: 5_000_000 },
          manager,
          undefined,
          window
        )
      );

      expect(res.status).toBe("idle");
      expect(observed).toHaveLength(1);
      expect(observed[0]).toBeLessThanOrEqual(window.budgetMs());
      expect(observed[0]).toBeGreaterThan(window.budgetMs() - 1_000);
      expect(window.budgetMs()).toBe(600_000 - POLL_WINDOW_MARGIN_MS);
    });

    it("holds a call the whole window when the caller asked for the whole window", async () => {
      const window = new PollWindow({ CLAUDECODE: "1", MCP_TOOL_TIMEOUT: "300000" });
      const observed: number[] = [];
      vi.spyOn(manager, "waitForChange").mockImplementation(async (_id, timeoutMs) => {
        observed.push(timeoutMs);
        completeTurn();
      });

      await executeCodexCheck(
        { action: "poll", sessionId, waitMs: window.budgetMs() },
        manager,
        undefined,
        window
      );

      expect(observed).toHaveLength(1);
      expect(observed[0]).toBeGreaterThan(window.budgetMs() - 1_000);
    });

    it("gives a caller asking for less than the window exactly what it asked for", async () => {
      const window = new PollWindow({ MCP_TOOL_TIMEOUT: "600000" });
      const observed: number[] = [];
      vi.spyOn(manager, "waitForChange").mockImplementation(async (_id, timeoutMs) => {
        observed.push(timeoutMs);
        completeTurn();
      });

      await executeCodexCheck(
        { action: "poll", sessionId, waitMs: 3_000 },
        manager,
        undefined,
        window
      );

      expect(observed).toHaveLength(1);
      expect(observed[0]).toBeLessThanOrEqual(3_000);
      expect(observed[0]).toBeGreaterThan(2_000);
    });

    it("leaves the finished turn's answer undelivered when the client cut the call", async () => {
      const controller = new AbortController();
      const pending = executeCodexCheck(
        { action: "poll", sessionId, waitMs: 5000 },
        manager,
        controller.signal
      );
      // The turn ends and the client's clock runs out in the same instant.
      setTimeout(() => {
        completeTurn("the answer");
        controller.abort("SdkError: Request timed out");
      }, 20);

      const cut = expectCheck(await pending);
      expect(cut.result).toBeUndefined();

      // The response the SDK dropped took nothing with it: the next call has it.
      const next = expectCheck(executeCodexCheck({ action: "poll", sessionId }, manager));
      expect(next.status).toBe("idle");
      expect(next.result?.text).toBe("the answer");
    });

    it("measures the cut and returns inside it from then on", async () => {
      const window = new PollWindow({ CLAUDECODE: "1" });
      const controller = new AbortController();

      const pending = executeCodexCheck(
        { action: "poll", sessionId, waitMs: 5_000 },
        manager,
        controller.signal,
        window
      );
      setTimeout(() => controller.abort("SdkError: Request timed out"), 40);
      await pending;

      // The client named no ceiling until it cut this call.
      const measured = window.ceilingMs();
      expect(measured).toBeGreaterThanOrEqual(40);
      expect(window.describe().source).toBe("measured");

      // A ceiling of some tens of milliseconds leaves no window worth holding,
      // so the next poll answers at once rather than walking into the same cut.
      expect(window.budgetMs()).toBe(0);
      const waitForChange = vi.spyOn(manager, "waitForChange");
      const res = expectCheck(
        await executeCodexCheck(
          { action: "poll", sessionId, waitMs: 5_000_000 },
          manager,
          undefined,
          window
        )
      );
      expect(waitForChange).not.toHaveBeenCalled();
      expect(res.status).toBe("running");
    });

    it("hands an approval over long before it expires, whatever the window is", async () => {
      const window = new PollWindow({ CLAUDECODE: "1" });
      const started = Date.now();
      const pending = executeCodexCheck(
        { action: "poll", sessionId, waitMs: MAX_LONG_POLL_WAIT_MS },
        manager,
        undefined,
        window
      );
      setTimeout(() => requestApproval(), 20);

      const res = expectCheck(await pending);
      const elapsed = Date.now() - started;

      expect(window.budgetMs()).toBe(MAX_LONG_POLL_WAIT_MS);
      expect(res.status).toBe("waiting_approval");
      expect(res.actions).toHaveLength(1);
      expect(res.recommendedNextAction).toBe("respond_permission");
      // The pending request auto-declines after approvalTimeoutMs; the wait has
      // to end inside that, not inside the window it was given.
      expect(elapsed).toBeLessThan(DEFAULT_APPROVAL_TIMEOUT_MS);
      expect(elapsed).toBeLessThan(1_000);
    });

    it("answers at once when the client tolerates no window at all", async () => {
      const window = new PollWindow({ MCP_TOOL_TIMEOUT: "500" });
      const waitForChange = vi.spyOn(manager, "waitForChange");

      const res = expectCheck(
        await executeCodexCheck(
          { action: "poll", sessionId, waitMs: 120_000 },
          manager,
          undefined,
          window
        )
      );

      expect(window.budgetMs()).toBe(0);
      expect(waitForChange).not.toHaveBeenCalled();
      expect(res.status).toBe("running");
    });

    it("learns nothing from an abort the client did not blame on its clock", async () => {
      const window = new PollWindow({ CLAUDECODE: "1" });
      const controller = new AbortController();

      const pending = executeCodexCheck(
        { action: "poll", sessionId, waitMs: 5_000 },
        manager,
        controller.signal,
        window
      );
      setTimeout(() => controller.abort("The user cancelled the request"), 20);
      await pending;

      expect(window.describe().source).toBe("none");
      expect(window.budgetMs()).toBe(MAX_LONG_POLL_WAIT_MS);
    });

    it("answers without waiting when waitMs is zero", () => {
      const waitSpy = vi.spyOn(manager, "waitForChange");

      const res = expectCheck(executeCodexCheck({ action: "poll", sessionId, waitMs: 0 }, manager));

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
      const started = Date.now();

      const res = expectCheck(
        await executeCodexCheck({ action: "poll", sessionId, waitMs: 200 }, manager)
      );

      expect(res.sessionId).toBe(sessionId);
      expect(res.status).toBe("running");
      expect(Date.now() - started).toBeLessThan(100);
      expect(logged).toHaveBeenCalledTimes(1);
      expect(String(logged.mock.calls[0]![0])).toContain("Long-poll wait refused");

      blockers.abort();
      await Promise.all(held);
    });

    it("wakes on a change delivered between the read and the waiter registration", async () => {
      const started = Date.now();
      const pending = executeCodexCheck({ action: "poll", sessionId, waitMs: 120_000 }, manager);
      // The long poll has run its synchronous part: it read the session state and
      // registered its waiter. This is the exact window the single-threaded loop
      // leaves between those two steps, so a change delivered here must still end
      // the wait.
      requestApproval();

      const res = expectCheck(await pending);

      expect(res.actions).toHaveLength(1);
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

    it("sends the decision to the app-server and answers with the session status", () => {
      const requestId = pendingRequestId();

      const res = expectCheck(
        executeCodexCheck(
          { action: "respond_permission", sessionId, requestId, decision: "accept" },
          manager
        )
      );

      expect(client.respondToServer).toHaveBeenCalledWith(1, { decision: "accept" });
      expect(res.actions).toEqual([]);
      expect(res.status).toBe("running");
      expect(res.interactionState).toBe("working");
      expect(res.recommendedNextAction).toBe("poll");
      expect(res).not.toHaveProperty("events");
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
      expect(res.actions).toEqual([]);
      expect(res.status).toBe("running");
      expect(res).not.toHaveProperty("events");
    });
  });

  it("rejects an unknown action", () => {
    const res = expectError(
      executeCodexCheck({ action: "restart" as unknown as "poll", sessionId }, manager)
    );
    expect(res.error).toBe("Error [INVALID_ARGUMENT]: Unknown action 'restart'");
  });
});
