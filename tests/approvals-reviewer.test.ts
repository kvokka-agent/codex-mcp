/**
 * `approvalsReviewer` end to end: what reaches the backend, what a poll reports
 * when the review denies, and what the tool schema publishes.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppServerClient } from "../src/app-server/client/index.js";
import { Methods } from "../src/app-server/wire/index.js";
import { createServer } from "../src/mcp/index.js";
import { SessionManager } from "../src/session/manager/session-manager.js";
import { SessionPersistence } from "../src/session/persistence.js";
import { executeCodex } from "../src/tools/codex.js";
import { executeCodexReply } from "../src/tools/codex-reply.js";
import { APPROVALS_REVIEWERS } from "../src/types/index.js";
import type { SessionDefaults } from "../src/utils/session-defaults.js";
import { present } from "./helpers/present.js";

const DEFAULTS: SessionDefaults = { effort: "low", approvalTimeoutMs: 60_000 };
const workspace = mkdtempSync(path.join(os.tmpdir(), "codex-mcp-reviewer-cwd-"));

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

class MockClient extends EventEmitter {
  notificationHandler: ((method: string, params: unknown) => void) | null = null;

  childPid: number | undefined = undefined;

  start = jest.fn(async () => ({ userAgent: "mock" }));
  threadStart = jest.fn(async (_params: unknown) => ({ thread: { id: "thread_mock" } }));
  threadFork = jest.fn(async (_params: unknown) => ({ thread: { id: "thread_forked" } }));
  threadResume = jest.fn(async (_params: unknown) => ({ thread: { id: "thread_forked" } }));
  threadDelete = jest.fn(async (_params: { threadId: string }) => ({}));
  turnStart = jest.fn(async (_params: unknown) => ({ turn: { id: "turn_mock" } }));
  turnInterrupt = jest.fn(async () => {});
  respondToServer = jest.fn(() => {});
  respondErrorToServer = jest.fn(() => {});
  destroy = jest.fn(async () => {});

  onNotification(handler: (method: string, params: unknown) => void): void {
    this.notificationHandler = handler;
  }
  onServerRequest(): void {}
  emitNotification(method: string, params: unknown): void {
    this.notificationHandler?.(method, params);
  }
}

/** The single argument the mock recorded for one of its calls. */
function paramsOf(
  fn: jest.Mock<(params: unknown) => unknown>,
  label: string
): Record<string, unknown> {
  const call = present(fn.mock.calls[0], `the ${label} call`);
  return call[0] as Record<string, unknown>;
}

describe("approvalsReviewer reaches the backend", () => {
  let manager: SessionManager;
  let client: MockClient;

  beforeEach(() => {
    client = new MockClient();
    manager = new SessionManager({
      disableCleanup: true,
      createClient: () => client as unknown as AppServerClient,
    });
  });

  afterEach(() => {
    manager.destroy();
  });

  it("puts auto_review on thread/start and on the first turn/start", async () => {
    await executeCodex(
      {
        prompt: "hi",
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        approvalsReviewer: "auto_review",
      },
      manager,
      workspace,
      DEFAULTS
    );

    expect(paramsOf(client.threadStart, "thread/start").approvalsReviewer).toBe("auto_review");
    expect(paramsOf(client.turnStart, "turn/start").approvalsReviewer).toBe("auto_review");
  });

  it("sends no reviewer when the call names none, leaving the schema default in force", async () => {
    await executeCodex(
      { prompt: "hi", approvalPolicy: "on-request", sandbox: "workspace-write" },
      manager,
      workspace,
      DEFAULTS
    );

    expect(paramsOf(client.threadStart, "thread/start").approvalsReviewer).toBeUndefined();
    expect(paramsOf(client.turnStart, "turn/start").approvalsReviewer).toBeUndefined();
  });

  it("keeps a codex_reply override on the turns that follow it", async () => {
    const { sessionId } = await executeCodex(
      { prompt: "hi", approvalPolicy: "on-request", sandbox: "workspace-write" },
      manager,
      workspace,
      DEFAULTS
    );
    manager.getSession(sessionId); // the turn is running until thread/status/changed
    client.emitNotification(Methods.THREAD_STATUS_CHANGED, {
      threadId: "thread_mock",
      status: { type: "idle" },
    });

    await executeCodexReply(
      { sessionId, prompt: "again", approvalsReviewer: "auto_review" },
      manager
    );
    client.emitNotification(Methods.THREAD_STATUS_CHANGED, {
      threadId: "thread_mock",
      status: { type: "idle" },
    });
    await executeCodexReply({ sessionId, prompt: "and again" }, manager);

    const turns = client.turnStart.mock.calls.map(
      (call) => (call[0] as Record<string, unknown>).approvalsReviewer
    );
    expect(turns).toEqual([undefined, "auto_review", "auto_review"]);
  });

  it("carries the reviewer into a fork and into the thread the fork resumes", async () => {
    const { sessionId } = await executeCodex(
      {
        prompt: "hi",
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        approvalsReviewer: "auto_review",
      },
      manager,
      workspace,
      DEFAULTS
    );
    client.emitNotification(Methods.THREAD_STATUS_CHANGED, {
      threadId: "thread_mock",
      status: { type: "idle" },
    });

    await manager.forkSession(sessionId);

    expect(paramsOf(client.threadFork, "thread/fork").approvalsReviewer).toBe("auto_review");
    expect(paramsOf(client.threadResume, "thread/resume").approvalsReviewer).toBe("auto_review");
  });
});

describe("a review that denies reaches the caller", () => {
  let root: string;
  let persistence: SessionPersistence;
  let manager: SessionManager;
  let client: MockClient;

  function readEventLines(sessionId: string): Array<Record<string, unknown>> {
    return readFileSync(path.join(root, "sessions", sessionId, "events.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  /** One `item/autoApprovalReview/completed` as the schema shapes it. */
  function reviewCompleted(status: string): Record<string, unknown> {
    return {
      action: { type: "command", command: "curl example.com", cwd: workspace, source: "shell" },
      completedAtMs: 1_700_000_001_000,
      decisionSource: "agent",
      review: { status, rationale: "reaches the network", riskLevel: "high" },
      reviewId: "rev_1",
      startedAtMs: 1_700_000_000_000,
      threadId: "thread_mock",
      turnId: "turn_mock",
    };
  }

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "codex-mcp-review-"));
    persistence = new SessionPersistence(root);
    client = new MockClient();
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

  it("reports a denial as the activity line a poll answers with", async () => {
    const { sessionId } = await manager.createSession("hi", workspace, {}, "low", {
      approvalsReviewer: "auto_review",
    });

    client.emitNotification(Methods.AUTO_APPROVAL_REVIEW_COMPLETED, reviewCompleted("denied"));

    expect(manager.pollStatus(sessionId).progress.activity).toBe(
      "Approval auto-review denied an action of this turn"
    );
  });

  it("records the denial as an approval_result carrying the status it read", async () => {
    const { sessionId } = await manager.createSession("hi", workspace, {}, "low", {
      approvalsReviewer: "auto_review",
    });

    client.emitNotification(Methods.AUTO_APPROVAL_REVIEW_COMPLETED, reviewCompleted("denied"));
    persistence.flushAll();

    const record = present(
      readEventLines(sessionId).find(
        (line) =>
          line.type === "approval_result" &&
          (line.data as Record<string, unknown>).method === Methods.AUTO_APPROVAL_REVIEW_COMPLETED
      ),
      "the approval_result record of the review"
    );
    expect(record.data).toMatchObject({
      status: "denied",
      reviewer: "auto_review",
      reviewId: "rev_1",
    });
  });

  it("leaves the turn's own activity line alone when the review approves", async () => {
    const { sessionId } = await manager.createSession("hi", workspace, {}, "low", {
      approvalsReviewer: "auto_review",
    });
    client.emitNotification(Methods.AGENT_MESSAGE_DELTA, {
      threadId: "thread_mock",
      itemId: "item_1",
      delta: "%%%ACTIVITY: fetching the page%%%",
    });

    client.emitNotification(Methods.AUTO_APPROVAL_REVIEW_COMPLETED, reviewCompleted("approved"));

    expect(manager.pollStatus(sessionId).progress.activity).toBe("fetching the page");
  });

  it("says a review timed out rather than that it denied", async () => {
    const { sessionId } = await manager.createSession("hi", workspace, {}, "low", {
      approvalsReviewer: "auto_review",
    });

    client.emitNotification(Methods.AUTO_APPROVAL_REVIEW_COMPLETED, reviewCompleted("timedOut"));

    expect(manager.pollStatus(sessionId).progress.activity).toBe(
      "Approval auto-review timed out on an action of this turn"
    );
  });

  it("keeps a review this server never opened out of the activity line", async () => {
    const { sessionId } = await manager.createSession("hi", workspace, {}, "low", {
      approvalsReviewer: "auto_review",
    });

    client.emitNotification(Methods.AUTO_APPROVAL_REVIEW_STARTED, {
      action: { type: "command", command: "ls", cwd: workspace, source: "shell" },
      review: { status: "inProgress" },
      reviewId: "rev_2",
      startedAtMs: 1_700_000_000_000,
      threadId: "thread_mock",
      turnId: "turn_mock",
    });
    client.emitNotification(Methods.AUTO_APPROVAL_REVIEW_STRICT_REQUIRED, {
      startedAtMs: 1_700_000_000_000,
      threadId: "thread_mock",
      turnId: "turn_mock",
    });
    persistence.flushAll();

    expect(manager.pollStatus(sessionId).progress.activity).toBeUndefined();
    const methods = readEventLines(sessionId).map(
      (line) => (line.data as Record<string, unknown>).method
    );
    expect(methods).toContain(Methods.AUTO_APPROVAL_REVIEW_STARTED);
    expect(methods).toContain(Methods.AUTO_APPROVAL_REVIEW_STRICT_REQUIRED);
  });
});

describe("the approvalsReviewer parameter a client reads", () => {
  type RequestHandler = (req: unknown, extra: unknown) => Promise<unknown>;
  interface McpTool {
    name: string;
    inputSchema?: { properties?: Record<string, { enum?: string[] }> };
  }

  let server: ReturnType<typeof createServer>["server"];

  beforeEach(() => {
    server = createServer(process.cwd()).server;
  });

  afterEach(async () => {
    await server.close();
  });

  async function toolsByName(): Promise<Map<string, McpTool>> {
    const internal = server as unknown as {
      server: { _requestHandlers: Map<string, RequestHandler> };
    };
    const handler = present(
      internal.server._requestHandlers.get("tools/list"),
      "the tools/list request handler"
    );
    const resp = (await handler(
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      {}
    )) as { tools: McpTool[] };
    return new Map(resp.tools.map((t) => [t.name, t]));
  }

  it.each(["codex", "codex_reply"])(
    "offers %s the two reviewers and not the legacy name",
    async (name) => {
      const tools = await toolsByName();
      const properties = present(
        present(tools.get(name), `the ${name} tool`).inputSchema?.properties,
        `the ${name} input properties`
      );

      expect(properties.approvalsReviewer?.enum).toEqual([...APPROVALS_REVIEWERS]);
      expect(properties.approvalsReviewer?.enum).not.toContain("guardian_subagent");
    }
  );
});
