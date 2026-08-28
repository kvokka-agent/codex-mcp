/**
 * MCP tool registration surface of src/server.ts:
 * routing into SessionManager, zod input validation, and the
 * `{ content, structuredContent, isError }` shape of every answer.
 *
 * Tools are driven through the SDK's own `tools/call` handler so the
 * registered input and output schemas run for real.
 */
import { EventEmitter } from "events";
import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import type { AppServerClient } from "../src/app-server/client.js";
import { Methods } from "../src/app-server/protocol.js";
import { createServer } from "../src/server.js";

class MockClient extends EventEmitter {
  notificationHandler: ((method: string, params: unknown) => void) | null = null;
  serverRequestHandler: ((id: number, method: string, params: unknown) => void) | null = null;

  supportsTurnOverrides = true;
  childPid: number | undefined = undefined;

  startError: Error | null = null;
  turnStartError: Error | null = null;

  start = jest.fn(async () => {
    if (this.startError) throw this.startError;
    return { userAgent: "mock" };
  });
  threadStart = jest.fn(async () => ({ thread: { id: "thread_mock" } }));
  threadFork = jest.fn(async () => ({ thread: { id: "thread_forked" } }));
  threadResume = jest.fn(async () => ({ thread: { id: "thread_forked" } }));
  threadBackgroundTerminalsClean = jest.fn(async () => ({}));
  turnStart = jest.fn(async () => {
    if (this.turnStartError) throw this.turnStartError;
    return { turn: { id: "turn_mock" } };
  });
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
}

interface ToolCallResult {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

describe("server tool registration", () => {
  let client: MockClient;
  let ctx: ReturnType<typeof createServer>;
  let callTool: (name: string, args: Record<string, unknown>) => Promise<ToolCallResult>;

  beforeEach(() => {
    client = new MockClient();
    ctx = createServer(process.cwd(), {
      disableCleanup: true,
      createClient: () => client as unknown as AppServerClient,
    });

    const internal = ctx.server as unknown as {
      server: {
        _requestHandlers: Map<string, (req: unknown, extra: unknown) => Promise<unknown>>;
      };
    };
    const handler = internal.server._requestHandlers.get("tools/call");
    expect(handler).toBeTypeOf("function");

    let nextId = 1;
    callTool = async (name, args) => {
      const controller = new AbortController();
      return (await handler!(
        {
          jsonrpc: "2.0",
          id: nextId++,
          method: "tools/call",
          params: { name, arguments: args },
        },
        { signal: controller.signal }
      )) as ToolCallResult;
    };
  });

  afterEach(async () => {
    await ctx.server.close();
    jest.restoreAllMocks();
  });

  async function startSession(): Promise<string> {
    const res = await callTool("codex", {
      prompt: "hello",
      approvalPolicy: "never",
      sandbox: "read-only",
    });
    expect(res.isError).toBe(false);
    return String(res.structuredContent!.sessionId);
  }

  /** Finish the running turn so the session becomes idle, as the app-server would. */
  function completeTurn(text: string): void {
    client.notificationHandler?.(Methods.TURN_COMPLETED, {
      turn: { id: "turn_mock", output: text, status: "completed" },
    });
  }

  describe("codex", () => {
    it("returns the started session as both text and structured content", async () => {
      const res = await callTool("codex", {
        prompt: "do a thing",
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        effort: "medium",
      });

      expect(res.isError).toBe(false);
      const structured = res.structuredContent!;
      expect(String(structured.sessionId)).toMatch(/^sess_/);
      expect(structured.threadId).toBe("thread_mock");
      expect(structured.status).toBe("running");
      expect(typeof structured.pollInterval).toBe("number");
      expect(structured.interactionState).toBe("working");
      expect(structured.recommendedNextAction).toBe("poll");

      // The text block carries the same payload the structured content does.
      expect(JSON.parse(res.content[0].text)).toEqual(structured);

      // The manager really drove the client with the tool arguments.
      expect(client.threadStart).toHaveBeenCalledWith(
        expect.objectContaining({ approvalPolicy: "on-request", sandbox: "workspace-write" })
      );
      expect(client.turnStart).toHaveBeenCalledWith(
        expect.objectContaining({ effort: "medium", threadId: "thread_mock" })
      );
    });

    it("reports a spawn failure as an INTERNAL error with paths redacted", async () => {
      client.startError = new Error("spawn failed for /home/someone/secret/bin/codex");

      const res = await callTool("codex", {
        prompt: "x",
        approvalPolicy: "never",
        sandbox: "read-only",
      });

      expect(res.isError).toBe(true);
      const message = res.content[0].text;
      expect(message).toContain("Error [INTERNAL]:");
      expect(message).toContain("<path>");
      expect(message).not.toContain("/home/someone/secret");
      expect(res.structuredContent).toEqual({ error: message, isError: true });
    });

    it("translates a turn compatibility failure into the guidance message", async () => {
      client.turnStartError = new Error(
        "reasoning effort 'minimal' is not supported together with web_search"
      );

      const res = await callTool("codex", {
        prompt: "x",
        approvalPolicy: "never",
        sandbox: "read-only",
        effort: "low",
      });

      expect(res.isError).toBe(true);
      expect(res.content[0].text).toBe(
        "Error [INVALID_ARGUMENT]: effort=minimal is incompatible with the Codex web_search tool in this CLI build. Use effort=low or higher, or let codex-mcp auto-upgrade it."
      );
    });

    it("rejects an unknown approval policy before reaching the session manager", async () => {
      const res = await callTool("codex", {
        prompt: "x",
        approvalPolicy: "yolo",
        sandbox: "read-only",
      });

      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("approvalPolicy");
      expect(client.start).not.toHaveBeenCalled();
    });

    it("rejects a cwd that does not exist", async () => {
      const res = await callTool("codex", {
        prompt: "x",
        approvalPolicy: "never",
        sandbox: "read-only",
        cwd: "/definitely/not/here/codex-mcp-missing",
      });

      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("Error [INVALID_ARGUMENT]: cwd does not exist");
      expect(client.start).not.toHaveBeenCalled();
    });
  });

  describe("codex_reply", () => {
    it("keeps the SESSION_NOT_FOUND code of the manager error", async () => {
      const res = await callTool("codex_reply", { sessionId: "sess_missing", prompt: "hi" });

      expect(res.isError).toBe(true);
      expect(res.content[0].text).toBe(
        "Error [SESSION_NOT_FOUND]: Session 'sess_missing' not found"
      );
      expect(res.structuredContent!.isError).toBe(true);
    });

    it("reports SESSION_BUSY while the first turn is still running", async () => {
      const sessionId = await startSession();

      const res = await callTool("codex_reply", { sessionId, prompt: "again" });

      expect(res.isError).toBe(true);
      expect(res.content[0].text).toBe(
        `Error [SESSION_BUSY]: Session '${sessionId}' is running, expected idle or error`
      );
    });

    it("starts a follow-up turn on an idle session", async () => {
      const sessionId = await startSession();
      completeTurn("first answer");

      const res = await callTool("codex_reply", {
        sessionId,
        prompt: "and now this",
        effort: "high",
      });

      expect(res.isError).toBe(false);
      expect(res.structuredContent!.sessionId).toBe(sessionId);
      expect(res.structuredContent!.status).toBe("running");
      expect(res.structuredContent!.interactionState).toBe("working");
      expect(JSON.parse(res.content[0].text)).toEqual(res.structuredContent);
      expect(client.turnStart).toHaveBeenLastCalledWith(
        expect.objectContaining({ effort: "high", input: [{ type: "text", text: "and now this" }] })
      );
    });

    it("redacts paths inside an INTERNAL error raised by the manager", async () => {
      const sessionId = await startSession();
      completeTurn("first answer");
      client.turnStartError = new Error("Error [INTERNAL]: boom at /home/someone/work/app.ts");

      const res = await callTool("codex_reply", { sessionId, prompt: "again" });

      expect(res.isError).toBe(true);
      expect(res.content[0].text).toBe("Error [INTERNAL]: boom at <path>");
    });
  });

  describe("codex_session", () => {
    it("lists the sessions held by the manager", async () => {
      const sessionId = await startSession();

      const res = await callTool("codex_session", { action: "list" });

      expect(res.isError).toBe(false);
      const sessions = res.structuredContent!.sessions as Array<Record<string, unknown>>;
      expect(sessions.map((s) => s.sessionId)).toEqual([sessionId]);
      expect(sessions[0].status).toBe("running");
      expect(sessions[0].pendingRequestCount).toBe(0);
    });

    it("hides sensitive fields unless includeSensitive is set", async () => {
      const sessionId = await startSession();

      const plain = await callTool("codex_session", { action: "get", sessionId });
      expect(plain.isError).toBe(false);
      expect(plain.structuredContent).not.toHaveProperty("threadId");

      const sensitive = await callTool("codex_session", {
        action: "get",
        sessionId,
        includeSensitive: true,
      });
      expect(sensitive.structuredContent!.threadId).toBe("thread_mock");
      expect(sensitive.structuredContent!.cwd).toBe(process.cwd());
    });

    it("marks a tool result carrying isError as an error response", async () => {
      const res = await callTool("codex_session", { action: "get" });

      expect(res.isError).toBe(true);
      expect(res.structuredContent!.error).toBe(
        "Error [INVALID_ARGUMENT]: sessionId required for 'get'"
      );
      expect(JSON.parse(res.content[0].text)).toEqual(res.structuredContent);
    });

    it("catches a throwing action and formats the message", async () => {
      const res = await callTool("codex_session", { action: "cancel", sessionId: "sess_gone" });

      expect(res.isError).toBe(true);
      expect(res.content[0].text).toBe("Error [SESSION_NOT_FOUND]: Session 'sess_gone' not found");
    });

    it("rejects an unknown action", async () => {
      const res = await callTool("codex_session", { action: "destroy" });

      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("action");
    });
  });

  describe("codex_setup", () => {
    const savedPath = process.env.PATH;
    const savedStateDir = process.env.CODEX_MCP_STATE_DIR;
    const savedCommand = process.env.CODEX_MCP_COMMAND;
    const savedExecPath = process.env.CODEX_MCP_PATH;

    beforeEach(() => {
      // An empty PATH keeps codex undetectable, so setup answers without spawning.
      process.env.PATH = "";
      process.env.CODEX_MCP_STATE_DIR = "/tmp/codex-mcp-test-state";
      delete process.env.CODEX_MCP_COMMAND;
      delete process.env.CODEX_MCP_PATH;
    });

    afterEach(() => {
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
      if (savedStateDir === undefined) delete process.env.CODEX_MCP_STATE_DIR;
      else process.env.CODEX_MCP_STATE_DIR = savedStateDir;
      if (savedCommand === undefined) delete process.env.CODEX_MCP_COMMAND;
      else process.env.CODEX_MCP_COMMAND = savedCommand;
      if (savedExecPath === undefined) delete process.env.CODEX_MCP_PATH;
      else process.env.CODEX_MCP_PATH = savedExecPath;
    });

    it("answers the readiness report for the given cwd", async () => {
      const res = await callTool("codex_setup", { cwd: process.cwd() });

      expect(res.isError).toBe(false);
      const structured = res.structuredContent!;
      expect(structured.ready).toBe(false);
      expect(structured.cwd).toBe(process.cwd());
      expect((structured.executable as { ok: boolean }).ok).toBe(false);
      expect((structured.runtime as { stateDir: string }).stateDir).toBe(
        "/tmp/codex-mcp-test-state"
      );
      expect(structured.warnings as string[]).not.toHaveLength(0);
      expect(JSON.parse(res.content[0].text)).toEqual(structured);
    });

    it("falls back to the server cwd when no cwd is given", async () => {
      const res = await callTool("codex_setup", {});

      expect(res.structuredContent!.cwd).toBe(process.cwd());
    });
  });

  describe("codex_check", () => {
    it("polls a live session and returns the poll shape", async () => {
      const sessionId = await startSession();

      const res = await callTool("codex_check", { action: "poll", sessionId });

      expect(res.isError).toBe(false);
      const structured = res.structuredContent!;
      expect(structured.sessionId).toBe(sessionId);
      expect(structured.status).toBe("running");
      expect(structured.interactionState).toBe("working");
      expect(structured.recommendedNextAction).toBe("poll");
      expect(structured.actions).toEqual([]);
      expect(structured).not.toHaveProperty("events");
      expect(structured).not.toHaveProperty("nextCursor");
    });

    it("marks an unknown session as an error result", async () => {
      const res = await callTool("codex_check", { action: "poll", sessionId: "sess_none" });

      expect(res.isError).toBe(true);
      expect(res.content[0].text).toBe("Error [SESSION_NOT_FOUND]: Session 'sess_none' not found");
    });

    it("names what replaced every input it no longer takes", async () => {
      const cases: Array<[string, unknown, string]> = [
        ["maxEvents", 10, "codex_check reports status, actions"],
        ["cursor", 0, "there is no event stream to page through"],
        ["nextCursor", 3, "there is no event stream to page through"],
        ["responseMode", "full", "the same status payload"],
        ["pollOptions", { waitMs: 1000 }, "pass waitMs at the top level"],
        ["pollOptions", { includeEvents: false }, "pass waitMs at the top level"],
      ];

      for (const [field, value, expected] of cases) {
        const res = await callTool("codex_check", {
          action: "poll",
          sessionId: "sess_x",
          [field]: value,
        });
        expect(res.isError, `poll accepted ${field}`).toBe(true);
        expect(res.content[0].text, field).toContain(expected);
      }
    });

    it("takes waitMs on a poll and refuses it on a respond", async () => {
      const sessionId = await startSession();

      const polled = await callTool("codex_check", { action: "poll", sessionId, waitMs: 5 });
      expect(polled.isError).toBe(false);

      const responded = await callTool("codex_check", {
        action: "respond_permission",
        sessionId,
        requestId: "req_1",
        decision: "accept",
        waitMs: 5,
      });
      expect(responded.isError).toBe(true);
      expect(responded.content[0].text).toContain("waitMs is only allowed for action='poll'");
    });

    it("rejects respond-only fields on a poll", async () => {
      const cases: Array<[string, unknown]> = [
        ["requestId", "req_1"],
        ["decision", "accept"],
        ["execpolicy_amendment", ["ls"]],
        ["network_policy_amendment", { action: "allow", host: "example.com" }],
        ["denyMessage", "no"],
        ["answers", { q1: { answers: ["yes"] } }],
      ];

      for (const [field, value] of cases) {
        const res = await callTool("codex_check", {
          action: "poll",
          sessionId: "sess_x",
          [field]: value,
        });
        expect(res.isError, `poll accepted ${field}`).toBe(true);
        expect(res.content[0].text).toContain(field);
      }
    });

    it("requires requestId and decision for respond_permission", async () => {
      const res = await callTool("codex_check", {
        action: "respond_permission",
        sessionId: "sess_x",
      });

      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain(
        "requestId is required for action='respond_permission'."
      );
      expect(res.content[0].text).toContain(
        "decision is required for action='respond_permission'."
      );
    });

    it("ties the amendment fields to their decisions", async () => {
      const base = { action: "respond_permission", sessionId: "sess_x", requestId: "req_1" };

      const missingExecpolicy = await callTool("codex_check", {
        ...base,
        decision: "acceptWithExecpolicyAmendment",
      });
      expect(missingExecpolicy.isError).toBe(true);
      expect(missingExecpolicy.content[0].text).toContain("execpolicy_amendment is required");

      const emptyExecpolicy = await callTool("codex_check", {
        ...base,
        decision: "acceptWithExecpolicyAmendment",
        execpolicy_amendment: [],
      });
      expect(emptyExecpolicy.isError).toBe(true);
      expect(emptyExecpolicy.content[0].text).toContain("non-empty");

      const strayExecpolicy = await callTool("codex_check", {
        ...base,
        decision: "accept",
        execpolicy_amendment: ["ls"],
      });
      expect(strayExecpolicy.isError).toBe(true);
      expect(strayExecpolicy.content[0].text).toContain("execpolicy_amendment is only allowed");

      const missingNetwork = await callTool("codex_check", {
        ...base,
        decision: "applyNetworkPolicyAmendment",
      });
      expect(missingNetwork.isError).toBe(true);
      expect(missingNetwork.content[0].text).toContain("network_policy_amendment is required");

      const strayNetwork = await callTool("codex_check", {
        ...base,
        decision: "accept",
        network_policy_amendment: { action: "allow", host: "example.com" },
      });
      expect(strayNetwork.isError).toBe(true);
      expect(strayNetwork.content[0].text).toContain("network_policy_amendment is only allowed");

      const strayAnswers = await callTool("codex_check", {
        ...base,
        decision: "accept",
        answers: { q1: { answers: ["yes"] } },
      });
      expect(strayAnswers.isError).toBe(true);
      expect(strayAnswers.content[0].text).toContain(
        "answers is only allowed for action='respond_user_input'."
      );
    });

    it("requires requestId and answers for respond_user_input and forbids approval fields", async () => {
      const missing = await callTool("codex_check", {
        action: "respond_user_input",
        sessionId: "sess_x",
      });
      expect(missing.isError).toBe(true);
      expect(missing.content[0].text).toContain(
        "requestId is required for action='respond_user_input'."
      );
      expect(missing.content[0].text).toContain(
        "answers is required for action='respond_user_input'."
      );

      const base = {
        action: "respond_user_input",
        sessionId: "sess_x",
        requestId: "req_1",
        answers: { q1: { answers: ["yes"] } },
      };
      for (const [field, value] of [
        ["decision", "accept"],
        ["execpolicy_amendment", ["ls"]],
        ["network_policy_amendment", { action: "allow", host: "example.com" }],
        ["denyMessage", "no"],
      ] as Array<[string, unknown]>) {
        const res = await callTool("codex_check", { ...base, [field]: value });
        expect(res.isError, `respond_user_input accepted ${field}`).toBe(true);
        expect(res.content[0].text).toContain(field);
      }
    });

    it("rejects a negative waitMs", async () => {
      const res = await callTool("codex_check", {
        action: "poll",
        sessionId: "sess_x",
        waitMs: -1,
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("waitMs");
    });
  });

  it("destroys the session manager when the server closes", async () => {
    await startSession();
    expect(ctx.sessionManager.listSessions()).toHaveLength(1);

    await ctx.server.close();

    expect(client.destroy).toHaveBeenCalled();
    expect(ctx.sessionManager.listSessions()).toEqual([]);
  });
});
