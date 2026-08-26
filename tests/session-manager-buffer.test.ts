import { EventEmitter } from "events";
import os from "os";
import path from "path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AppServerClient } from "../src/app-server/client.js";
import { Methods } from "../src/app-server/protocol.js";
import { SessionManager } from "../src/session/manager.js";

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

const workspace = path.resolve(os.tmpdir(), "codex-mcp-tests");

/** Shrink a live session's buffer limits so eviction is reachable in a test. */
function setBufferLimits(
  manager: SessionManager,
  sessionId: string,
  maxSize: number,
  hardMaxSize: number
): void {
  const sessions = (
    manager as unknown as {
      sessions: Map<string, { eventBuffer: { maxSize: number; hardMaxSize: number } }>;
    }
  ).sessions;
  const session = sessions.get(sessionId)!;
  session.eventBuffer.maxSize = maxSize;
  session.eventBuffer.hardMaxSize = hardMaxSize;
}

function messagesOf(events: Array<{ data: unknown }>): unknown[] {
  return events.map((event) => (event.data as Record<string, unknown>)?.message);
}

describe("SessionManager event buffer eviction", () => {
  let client: MockClient;
  let manager: SessionManager;
  let errors: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    client = new MockClient();
    manager = new SessionManager({
      disableCleanup: true,
      createClient: () => client as unknown as AppServerClient,
    });
    errors = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    manager.destroy();
    vi.restoreAllMocks();
  });

  it("drops the oldest critical event at the hard limit and says so on stderr", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium");
    setBufferLimits(manager, started.sessionId, 1, 2);

    for (const message of ["boom-1", "boom-2", "boom-3", "boom-4"]) {
      client.emitNotification(Methods.ERROR, { message, willRetry: false });
    }

    const poll = manager.pollEvents(started.sessionId, 0, 50);
    expect(poll.events.map((event) => event.type)).toEqual(["error", "error"]);
    expect(messagesOf(poll.events)).toEqual(["boom-3", "boom-4"]);
    expect(
      errors.mock.calls.some((call) =>
        String(call[0]).includes(
          "Event buffer hard limit exceeded with only critical pinned events"
        )
      )
    ).toBe(true);
  });

  it("evicts an answered approval, then the plain progress, before the approval request", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium");
    setBufferLimits(manager, started.sessionId, 10, 2);

    client.emitServerRequest(60, Methods.COMMAND_APPROVAL, {
      itemId: "item_1",
      threadId: started.threadId,
      turnId: "turn_1",
      command: "echo hi",
      cwd: workspace,
    });
    const requestId = manager.pollEvents(started.sessionId, 0, 50).actions![0].requestId;
    manager.resolveApproval(started.sessionId, requestId, "accept");
    expect(manager.pollEvents(started.sessionId, 0, 50).events.map((event) => event.type)).toEqual([
      "approval_request",
      "approval_result",
    ]);

    client.emitNotification(Methods.REASONING_TEXT_DELTA, { itemId: "item_a", delta: "d1" });
    expect(manager.pollEvents(started.sessionId, 0, 50).events.map((event) => event.type)).toEqual([
      "approval_request",
      "progress",
    ]);

    client.emitNotification(Methods.REASONING_TEXT_DELTA, { itemId: "item_b", delta: "d2" });
    const poll = manager.pollEvents(started.sessionId, 0, 50);
    expect(poll.events.map((event) => event.type)).toEqual(["approval_request", "progress"]);
    expect((poll.events[1].data as { delta: string }).delta).toBe("d2");
  });

  it("evicts a pinned non-critical event before a pinned error at the hard limit", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium");
    setBufferLimits(manager, started.sessionId, 1, 2);

    client.emitNotification(Methods.THREAD_CLOSED, { threadId: started.threadId });
    client.emitNotification(Methods.ERROR, { message: "boom-1", willRetry: false });
    client.emitNotification(Methods.ERROR, { message: "boom-2", willRetry: false });

    const poll = manager.pollEvents(started.sessionId, 0, 50);
    expect(poll.events.map((event) => event.type)).toEqual(["error", "error"]);
    expect(messagesOf(poll.events)).toEqual(["boom-1", "boom-2"]);
    expect(
      errors.mock.calls.some((call) => String(call[0]).includes("Event buffer hard limit exceeded"))
    ).toBe(false);
  });
});

describe("SessionManager progress delta coalescing limits", () => {
  let client: MockClient;
  let manager: SessionManager;

  beforeEach(() => {
    client = new MockClient();
    manager = new SessionManager({
      disableCleanup: true,
      createClient: () => client as unknown as AppServerClient,
    });
  });

  afterEach(() => {
    manager.destroy();
    vi.restoreAllMocks();
  });

  it("starts a new event once the coalesced delta would pass the character cap", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium");
    const chunk = "a".repeat(10_000);

    client.emitNotification(Methods.REASONING_TEXT_DELTA, { turnId: "turn_1", delta: chunk });
    client.emitNotification(Methods.REASONING_TEXT_DELTA, { turnId: "turn_1", delta: chunk });

    const poll = manager.pollEvents(started.sessionId, 0, 50);
    expect(poll.events).toHaveLength(2);
    for (const event of poll.events) {
      expect((event.data as { delta: string }).delta).toHaveLength(10_000);
    }
  });

  it("does not coalesce deltas that carry no stream key", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium");

    client.emitNotification(Methods.COMMAND_OUTPUT_DELTA, { delta: "a" });
    client.emitNotification(Methods.COMMAND_OUTPUT_DELTA, { delta: "b" });

    const poll = manager.pollEvents(started.sessionId, 0, 50);
    expect(poll.events.map((event) => (event.data as { delta: string }).delta)).toEqual(["a", "b"]);
  });

  it("does not coalesce deltas of two different items", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium");

    client.emitNotification(Methods.REASONING_TEXT_DELTA, {
      turnId: "turn_1",
      itemId: "item_a",
      delta: "a",
    });
    client.emitNotification(Methods.REASONING_TEXT_DELTA, {
      turnId: "turn_1",
      itemId: "item_b",
      delta: "b",
    });

    const poll = manager.pollEvents(started.sessionId, 0, 50);
    expect(poll.events.map((event) => (event.data as { delta: string }).delta)).toEqual(["a", "b"]);
  });

  it("does not coalesce across a pinned event", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium");

    client.emitNotification(Methods.REASONING_TEXT_DELTA, { turnId: "turn_1", delta: "a" });
    client.emitNotification(Methods.THREAD_COMPACTED, { threadId: started.threadId });
    client.emitNotification(Methods.REASONING_TEXT_DELTA, { turnId: "turn_1", delta: "b" });

    const poll = manager.pollEvents(started.sessionId, 0, 50);
    expect(poll.events).toHaveLength(3);
    expect((poll.events[0].data as { delta: string }).delta).toBe("a");
    expect((poll.events[2].data as { delta: string }).delta).toBe("b");
  });
});

describe("SessionManager poll shaping", () => {
  let client: MockClient;
  let manager: SessionManager;

  beforeEach(() => {
    client = new MockClient();
    manager = new SessionManager({
      disableCleanup: true,
      createClient: () => client as unknown as AppServerClient,
    });
  });

  afterEach(() => {
    manager.destroy();
    vi.restoreAllMocks();
  });

  it("advances the cursor past deltas that skipDeltas dropped", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium");
    const emitDelta = (delta: string): void =>
      client.emitNotification(Methods.AGENT_MESSAGE_DELTA, {
        itemId: "item_1",
        turnId: "turn_1",
        delta,
      });
    const emitItem = (id: string): void =>
      client.emitNotification(Methods.ITEM_COMPLETED, {
        threadId: started.threadId,
        item: { id, type: "commandExecution", status: "completed" },
      });

    emitDelta("a");
    emitDelta("b");
    emitItem("cmd_1");
    emitDelta("c");
    emitItem("cmd_2");

    const first = manager.pollEvents(started.sessionId, 0, 1, {
      pollOptions: { skipDeltas: true },
    });
    expect(first.events).toHaveLength(1);
    expect((first.events[0].data as { item: { id: string } }).item.id).toBe("cmd_1");
    expect(first.events[0].id).toBe(2);
    expect(first.nextCursor).toBe(3);

    const second = manager.pollEvents(started.sessionId, undefined, 10, {
      pollOptions: { skipDeltas: true },
    });
    expect(second.events).toHaveLength(1);
    expect((second.events[0].data as { item: { id: string } }).item.id).toBe("cmd_2");
  });

  it("drops the terminal result and the progress block to fit maxBytes", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium");
    client.emitNotification(Methods.TURN_COMPLETED, {
      threadId: started.threadId,
      turn: { id: "turn_1", status: "completed", output: "R".repeat(500) },
    });

    const poll = manager.pollEvents(started.sessionId, 0, 50, {
      pollOptions: { maxBytes: 160 },
    });

    expect(poll.status).toBe("idle");
    expect(poll.truncated).toBe(true);
    expect(poll.truncatedFields).toEqual(["events", "result", "progress"]);
    expect(poll.events).toEqual([]);
    expect(poll.result).toBeUndefined();
    expect(poll.progress).toBeUndefined();
  });

  it("keeps the truncation note and drops the stale-cursor note when only one fits", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium");
    client.emitNotification(Methods.TURN_COMPLETED, {
      threadId: started.threadId,
      turn: { id: "turn_1", status: "completed", output: "R".repeat(500) },
    });
    // Move the session cursor forward so the explicit cursor below reads as stale.
    manager.pollEvents(started.sessionId, undefined, 50);

    const poll = manager.pollEventsMonotonic(started.sessionId, 0, 50, {
      pollOptions: { maxBytes: 350 },
    });

    expect(poll.truncated).toBe(true);
    expect(poll.compatWarnings).toEqual([
      "Response truncated to respect pollOptions.maxBytes=350.",
    ]);
  });

  it("drops surplus approvals but keeps an answerable one under maxBytes", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium");
    for (let i = 0; i < 3; i++) {
      client.emitServerRequest(200 + i, Methods.COMMAND_APPROVAL, {
        itemId: `item_${i}`,
        threadId: started.threadId,
        turnId: "turn_1",
        command: `echo ${"x".repeat(2000)}`,
        cwd: workspace,
      });
    }

    const poll = manager.pollEvents(started.sessionId, 0, 50, {
      pollOptions: { includeEvents: false, maxBytes: 700 },
    });

    expect(poll.status).toBe("waiting_approval");
    expect(poll.truncated).toBe(true);
    expect(poll.truncatedFields).toContain("actions");
    expect(poll.actions!.length).toBeGreaterThanOrEqual(1);
    expect(poll.actions!.length).toBeLessThan(3);
    // The surviving approval is still answerable.
    manager.resolveApproval(started.sessionId, poll.actions![0].requestId, "accept");
    expect(client.respondToServer).toHaveBeenCalled();
  });

  it("strips a user_input action down to its ids when the compacted form still overflows", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium");
    client.emitServerRequest(300, Methods.USER_INPUT_REQUEST, {
      itemId: "item_minimum",
      threadId: started.threadId,
      turnId: "turn_1",
      questions: [{ id: "q".repeat(600), question: "A".repeat(3000) }],
    });

    const poll = manager.pollEvents(started.sessionId, 0, 50, {
      pollOptions: { includeEvents: false, maxBytes: 700 },
    });

    expect(poll.truncatedFields).toContain("actions");
    expect(poll.actions).toHaveLength(1);
    expect(poll.actions![0].kind).toBe("user_input");
    expect(poll.actions![0].params).toBeUndefined();
    manager.resolveUserInput(started.sessionId, poll.actions![0].requestId, {});
    expect(client.respondToServer).toHaveBeenCalled();
  });

  it("compacts a user_input action whose questions are not a list", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium");
    client.emitServerRequest(301, Methods.USER_INPUT_REQUEST, {
      itemId: "item_bad_questions",
      threadId: started.threadId,
      turnId: "turn_1",
      questions: "not-a-list",
      filler: "A".repeat(3000),
    });

    const poll = manager.pollEvents(started.sessionId, 0, 50, {
      pollOptions: { includeEvents: false, maxBytes: 700 },
    });

    expect(poll.actions).toHaveLength(1);
    expect(poll.actions![0].params).toBeUndefined();
  });

  it("keeps only the question entries that carry an id", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium");
    client.emitServerRequest(302, Methods.USER_INPUT_REQUEST, {
      itemId: "item_mixed_questions",
      threadId: started.threadId,
      turnId: "turn_1",
      questions: ["skip-me", { question: "A".repeat(3000) }, { id: "q1", question: "pick" }],
    });

    const poll = manager.pollEvents(started.sessionId, 0, 50, {
      pollOptions: { includeEvents: false, maxBytes: 700 },
    });

    expect(poll.actions).toHaveLength(1);
    expect(poll.actions![0].params).toEqual({ questions: [{ id: "q1" }] });
  });

  it("drops the actions entirely when the session is no longer waiting on the caller", async () => {
    const started = await manager.createSession("hi", workspace, {}, "medium");
    client.emitServerRequest(400, Methods.COMMAND_APPROVAL, {
      itemId: "item_error",
      threadId: started.threadId,
      turnId: "turn_1",
      command: `echo ${"x".repeat(2000)}`,
      cwd: workspace,
    });
    client.emitNotification(Methods.ERROR, { message: "fatal", willRetry: false });
    expect(manager.getSession(started.sessionId).status).toBe("error");

    const poll = manager.pollEvents(started.sessionId, 0, 50, {
      pollOptions: { includeEvents: false, maxBytes: 200 },
    });

    expect(poll.truncatedFields).toContain("actions");
    expect(poll.actions).toBeUndefined();
  });
});
