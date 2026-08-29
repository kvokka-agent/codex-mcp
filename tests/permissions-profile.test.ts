/**
 * The `permissions` parameter: what the tool schema refuses, what reaches
 * `thread/start` and `turn/start`, and what a caller is told about an id this
 * machine does not offer.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppServerClient } from "../src/app-server/client.js";
import type {
  PermissionProfileListParams,
  PermissionProfileListResult,
  PermissionProfileSummary,
} from "../src/app-server/protocol.js";
import { createServer } from "../src/server.js";
import { SessionManager } from "../src/session/manager.js";
import { executeCodex } from "../src/tools/codex.js";
import { executeCodexReply } from "../src/tools/codex-reply.js";
import type { SessionDefaults } from "../src/utils/session-defaults.js";
import { present } from "./helpers/present.js";

const DEFAULTS: SessionDefaults = { effort: "low", approvalTimeoutMs: 60_000 };
const workspace = mkdtempSync(path.join(os.tmpdir(), "codex-mcp-permissions-cwd-"));

const THREE_PROFILES: PermissionProfileSummary[] = [
  { id: ":read-only", allowed: true, description: null },
  { id: ":workspace", allowed: true, description: null },
  { id: ":danger-full-access", allowed: false, description: null },
];

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

class MockClient extends EventEmitter {
  notificationHandler: ((method: string, params: unknown) => void) | null = null;

  childPid: number | undefined = undefined;

  /** Pages the stubbed `permissionProfile/list` answers with, cursor by cursor. */
  pages: PermissionProfileListResult[] = [{ data: THREE_PROFILES, nextCursor: null }];
  listError: Error | null = null;
  listedParams: PermissionProfileListParams[] = [];

  start = jest.fn(async () => ({ userAgent: "mock" }));
  threadStart = jest.fn(async (_params: unknown) => ({ thread: { id: "thread_mock" } }));
  threadFork = jest.fn(async (_params: unknown) => ({ thread: { id: "thread_forked" } }));
  threadResume = jest.fn(async (_params: unknown) => ({ thread: { id: "thread_forked" } }));
  threadDelete = jest.fn(async (_params: { threadId: string }) => ({}));
  threadBackgroundTerminalsClean = jest.fn(async () => ({}));
  turnStart = jest.fn(async (_params: unknown) => ({ turn: { id: "turn_mock" } }));
  turnInterrupt = jest.fn(async () => {});
  respondToServer = jest.fn(() => {});
  respondErrorToServer = jest.fn(() => {});
  destroy = jest.fn(async () => {});

  permissionProfileList = jest.fn(async (params: PermissionProfileListParams) => {
    this.listedParams.push(params);
    if (this.listError) throw this.listError;
    // Answered by cursor, as the backend does, so a second listing starts over.
    const index =
      typeof params.cursor === "string"
        ? this.pages.findIndex((page) => page.nextCursor === params.cursor) + 1
        : 0;
    return present(this.pages[index], `the profile page at cursor ${String(params.cursor)}`);
  });

  onNotification(handler: (method: string, params: unknown) => void): void {
    this.notificationHandler = handler;
  }
  onServerRequest(): void {}
  emitNotification(method: string, params: unknown): void {
    this.notificationHandler?.(method, params);
  }
}

describe("a permissions profile reaching the backend", () => {
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

  async function start(permissions: string): Promise<string> {
    const result = await executeCodex(
      { prompt: "hi", approvalPolicy: "never", permissions },
      manager,
      workspace,
      DEFAULTS
    );
    return result.sessionId;
  }

  it("puts the id on thread/start and sends no sandbox with it", async () => {
    await start(":read-only");

    const params = present(client.threadStart.mock.calls[0], "the thread/start call")[0] as Record<
      string,
      unknown
    >;
    expect(params.permissions).toBe(":read-only");
    expect(params.sandbox).toBeUndefined();
    // Checked against the machine's own listing, for the cwd of the session.
    expect(client.listedParams).toEqual([{ cwd: workspace, cursor: undefined }]);
  });

  it("puts a codex_reply override on turn/start and never beside a sandbox", async () => {
    const sessionId = await start(":read-only");
    client.emitNotification("thread/status/changed", {
      threadId: "thread_mock",
      status: { type: "idle" },
    });

    await executeCodexReply({ sessionId, prompt: "again", permissions: ":workspace" }, manager);

    const turn = present(client.turnStart.mock.calls[1], "the second turn/start")[0] as Record<
      string,
      unknown
    >;
    expect(turn.permissions).toBe(":workspace");
    expect(turn.sandboxPolicy).toBeUndefined();
  });

  it("records the override on the session, and drops the sandbox a later reply names it over", async () => {
    const sessionId = await start(":read-only");
    client.emitNotification("thread/status/changed", {
      threadId: "thread_mock",
      status: { type: "idle" },
    });

    await executeCodexReply({ sessionId, prompt: "again", permissions: ":workspace" }, manager);
    client.emitNotification("thread/status/changed", {
      threadId: "thread_mock",
      status: { type: "idle" },
    });
    await manager.forkSession(sessionId);

    // The fork copies the session record, so what `thread/fork` carries is what
    // the reply left on it.
    const fork = present(client.threadFork.mock.calls[0], "the thread/fork call")[0] as Record<
      string,
      unknown
    >;
    expect(fork.permissions).toBe(":workspace");

    client.emitNotification("thread/status/changed", {
      threadId: "thread_mock",
      status: { type: "idle" },
    });
    await executeCodexReply({ sessionId, prompt: "and again", sandbox: "read-only" }, manager);
    await manager.forkSession(sessionId);

    const second = present(client.threadFork.mock.calls[1], "the second thread/fork")[0] as Record<
      string,
      unknown
    >;
    expect(second.permissions).toBeUndefined();
  });

  it("carries the profile into a fork and into the thread the fork resumes", async () => {
    const sessionId = await start(":workspace");
    client.emitNotification("thread/status/changed", {
      threadId: "thread_mock",
      status: { type: "idle" },
    });

    await manager.forkSession(sessionId);

    const fork = present(client.threadFork.mock.calls[0], "the thread/fork call")[0] as Record<
      string,
      unknown
    >;
    const resume = present(
      client.threadResume.mock.calls[0],
      "the thread/resume call"
    )[0] as Record<string, unknown>;
    expect(fork.permissions).toBe(":workspace");
    expect(resume.permissions).toBe(":workspace");
  });

  it("reports the profile Codex derived the active permissions from", async () => {
    // A call naming `permissions` sends no sandbox, so the profile id is the
    // only thing saying which permission level the session runs at.
    client.threadStart = jest.fn(async (_params: unknown) => ({
      thread: { id: "thread_mock" },
      model: "gpt-5.6-luna",
      modelProvider: "myproxy",
      cwd: workspace,
      approvalPolicy: "never",
      sandbox: { type: "readOnly" },
      approvalsReviewer: "user",
      activePermissionProfile: { id: ":read-only", extends: null },
    }));

    const sessionId = await start(":read-only");

    const session = manager.getSession(sessionId, true);
    // `extends: null` names no parent, so the reported profile carries only its id.
    expect(session.effective?.activePermissionProfile).toEqual({ id: ":read-only" });
    expect(session.effective?.sandbox).toEqual({ type: "readOnly" });
    // What the call asked for stays beside it: the profile id, and no sandbox.
    expect(session.permissions).toBe(":read-only");
    expect(session.sandbox).toBeUndefined();
  });

  it("lists the profile the call asked for beside the one Codex answered", async () => {
    client.threadStart = jest.fn(async (_params: unknown) => ({
      thread: { id: "thread_mock" },
      approvalsReviewer: "auto_review",
      activePermissionProfile: { id: ":workspace", extends: null },
    }));

    const sessionId = await start(":read-only");

    const listed = present(
      manager.listSessions().find((entry) => entry.sessionId === sessionId),
      "the started session in the listing"
    );
    expect(listed.permissions).toBe(":read-only");
    expect(listed.approvalsReviewer).toBeUndefined();
    expect(listed.effective).toEqual({
      approvalsReviewer: "auto_review",
      activePermissionProfile: { id: ":workspace" },
    });
  });

  it("names the ids that exist when the call named one that does not", async () => {
    await expect(start("no-such-profile")).rejects.toThrow(
      "Error [INVALID_ARGUMENT]: no permission profile 'no-such-profile' here. This machine offers: `:read-only`, `:workspace`, `:danger-full-access` (not selectable)."
    );
    expect(client.threadStart).not.toHaveBeenCalled();
  });

  it("tells a profile the backend does not allow apart from one that does not exist", async () => {
    await expect(start(":danger-full-access")).rejects.toThrow(
      /permission profile ':danger-full-access' exists but permissionProfile\/list answered `allowed: false`/
    );
    expect(client.threadStart).not.toHaveBeenCalled();
  });

  it("says a machine offers no profile at all rather than listing nothing", async () => {
    client.pages = [{ data: [], nextCursor: null }];

    await expect(start(":read-only")).rejects.toThrow(
      "This machine offers: none — a profile comes from a `[permissions.<id>]` table in the Codex config.toml."
    );
  });

  it("carries a listing that failed through instead of sending the id anyway", async () => {
    client.listError = new Error("permissionProfile/list timed out after 30000ms");

    await expect(start(":read-only")).rejects.toThrow(
      "Error [INTERNAL]: permissions profile ':read-only' could not be checked and was not sent: permissionProfile/list timed out after 30000ms"
    );
    expect(client.threadStart).not.toHaveBeenCalled();
  });

  it("refuses a listing it could not read the shape of", async () => {
    client.pages = [{ data: [{ id: ":read-only" }] as never, nextCursor: null }];

    await expect(start(":read-only")).rejects.toThrow(
      /answered an entry carrying no string `id` and boolean `allowed`/
    );
  });

  it("refuses a listing that carried no data array", async () => {
    client.pages = [{ nextCursor: null } as never];

    await expect(start(":read-only")).rejects.toThrow(
      /permissionProfile\/list answered no `data` array/
    );
  });

  it("refuses a listing it could not read to the end", async () => {
    // Every page hands back a cursor, so the listing never exhausts: a profile
    // absent from what was read is not a profile that does not exist.
    client.permissionProfileList = jest.fn(async (params: PermissionProfileListParams) => {
      client.listedParams.push(params);
      return { data: [], nextCursor: `page${client.listedParams.length}` };
    });

    await expect(start(":read-only")).rejects.toThrow(
      /handed back more than 20 pages and the listing is still not exhausted/
    );
    expect(client.listedParams).toHaveLength(20);
  });

  it("lists the profiles of a machine on a codex process of its own", async () => {
    const profiles = await manager.listPermissionProfiles(workspace);

    expect(profiles).toEqual(THREE_PROFILES);
    expect(client.start).toHaveBeenCalledWith({});
    expect(client.destroy).toHaveBeenCalled();
  });

  it("reports a destroy that failed and still answers the listing", async () => {
    const errors = jest.spyOn(console, "error").mockImplementation(() => {});
    client.destroy = jest.fn(async () => {
      throw new Error("destroy failed");
    });

    const profiles = await manager.listPermissionProfiles(workspace);

    expect(profiles).toEqual(THREE_PROFILES);
    expect(
      errors.mock.calls.some((call) =>
        String(call[0]).includes("client of a permission-profile listing")
      )
    ).toBe(true);
    errors.mockRestore();
  });

  it("follows the cursor before deciding a profile is missing", async () => {
    client.pages = [
      { data: [THREE_PROFILES[0]], nextCursor: "page2" },
      { data: [THREE_PROFILES[1]], nextCursor: null },
    ];

    await start(":workspace");

    expect(client.listedParams).toEqual([
      { cwd: workspace, cursor: undefined },
      { cwd: workspace, cursor: "page2" },
    ]);
    expect(client.threadStart).toHaveBeenCalled();
  });

  it("leaves the session idle when a reply names a profile that does not exist", async () => {
    const sessionId = await start(":read-only");
    client.emitNotification("thread/status/changed", {
      threadId: "thread_mock",
      status: { type: "idle" },
    });

    await expect(
      executeCodexReply({ sessionId, prompt: "again", permissions: "nope" }, manager)
    ).rejects.toThrow("no permission profile 'nope' here");

    expect(manager.getSession(sessionId).status).toBe("idle");
    expect(client.turnStart).toHaveBeenCalledTimes(1);
  });
});

describe("what the tool schema refuses", () => {
  interface ToolCallResult {
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }

  let ctx: ReturnType<typeof createServer>;
  let client: MockClient;
  let callTool: (name: string, args: Record<string, unknown>) => Promise<ToolCallResult>;

  beforeEach(() => {
    client = new MockClient();
    ctx = createServer(workspace, {
      disableCleanup: true,
      createClient: () => client as unknown as AppServerClient,
    });
    const internal = ctx.server as unknown as {
      server: {
        _requestHandlers: Map<string, (req: unknown, extra: unknown) => Promise<unknown>>;
      };
    };
    const handler = present(
      internal.server._requestHandlers.get("tools/call"),
      "the tools/call request handler"
    );
    let nextId = 1;
    callTool = async (name, args) =>
      (await handler(
        {
          jsonrpc: "2.0",
          id: nextId++,
          method: "tools/call",
          params: { name, arguments: args },
        },
        { signal: new AbortController().signal }
      )) as ToolCallResult;
  });

  afterEach(async () => {
    await ctx.server.close();
  });

  it.each(["codex", "codex_reply"])(
    "refuses sandbox and permissions together on %s",
    async (name) => {
      const res = await callTool(name, {
        prompt: "hi",
        sessionId: "sess_whatever",
        approvalPolicy: "never",
        sandbox: "read-only",
        permissions: ":read-only",
      });

      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("Name `sandbox` or `permissions`, not both");
      expect(client.start).not.toHaveBeenCalled();
    }
  );

  it("refuses a codex call that names neither, where the environment sets no sandbox", async () => {
    const res = await callTool("codex", { prompt: "hi", approvalPolicy: "never" });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("or a `permissions` profile id");
    expect(client.start).not.toHaveBeenCalled();
  });

  it("starts a session on a permissions profile alone", async () => {
    const res = await callTool("codex", {
      prompt: "hi",
      approvalPolicy: "never",
      permissions: ":read-only",
    });

    expect(res.isError).toBe(false);
    expect(client.threadStart).toHaveBeenCalledWith(
      expect.objectContaining({ permissions: ":read-only", sandbox: undefined })
    );
  });
});
