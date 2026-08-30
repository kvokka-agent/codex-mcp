/**
 * What a turn that produces no output says about itself.
 *
 * Every asserted value comes out of the code under test: a real `SessionManager`
 * with a real disk log behind a stand-in client is fed the notification params
 * `codex-schema/v2` defines, and the assertions read what `codex_check` answers
 * and what `events.jsonl` holds.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppServerClient } from "../src/app-server/client.js";
import { Methods } from "../src/app-server/protocol.js";
import { SessionManager } from "../src/session/manager.js";
import { SessionPersistence } from "../src/session/persistence.js";
import {
  bufferingWarningMessage,
  displayText,
  hookActivityLine,
  hookWarningMessage,
  MAX_SESSION_WARNINGS,
  MAX_WARNING_MESSAGE_CHARS,
} from "../src/session/warnings.js";
import type { CheckResult } from "../src/types.js";

/** One hook run, with the fields `HookRunSummary` requires and the overrides a test needs. */
function hookRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "hook_1",
    displayOrder: 0,
    entries: [],
    eventName: "sessionStart",
    executionMode: "sync",
    handlerType: "command",
    scope: "thread",
    sourcePath: "/home/user/.codex/hooks.toml",
    startedAt: 1_700_000_000_000,
    status: "running",
    statusMessage: "Loading the engineering rules",
    ...overrides,
  };
}

describe("warnings.ts", () => {
  it("reports nothing for text the backend did not send", () => {
    expect(displayText(undefined)).toBeUndefined();
    expect(displayText(null)).toBeUndefined();
    expect(displayText(42)).toBeUndefined();
    expect(displayText("   ")).toBeUndefined();
  });

  it("cuts a message longer than the cap and marks the cut", () => {
    const long = "я".repeat(MAX_WARNING_MESSAGE_CHARS + 50);
    const cut = displayText(long) as string;
    expect(cut).toHaveLength(MAX_WARNING_MESSAGE_CHARS);
    expect(cut.endsWith("…")).toBe(true);
  });

  it("names the model and the reasons the backend gave for buffering", () => {
    expect(
      bufferingWarningMessage({
        model: "gpt-5.6-luna",
        reasons: ["safety_review", "high_load"],
        showBufferingUi: true,
        threadId: "t",
        turnId: "u",
        useCases: [],
      })
    ).toBe("gpt-5.6-luna is buffering its output: safety_review, high_load");
  });

  it("names the faster model where the backend offered one", () => {
    expect(
      bufferingWarningMessage({
        model: "gpt-5.6-luna",
        reasons: [],
        fasterModel: "gpt-5.6-mini",
        showBufferingUi: true,
        threadId: "t",
        turnId: "u",
        useCases: [],
      })
    ).toBe("gpt-5.6-luna is buffering its output — gpt-5.6-mini is faster");
  });

  it("reports nothing for a buffering notification carrying no model", () => {
    expect(bufferingWarningMessage({ reasons: ["x"] })).toBeUndefined();
  });

  it("carries the hook's own stop and error lines into the warning", () => {
    expect(
      hookWarningMessage(
        hookRun({
          eventName: "preToolUse",
          status: "blocked",
          statusMessage: "Checking the command",
          entries: [
            { kind: "stop", text: "rm -rf is refused here" },
            { kind: "context", text: "ignored: not a reason" },
            { kind: "error", text: "policy 4 matched" },
          ],
        })
      )
    ).toBe(
      "preToolUse hook blocked — Checking the command — rm -rf is refused here — policy 4 matched"
    );
  });

  it("reports nothing for a hook run that held nothing back", () => {
    expect(hookWarningMessage(hookRun({ status: "running" }))).toBeUndefined();
    expect(hookWarningMessage(hookRun({ status: "completed" }))).toBeUndefined();
    expect(hookWarningMessage(hookRun({ status: 7 }))).toBeUndefined();
  });

  it("says which event a hook with no status message ran on", () => {
    expect(
      hookWarningMessage(hookRun({ status: "failed", statusMessage: null, entries: undefined }))
    ).toBe("sessionStart hook failed");
    expect(
      hookWarningMessage(hookRun({ status: "stopped", statusMessage: null, eventName: 3 }))
    ).toBe("a hook stopped");
  });

  it("takes the display line only from a status message the hook's author wrote", () => {
    expect(hookActivityLine(hookRun())).toBe("Loading the engineering rules");
    expect(hookActivityLine(hookRun({ statusMessage: null }))).toBeUndefined();
  });
});

class MockClient extends EventEmitter {
  notificationHandler: ((method: string, params: unknown) => void) | null = null;

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

  onServerRequest(): void {}

  emit_(method: string, params: unknown): void {
    this.notificationHandler?.(method, params);
  }
}

describe("SessionManager and what a quiet turn says", () => {
  let manager: SessionManager;
  let client: MockClient;
  let sessionId: string;
  let root: string;
  let persistence: SessionPersistence;

  function poll(): CheckResult {
    return manager.pollStatus(sessionId);
  }

  /** Stream one agent message the way codex does: token-sized deltas, then the item. */
  function streamMessage(text: string, itemId = "msg_1"): void {
    for (let i = 0; i < text.length; i += 3) {
      client.emit_(Methods.AGENT_MESSAGE_DELTA, {
        threadId: "thread_mock",
        turnId: "turn_mock",
        itemId,
        delta: text.slice(i, i + 3),
      });
    }
  }

  function loggedEvents(): Array<{ type: string; data: Record<string, unknown> }> {
    // A progress record is batched; the log is asked for what it holds.
    persistence.flushAll();
    return readFileSync(join(root, "sessions", sessionId, "events.jsonl"), "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string; data: Record<string, unknown> });
  }

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "codex-mcp-warnings-"));
    persistence = new SessionPersistence(root);
    client = new MockClient();
    manager = new SessionManager({
      disableCleanup: true,
      persistence,
      createClient: () => client as unknown as AppServerClient,
    });
    ({ sessionId } = await manager.createSession("задача", tmpdir(), {}, "low"));
    client.emit_(Methods.TURN_STARTED, { turn: { id: "turn_mock", status: "inProgress" } });
  });

  afterEach(() => {
    manager.destroy();
    persistence.destroy();
    rmSync(root, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it("answers a poll with nothing until the backend says something", () => {
    expect(poll().warnings).toEqual([]);
  });

  it("carries a backend warning to a poll", () => {
    client.emit_(Methods.WARNING, {
      message: "The account is over its weekly limit and turns are queued.",
      threadId: "thread_mock",
    });

    const [warning] = poll().warnings;
    expect(warning.method).toBe("warning");
    expect(warning.message).toBe("The account is over its weekly limit and turns are queued.");
    expect(Date.parse(warning.at)).not.toBeNaN();
  });

  it("redacts a path the backend put in a warning", () => {
    client.emit_(Methods.WARNING, {
      message: "Cannot read /home/kvokka/.codex/config.toml — falling back to the defaults",
      threadId: "thread_mock",
    });

    expect(poll().warnings[0].message).toBe("Cannot read <path> — falling back to the defaults");
  });

  it("carries a guardian warning to a poll", () => {
    client.emit_(Methods.GUARDIAN_WARNING, {
      message: "The reviewer is holding this command.",
      threadId: "thread_mock",
    });

    expect(poll().warnings).toEqual([
      expect.objectContaining({
        method: "guardianWarning",
        message: "The reviewer is holding this command.",
      }),
    ]);
  });

  it("carries a safety buffering the backend asked to show", () => {
    client.emit_(Methods.MODEL_SAFETY_BUFFERING_UPDATED, {
      model: "gpt-5.6-luna",
      reasons: ["safety_review"],
      showBufferingUi: true,
      threadId: "thread_mock",
      turnId: "turn_mock",
      useCases: ["coding"],
    });

    expect(poll().warnings).toEqual([
      expect.objectContaining({
        method: "model/safetyBuffering/updated",
        message: "gpt-5.6-luna is buffering its output: safety_review",
      }),
    ]);
  });

  it("keeps a buffering the backend asked not to show out of the answer and in the log", () => {
    client.emit_(Methods.MODEL_SAFETY_BUFFERING_UPDATED, {
      model: "gpt-5.6-luna",
      reasons: ["warmup"],
      showBufferingUi: false,
      threadId: "thread_mock",
      turnId: "turn_mock",
      useCases: [],
    });

    expect(poll().warnings).toEqual([]);
    expect(
      loggedEvents().filter((e) => e.data.method === Methods.MODEL_SAFETY_BUFFERING_UPDATED)
    ).toHaveLength(1);
  });

  it("carries a hook that blocked the turn to a poll", () => {
    client.emit_(Methods.HOOK_COMPLETED, {
      threadId: "thread_mock",
      turnId: "turn_mock",
      run: hookRun({
        eventName: "preToolUse",
        status: "blocked",
        statusMessage: "Checking the command",
        completedAt: 1_700_000_000_500,
        durationMs: 500,
        entries: [{ kind: "stop", text: "writes outside the workspace are refused" }],
      }),
    });

    expect(poll().warnings[0].message).toBe(
      "preToolUse hook blocked — Checking the command — writes outside the workspace are refused"
    );
  });

  it("says which hook ran when its author wrote no status message", () => {
    client.emit_(Methods.HOOK_COMPLETED, {
      threadId: "thread_mock",
      turnId: "turn_mock",
      run: hookRun({ eventName: "postToolUse", status: "blocked", statusMessage: null }),
    });

    const answer = poll();
    expect(answer.warnings[0].message).toBe("postToolUse hook blocked");
    // Nothing was written for display, so nothing stands in the activity line.
    expect(answer.progress.activity).toBeUndefined();
  });

  it("keeps a hook run that held nothing back out of the answer", () => {
    client.emit_(Methods.HOOK_COMPLETED, {
      threadId: "thread_mock",
      turnId: "turn_mock",
      run: hookRun({ status: "completed", statusMessage: null }),
    });

    expect(poll().warnings).toEqual([]);
  });

  it("ignores a hook notification carrying no run", () => {
    client.emit_(Methods.HOOK_STARTED, { threadId: "thread_mock" });

    expect(poll().warnings).toEqual([]);
    expect(loggedEvents().filter((e) => e.data.method === Methods.HOOK_STARTED)).toHaveLength(1);
  });

  it("stands the hook's line in the activity while the turn has said nothing", () => {
    client.emit_(Methods.HOOK_STARTED, {
      threadId: "thread_mock",
      turnId: "turn_mock",
      run: hookRun({ eventName: "userPromptSubmit" }),
    });

    expect(poll().progress.activity).toBe("Loading the engineering rules");
  });

  it("lets the turn's own marker take the line back and keeps every later hook off it", () => {
    client.emit_(Methods.HOOK_STARTED, { threadId: "thread_mock", run: hookRun() });
    expect(poll().progress.activity).toBe("Loading the engineering rules");

    streamMessage("%%%ACTIVITY: Читаю тест%%%\nтекст");
    expect(poll().progress.activity).toBe("Читаю тест");

    client.emit_(Methods.HOOK_STARTED, {
      threadId: "thread_mock",
      turnId: "turn_mock",
      run: hookRun({ id: "hook_2", statusMessage: "Running the pre-tool check" }),
    });
    expect(poll().progress.activity).toBe("Читаю тест");
  });

  it("lets a hook speak again once the next turn cleared the marker", () => {
    streamMessage("%%%ACTIVITY: Читаю тест%%%\nтекст");
    client.emit_(Methods.TURN_COMPLETED, { turn: { id: "turn_mock", status: "completed" } });
    client.emit_(Methods.TURN_STARTED, { turn: { id: "turn_2", status: "inProgress" } });

    client.emit_(Methods.HOOK_STARTED, {
      threadId: "thread_mock",
      turnId: "turn_2",
      run: hookRun({ statusMessage: "Running the pre-tool check" }),
    });

    expect(poll().progress.activity).toBe("Running the pre-tool check");
  });

  it("writes one activity record per hook line, marked as a hook's", () => {
    client.emit_(Methods.HOOK_STARTED, { threadId: "thread_mock", run: hookRun() });

    const [record] = loggedEvents().filter((entry) => entry.type === "activity");
    expect(record.data).toMatchObject({
      activity: "Loading the engineering rules",
      itemId: "hook_1",
      fromHook: true,
    });
  });

  it("keeps the newest warnings and drops the oldest", () => {
    for (let i = 0; i < MAX_SESSION_WARNINGS + 3; i++) {
      client.emit_(Methods.WARNING, { message: `warning ${i}`, threadId: "thread_mock" });
    }

    const { warnings } = poll();
    expect(warnings).toHaveLength(MAX_SESSION_WARNINGS);
    expect(warnings.map((w) => w.message)).toEqual([
      "warning 3",
      "warning 4",
      "warning 5",
      "warning 6",
      "warning 7",
    ]);
  });

  it("wakes a long poll on a warning", async () => {
    const before = manager.getSessionSignal(sessionId);
    let woke = false;
    const waiting = manager.waitForChange(sessionId, 60_000).then(() => {
      woke = true;
    });

    client.emit_(Methods.WARNING, { message: "queued behind a retry", threadId: "thread_mock" });
    await waiting;

    expect(woke).toBe(true);
    expect(manager.getSessionSignal(sessionId).key).not.toBe(before.key);
  });

  it("sleeps through the backend repeating a warning it already sent", () => {
    client.emit_(Methods.WARNING, { message: "queued behind a retry", threadId: "thread_mock" });
    const after = manager.getSessionSignal(sessionId);

    client.emit_(Methods.WARNING, { message: "queued behind a retry", threadId: "thread_mock" });

    expect(manager.getSessionSignal(sessionId).key).toBe(after.key);
    expect(poll().warnings).toHaveLength(1);
  });

  it("tells a held call about a warning while it is still held", () => {
    const heard: string[] = [];
    const stop = manager.onActivity(sessionId, (line) => heard.push(line));

    client.emit_(Methods.WARNING, { message: "the account is rate limited", threadId: "t" });
    client.emit_(Methods.HOOK_STARTED, { threadId: "thread_mock", run: hookRun() });
    stop();
    client.emit_(Methods.WARNING, { message: "heard by nobody", threadId: "t" });

    expect(heard).toEqual(["the account is rate limited", "Loading the engineering rules"]);
  });

  it("ignores a warning carrying no message", () => {
    client.emit_(Methods.WARNING, { threadId: "thread_mock" });

    expect(poll().warnings).toEqual([]);
  });
});
