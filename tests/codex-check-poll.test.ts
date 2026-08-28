/**
 * executeCodexCheck: the status payload, long-polling, and the approval /
 * user-input decision branches.
 *
 * The session manager is real; only the app-server client is a stand-in, so
 * every asserted value is produced by the code under test.
 */
import { useFakeClock } from "./helpers/clock.js";
import { EventEmitter } from "events";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import type { AppServerClient } from "../src/app-server/client.js";
import { Methods } from "../src/app-server/protocol.js";
import { SessionManager } from "../src/session/manager.js";
import { executeCodexCheck } from "../src/tools/codex-check.js";
import { POLL_WINDOW_MARGIN_MS, PollWindow } from "../src/utils/poll-window.js";
import { DEFAULT_APPROVAL_TIMEOUT_MS, MAX_LONG_POLL_WAIT_MS } from "../src/types.js";
import { ProgressReporter, type ProgressNotification } from "../src/utils/progress-notifier.js";
import type { CheckResult } from "../src/types.js";

class MockClient extends EventEmitter {
  notificationHandler: ((method: string, params: unknown) => void) | null = null;
  serverRequestHandler: ((id: number, method: string, params: unknown) => void) | null = null;

  supportsTurnOverrides = true;
  childPid: number | undefined = undefined;

  start = jest.fn(async () => ({ userAgent: "mock" }));
  threadStart = jest.fn(async () => ({ thread: { id: "thread_mock" } }));
  threadFork = jest.fn(async () => ({ thread: { id: "thread_forked" } }));
  threadResume = jest.fn(async () => ({ thread: { id: "thread_forked" } }));
  threadBackgroundTerminalsClean = jest.fn(async () => ({}));
  turnStart = jest.fn(async () => ({ turn: { id: "turn_mock" } }));
  turnInterrupt = jest.fn(async () => {});
  respondToServer = jest.fn();
  respondErrorToServer = jest.fn();
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
    jest.useRealTimers();
    manager.destroy();
    jest.restoreAllMocks();
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

  /**
   * The window of a client that configured nothing.
   *
   * `executeCodexCheck` builds one from `process.env` when the caller names
   * none, so a shell exporting `MCP_TOOL_TIMEOUT=500` would leave every wait
   * below with no window to hold and nothing to wake from. Every poll that
   * waits names its own.
   */
  function pinnedWindow(): PollWindow {
    return new PollWindow({});
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

    it("carries the finished turn's answer on every check of the terminal session", () => {
      completeTurn("the answer");

      const first = expectCheck(executeCodexCheck({ action: "poll", sessionId }, manager));
      const second = expectCheck(executeCodexCheck({ action: "poll", sessionId }, manager));
      const third = expectCheck(executeCodexCheck({ action: "poll", sessionId }, manager));

      // A caller that checks again reads the answer back. Handing it over once
      // left the second check empty, and the caller wrote a summary of its own
      // in place of what Codex said.
      for (const res of [first, second, third]) {
        expect(res.result?.text).toBe("the answer");
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

    it("cuts the activity marker out of the turn record the result carries", () => {
      // `TurnResult.turn` holds the assistant text a second time. Leaving that
      // copy unstripped put a raw marker back into the answer a caller reported.
      const withMarker = "%%%ACTIVITY: считаю файлы%%%\nсемь";
      client.emitNotification(Methods.TURN_COMPLETED, {
        turn: {
          id: "turn_mock",
          status: "completed",
          output: withMarker,
          items: [{ id: "item_1", type: "agentMessage", text: withMarker }],
        },
      });

      const res = expectCheck(executeCodexCheck({ action: "poll", sessionId }, manager));
      const turn = res.result?.turn as { output: string; items: Array<{ text: string }> };
      expect(res.result?.text).toBe("семь");
      expect(turn.output).toBe("семь");
      expect(turn.items[0]!.text).toBe("семь");
    });

    it("keeps the finished turn's outcome after the session is closed", async () => {
      completeTurn("the answer");
      await manager.cancelSession(sessionId);

      const info = manager.getSession(sessionId);
      // The status says what the session is now; lastTurn says what the work
      // came to, and closing a session that answered does not rewrite it.
      expect(info.status).toBe("cancelled");
      expect(info.lastTurn?.outcome).toBe("completed");
      expect(info.lastTurn?.turnId).toBe("turn_mock");
    });

    it("reports a cancelled outcome for a session closed before it answered", async () => {
      await manager.cancelSession(sessionId);

      const info = manager.getSession(sessionId);
      expect(info.lastTurn?.outcome).toBe("cancelled");
      expect(info.lastTurn?.error).toBe("Cancelled by user");
    });

    it("holds the call until the finished turn's answer is on the session", async () => {
      const { advance } = useFakeClock();
      const pending = executeCodexCheck(
        { action: "poll", sessionId, waitMs: 5000 },
        manager,
        undefined,
        pinnedWindow()
      ) as Promise<CheckResult>;
      let answered = false;
      void pending.then(() => {
        answered = true;
      });

      // The thread reports idle one notification ahead of turn/completed, and
      // turn/completed is what carries the answer.
      client.emitNotification(Methods.THREAD_STATUS_CHANGED, {
        threadId: "thread_mock",
        status: { type: "idle" },
      });
      await advance(1000);

      // Answering here would hand the caller a finished turn with no result.
      expect(answered).toBe(false);

      completeTurn("the answer");
      const res = expectCheck(await pending);

      expect(res.status).toBe("idle");
      expect(res.result?.text).toBe("the answer");
    });

    it("answers the held call with the line the turn just wrote", async () => {
      const pending = executeCodexCheck(
        { action: "poll", sessionId, waitMs: 5000 },
        manager,
        undefined,
        pinnedWindow()
      );

      emitOutput("%%%ACTIVITY: Читаю тест%%%\n");
      const res = expectCheck(await pending);

      // The turn is still running: what ended the wait is the new heading, which
      // is what the caller writes out before it polls again.
      expect(res.status).toBe("running");
      expect(res.progress.activity).toBe("Читаю тест");
      expect(res.waitedMs).toBeGreaterThanOrEqual(0);
    });

    it("holds the call through a delta that says nothing new", async () => {
      const { advance } = useFakeClock();
      const pending = executeCodexCheck(
        { action: "poll", sessionId, waitMs: 5000 },
        manager,
        undefined,
        pinnedWindow()
      );

      emitOutput("обычный текст без маркера");
      await advance(5000);
      const res = expectCheck(await pending);

      // The window ran out rather than something happening in it.
      expect(res.status).toBe("running");
      expect(res.progress.activity).toBeUndefined();
      expect(res.waitedMs).toBe(5000);
    });

    it("reports each activity line to the client while it holds the call", async () => {
      const sent: ProgressNotification[] = [];
      const reporter = new ProgressReporter("tok-1", async (n) => {
        sent.push(n);
      });

      const pending = executeCodexCheck(
        { action: "poll", sessionId, waitMs: 5000 },
        manager,
        undefined,
        pinnedWindow(),
        reporter
      );

      emitOutput("%%%ACTIVITY: Читаю тест%%%\n");
      emitOutput("%%%ACTIVITY: Правлю манифест%%%\n");
      completeTurn("the answer");
      const res = expectCheck(await pending);

      // The standing line first, then each new one as it arrived.
      expect(sent.map((n) => n.params.message)).toEqual([
        "running — 0s",
        "Читаю тест",
        "Правлю манифест",
      ]);
      expect(res.result?.text).toBe("the answer");
      expect(sent.map((n) => n.params.progress)).toEqual([1, 2, 3]);
      expect(sent.every((n) => n.params.progressToken === "tok-1")).toBe(true);
    });

    it("reports the line the session is already on when the poll starts", async () => {
      emitOutput("%%%ACTIVITY: Читаю тест%%%\n");

      const sent: ProgressNotification[] = [];
      const reporter = new ProgressReporter("tok-2", async (n) => {
        sent.push(n);
      });
      const pending = executeCodexCheck(
        { action: "poll", sessionId, waitMs: 5000 },
        manager,
        undefined,
        pinnedWindow(),
        reporter
      );

      // A caller that starts polling mid-turn reads what is happening now, and
      // how long it has been happening, rather than waiting for the next change.
      expect(sent.map((n) => n.params.message)).toEqual(["Читаю тест — 0s"]);

      completeTurn("the answer");
      await pending;
    });

    it("repeats the standing line with how long it has stood", async () => {
      const { advance } = useFakeClock();
      emitOutput("%%%ACTIVITY: Собираю проект%%%\n");

      const sent: ProgressNotification[] = [];
      const reporter = new ProgressReporter("tok-hb", async (n) => {
        sent.push(n);
      });
      const pending = executeCodexCheck(
        { action: "poll", sessionId, waitMs: 300_000 },
        manager,
        undefined,
        pinnedWindow(),
        reporter,
        10_000
      );

      // The window is the client's, not the 300000 asked for: an unconfigured
      // client is held to the SDK's 60000 less the 5000 margin.
      await advance(60_000);
      await pending;

      // One line when the poll started and one every ten seconds after it, each
      // saying how long the same work has been running.
      expect(sent.map((n) => n.params.message)).toEqual([
        "Собираю проект — 0s",
        "Собираю проект — 10s",
        "Собираю проект — 20s",
        "Собираю проект — 30s",
        "Собираю проект — 40s",
        "Собираю проект — 50s",
      ]);
    });

    it("stops reporting once the call it belonged to has returned", async () => {
      const sent: ProgressNotification[] = [];
      const reporter = new ProgressReporter("tok-3", async (n) => {
        sent.push(n);
      });
      const pending = executeCodexCheck(
        { action: "poll", sessionId, waitMs: 5000 },
        manager,
        undefined,
        pinnedWindow(),
        reporter
      );
      completeTurn("the answer");
      await pending;
      const afterTheCall = sent.length;

      await manager.replyToSession(sessionId, "and now?");
      emitOutput("%%%ACTIVITY: Правлю манифест%%%\n");

      expect(sent).toHaveLength(afterTheCall);
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
      const waitForChange = jest.spyOn(manager, "waitForChange");

      const res = expectCheck(
        await executeCodexCheck(
          { action: "poll", sessionId, waitMs: 5000 },
          manager,
          undefined,
          pinnedWindow()
        )
      );

      expect(res.actions).toHaveLength(1);
      expect(waitForChange).not.toHaveBeenCalled();
    });

    it("answers at once when the turn is already over", async () => {
      completeTurn();
      const waitForChange = jest.spyOn(manager, "waitForChange");

      const res = expectCheck(
        await executeCodexCheck(
          { action: "poll", sessionId, waitMs: 5000 },
          manager,
          undefined,
          pinnedWindow()
        )
      );

      expect(res.status).toBe("idle");
      expect(res.result?.text).toBe("done");
      expect(waitForChange).not.toHaveBeenCalled();
    });

    it("sleeps through a stream of deltas and token-counter updates", async () => {
      const clock = useFakeClock();
      const pending = executeCodexCheck(
        { action: "poll", sessionId, waitMs: 120 },
        manager,
        undefined,
        pinnedWindow()
      );

      for (let i = 0; i < 50; i++) {
        emitOutput(`chunk-${i}`);
        client.emitNotification(Methods.THREAD_TOKEN_USAGE_UPDATED, {
          threadId: "thread_mock",
          turnId: "turn_mock",
          tokenUsage: { total: { inputTokens: i, outputTokens: i, totalTokens: 2 * i } },
        });
      }

      await clock.advance(120);
      const res = expectCheck(await pending);

      // The wait ran its full window: none of that traffic is a change to act on.
      expect(clock.elapsedMs()).toBe(120);
      expect(res.status).toBe("running");
      expect(res.actions).toEqual([]);
      // The counters the run produced still reach the caller, as a count.
      expect(res.progress.tokens?.total).toBe(98);
    });

    it("wakes on a new action", async () => {
      const clock = useFakeClock();
      const pending = executeCodexCheck(
        { action: "poll", sessionId, waitMs: 5000 },
        manager,
        undefined,
        pinnedWindow()
      );
      setTimeout(() => requestApproval(), 20);

      await clock.advance(20);
      const res = expectCheck(await pending);

      expect(res.actions).toHaveLength(1);
      expect(res.status).toBe("waiting_approval");
      expect(res.recommendedNextAction).toBe("respond_permission");
      // The approval ended the wait, 4980ms before the window would have.
      expect(clock.elapsedMs()).toBe(20);
    });

    it("wakes when the turn ends and carries its answer", async () => {
      const clock = useFakeClock();
      const pending = executeCodexCheck(
        { action: "poll", sessionId, waitMs: 5000 },
        manager,
        undefined,
        pinnedWindow()
      );
      setTimeout(() => completeTurn("the answer"), 20);

      await clock.advance(20);
      const res = expectCheck(await pending);

      expect(res.status).toBe("idle");
      expect(res.result?.text).toBe("the answer");
      expect(res.interactionState).toBe("finished");
      expect(clock.elapsedMs()).toBe(20);
    });

    it("wakes on a status change with nothing to answer", async () => {
      const clock = useFakeClock();
      const pending = executeCodexCheck(
        { action: "poll", sessionId, waitMs: 5000 },
        manager,
        undefined,
        pinnedWindow()
      );
      setTimeout(() => void manager.cancelSession(sessionId, "stopped by test"), 20);

      await clock.advance(20);
      const res = expectCheck(await pending);

      expect(res.status).toBe("cancelled");
      expect(clock.elapsedMs()).toBe(20);
    });

    it("reports the state it found when the wait window expires", async () => {
      const clock = useFakeClock();
      const pending = executeCodexCheck(
        { action: "poll", sessionId, waitMs: 30 },
        manager,
        undefined,
        pinnedWindow()
      );

      await clock.advance(30);
      const res = expectCheck(await pending);

      expect(res.status).toBe("running");
      expect(res.actions).toEqual([]);
      expect(res.result).toBeUndefined();
      expect(clock.elapsedMs()).toBe(30);
    });

    it("returns immediately when the request is already aborted", async () => {
      const controller = new AbortController();
      controller.abort();
      const waitForChange = jest.spyOn(manager, "waitForChange");

      const res = expectCheck(
        await executeCodexCheck(
          { action: "poll", sessionId, waitMs: 5000 },
          manager,
          controller.signal,
          pinnedWindow()
        )
      );

      expect(res.status).toBe("running");
      expect(waitForChange).not.toHaveBeenCalled();
    });

    it("stops waiting when the request is aborted mid-wait", async () => {
      const controller = new AbortController();
      const clock = useFakeClock();
      const pending = executeCodexCheck(
        { action: "poll", sessionId, waitMs: 5000 },
        manager,
        controller.signal,
        pinnedWindow()
      );
      setTimeout(() => controller.abort(), 20);

      await clock.advance(20);
      const res = expectCheck(await pending);

      expect(res.sessionId).toBe(sessionId);
      expect(clock.elapsedMs()).toBe(20);
    });

    it("cuts the wait down to what the client tolerates", async () => {
      const window = new PollWindow({ MCP_TOOL_TIMEOUT: "600000" });
      const observed: number[] = [];
      jest.spyOn(manager, "waitForChange").mockImplementation(async (_id, timeoutMs) => {
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
      jest.spyOn(manager, "waitForChange").mockImplementation(async (_id, timeoutMs) => {
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
      jest.spyOn(manager, "waitForChange").mockImplementation(async (_id, timeoutMs) => {
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

    it("keeps the finished turn's answer readable when the client cut the call", async () => {
      const controller = new AbortController();
      const pending = executeCodexCheck(
        { action: "poll", sessionId, waitMs: 5000 },
        manager,
        controller.signal,
        pinnedWindow()
      );
      // The turn ends and the client's clock runs out in the same instant, so
      // the SDK drops the response this call returns.
      setTimeout(() => {
        completeTurn("the answer");
        controller.abort("SdkError: Request timed out");
      }, 20);

      await pending;

      // The dropped response took nothing with it: the next call has the answer.
      const next = expectCheck(executeCodexCheck({ action: "poll", sessionId }, manager));
      expect(next.status).toBe("idle");
      expect(next.result?.text).toBe("the answer");
    });

    it("measures the cut and returns inside it from then on", async () => {
      const window = new PollWindow({ CLAUDECODE: "1" });
      const controller = new AbortController();
      // The ceiling the server learns is the time it held the call, and only a
      // fake clock says what that was to the millisecond.
      const clock = useFakeClock();

      const pending = executeCodexCheck(
        { action: "poll", sessionId, waitMs: 5_000 },
        manager,
        controller.signal,
        window
      );
      await clock.advance(40);
      controller.abort("SdkError: Request timed out");
      await pending;

      // The client named no ceiling until it cut this call, and the cut it
      // watched is exactly the 40ms this call was held.
      expect(window.ceilingMs()).toBe(40);
      expect(window.describe().source).toBe("measured");

      // A ceiling of some tens of milliseconds leaves no window worth holding,
      // so the next poll answers at once rather than walking into the same cut.
      expect(window.budgetMs()).toBe(0);
      const waitForChange = jest.spyOn(manager, "waitForChange");
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
      const clock = useFakeClock();
      const pending = executeCodexCheck(
        { action: "poll", sessionId, waitMs: MAX_LONG_POLL_WAIT_MS },
        manager,
        undefined,
        window
      );
      setTimeout(() => requestApproval(), 20);

      await clock.advance(20);
      const res = expectCheck(await pending);
      const elapsed = clock.elapsedMs();

      expect(window.budgetMs()).toBe(MAX_LONG_POLL_WAIT_MS);
      expect(res.status).toBe("waiting_approval");
      expect(res.actions).toHaveLength(1);
      expect(res.recommendedNextAction).toBe("respond_permission");
      // The pending request auto-declines after approvalTimeoutMs; the wait has
      // to end inside that, not inside the window it was given.
      expect(elapsed).toBe(20);
      expect(elapsed).toBeLessThan(DEFAULT_APPROVAL_TIMEOUT_MS);
    });

    it("answers at once when the client tolerates no window at all", async () => {
      const window = new PollWindow({ MCP_TOOL_TIMEOUT: "500" });
      const waitForChange = jest.spyOn(manager, "waitForChange");

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
      const waitSpy = jest.spyOn(manager, "waitForChange");

      const res = expectCheck(executeCodexCheck({ action: "poll", sessionId, waitMs: 0 }, manager));

      expect(res.sessionId).toBe(sessionId);
      expect(waitSpy).not.toHaveBeenCalled();
    });

    it("stops retrying when the session has no waiter slot left", async () => {
      const logged = jest.spyOn(console, "error").mockImplementation(() => {});
      const blockers = new AbortController();
      // MAX_WAITERS_PER_SESSION is 4, so these fill every slot of the session.
      const held = [0, 1, 2, 3].map(() =>
        manager.waitForChange(sessionId, 60_000, blockers.signal)
      );

      const res = expectCheck(
        await executeCodexCheck(
          { action: "poll", sessionId, waitMs: 200 },
          manager,
          undefined,
          pinnedWindow()
        )
      );

      expect(res.sessionId).toBe(sessionId);
      expect(res.status).toBe("running");
      // One refusal logged and no second one: the poll gave the 200ms window up
      // rather than re-asking for a slot until it ran out.
      expect(logged).toHaveBeenCalledTimes(1);
      expect(String(logged.mock.calls[0]![0])).toContain("Long-poll wait refused");

      blockers.abort();
      await Promise.all(held);
    });

    it("wakes on a change delivered between the read and the waiter registration", async () => {
      const clock = useFakeClock();
      const pending = executeCodexCheck(
        { action: "poll", sessionId, waitMs: 120_000 },
        manager,
        undefined,
        pinnedWindow()
      );
      // The long poll has run its synchronous part: it read the session state and
      // registered its waiter. This is the exact window the single-threaded loop
      // leaves between those two steps, so a change delivered here must still end
      // the wait.
      requestApproval();

      const res = expectCheck(await pending);

      expect(res.actions).toHaveLength(1);
      expect(clock.elapsedMs()).toBe(0);
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
