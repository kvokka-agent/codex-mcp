import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { RESOURCE_URIS } from "../src/resources/register-resources.js";
import { createServer } from "../src/server.js";
import { SESSION_DEFAULT_ENV } from "../src/utils/session-defaults.js";
import { present } from "./helpers/present.js";

type RequestHandler = (req: unknown, extra: unknown) => Promise<unknown>;

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: { type?: string; properties?: Record<string, unknown>; required?: string[] };
  outputSchema?: { type?: string; properties?: Record<string, unknown> };
  annotations?: Record<string, unknown>;
}

const EXPECTED_TOOL_NAMES = ["codex", "codex_check", "codex_reply", "codex_session", "codex_setup"];

let server: ReturnType<typeof createServer>["server"];

function handlerFor(method: string): RequestHandler {
  const internal = server as unknown as {
    server: { _requestHandlers: Map<string, RequestHandler> };
  };
  const handler = internal.server._requestHandlers.get(method);
  expect(handler, `no request handler registered for ${method}`).toBeTypeOf("function");
  return present(handler, `the ${method} request handler`);
}

async function listTools(): Promise<Map<string, McpTool>> {
  const resp = (await handlerFor("tools/list")(
    { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    {}
  )) as { tools: McpTool[] };
  return new Map(resp.tools.map((t) => [t.name, t]));
}

function tool(tools: Map<string, McpTool>, name: string): McpTool {
  const found = tools.get(name);
  expect(found, `missing tool in tools/list: ${name}`).toBeDefined();
  return present(found, `the ${name} tool`);
}

function propertiesOf(schema: McpTool["inputSchema"], label: string): Record<string, unknown> {
  expect(schema, `${label} has no inputSchema`).toBeDefined();
  const inputSchema = present(schema, `the ${label} inputSchema`);
  expect(inputSchema.properties, `${label} inputSchema has no properties`).toBeDefined();
  return present(inputSchema.properties, `the ${label} inputSchema properties`);
}

describe("tools/list metadata", () => {
  beforeEach(() => {
    server = createServer(process.cwd()).server;
  });

  afterEach(async () => {
    await server.close();
  });

  it("advertises exactly the core tools, each with schemas and annotations", async () => {
    const tools = await listTools();

    expect([...tools.keys()].sort()).toEqual(EXPECTED_TOOL_NAMES);

    for (const name of EXPECTED_TOOL_NAMES) {
      const entry = tool(tools, name);

      expect(entry.inputSchema?.type, `${name} inputSchema.type`).toBe("object");
      expect(entry.outputSchema?.type, `${name} outputSchema.type`).toBe("object");
      expect(Object.keys(entry.inputSchema?.properties ?? {}).length).toBeGreaterThan(0);

      expect(entry.annotations, `${name} annotations`).toBeDefined();
      const annotations = present(entry.annotations, `the ${name} annotations`);
      expect(typeof annotations.title).toBe("string");
      expect(String(annotations.title).length).toBeGreaterThan(0);
      for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
        expect(typeof annotations[hint], `${name} annotations.${hint}`).toBe("boolean");
      }
    }
  });

  it("describes the polling contract of every tool", async () => {
    const tools = await listTools();

    const codex = tool(tools, "codex").description ?? "";
    expect(codex).toContain("at once");
    expect(codex).toContain("codex_check(action='poll', waitMs=300000)");
    expect(codex).toContain("progress.activity");

    const codexReply = tool(tools, "codex_reply").description ?? "";
    expect(codexReply).toContain("idle");
    expect(codexReply).toContain("SESSION_BUSY");
    expect(codexReply).toContain("codex_check(action='poll', waitMs=300000)");

    const codexSession = tool(tools, "codex_session").description ?? "";
    expect(codexSession).toContain("includeSensitive defaults to false");
    expect(codexSession).toContain("source remains unchanged");
    expect(codexSession).toContain("clean_background_terminals");
    expect(codexSession).toContain("terminate_background_terminal");
    expect(codexSession).toContain("add to the turn already running");

    const codexCheck = tool(tools, "codex_check").description ?? "";
    expect(codexCheck).toContain("waitMs");
    expect(codexCheck).toContain("activityStandingMs");
    expect(codexCheck).toContain("waitedMs");
    expect(codexCheck).toContain("rollout log");
    expect(codexCheck).toContain("respond_permission");
    expect(codexCheck).toContain("codex-mcp:///gotchas");
  });

  it("exposes the renamed input properties without their superseded spellings", async () => {
    const tools = await listTools();

    const replyProps = propertiesOf(tool(tools, "codex_reply").inputSchema, "codex_reply");
    expect(replyProps).toHaveProperty("sandbox");
    expect(replyProps).not.toHaveProperty("sandboxPolicy");

    const checkProps = propertiesOf(tool(tools, "codex_check").inputSchema, "codex_check");

    const actionSchema = checkProps.action as { enum?: unknown[] } | undefined;
    expect(actionSchema?.enum, "codex_check.action has no enum").toBeInstanceOf(Array);
    const actionEnum = present(actionSchema?.enum, "the codex_check action enum");
    expect(actionEnum).toContain("respond_permission");
    expect(actionEnum).not.toContain("respond_approval");

    expect(checkProps).toHaveProperty("execpolicy_amendment");
    expect(checkProps).not.toHaveProperty("execpolicyAmendment");

    // The event stream and everything that paged through it are gone from the input.
    for (const gone of ["cursor", "nextCursor", "maxEvents", "responseMode", "pollOptions"]) {
      expect(checkProps, `codex_check.${gone}`).not.toHaveProperty(gone);
    }

    // The wait a caller asks for is one number, at the top level.
    const waitMsSchema = checkProps.waitMs as Record<string, unknown> | undefined;
    expect(waitMsSchema, "codex_check.waitMs").toBeDefined();
    expect(waitMsSchema).not.toHaveProperty("default");
  });

  it("publishes the steer action of codex_session with the prompt it takes", async () => {
    const tools = await listTools();
    const session = tool(tools, "codex_session");
    const props = propertiesOf(session.inputSchema, "codex_session");

    const actionEnum = present(
      (props.action as { enum?: unknown[] }).enum,
      "the codex_session action enum"
    );
    expect(actionEnum).toContain("steer");
    expect(props).toHaveProperty("prompt");
    // The turn id a steer answers with is the running turn's, and the schema says so.
    const turnId = present(
      session.outputSchema?.properties?.turnId as { description?: string } | undefined,
      "codex_session.turnId"
    );
    expect(turnId.description).toContain("already running");
  });

  it("publishes the background-terminal surface of codex_session", async () => {
    const tools = await listTools();
    const session = tool(tools, "codex_session");

    const actionEnum = present(
      (propertiesOf(session.inputSchema, "codex_session").action as { enum?: unknown[] }).enum,
      "the codex_session action enum"
    );
    expect(actionEnum).toContain("clean_background_terminals");
    expect(actionEnum).toContain("terminate_background_terminal");
    expect(propertiesOf(session.inputSchema, "codex_session")).toHaveProperty("processId");

    const report = present(
      session.outputSchema?.properties?.backgroundTerminals as
        | { properties?: Record<string, unknown>; required?: string[] }
        | undefined,
      "codex_session.backgroundTerminals"
    );
    expect(Object.keys(present(report.properties, "backgroundTerminals properties"))).toEqual([
      "threadId",
      "terminals",
      "survivors",
      "truncated",
      "cleanCalled",
      "listError",
    ]);
    expect(report.required).toEqual(["threadId", "terminals"]);
  });

  it("reports the registered tool count in the compat report resource", async () => {
    const tools = await listTools();

    const read = (await handlerFor("resources/read")(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "resources/read",
        params: { uri: RESOURCE_URIS.compatReport },
      },
      {}
    )) as { contents: Array<{ text: string }> };

    const compat = JSON.parse(read.contents[0].text) as {
      toolCounts?: Record<string, number>;
    };
    expect(compat.toolCounts, "compat report has no toolCounts").toBeDefined();
    const toolCounts = present(compat.toolCounts, "the compat report toolCounts");
    expect(toolCounts.core).toBe(tools.size);
  });
});

describe("what the codex schema asks for, given the environment", () => {
  const KEYS = [SESSION_DEFAULT_ENV.approvalPolicy, SESSION_DEFAULT_ENV.sandbox] as const;
  const before = new Map(KEYS.map((key) => [key, process.env[key]]));

  afterEach(async () => {
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await server.close();
  });

  it("requires the permission level of the turn where the environment sets none", async () => {
    for (const key of KEYS) delete process.env[key];
    server = createServer(process.cwd()).server;

    const codex = tool(await listTools(), "codex");

    expect(codex.inputSchema?.required).toContain("approvalPolicy");
    expect(codex.inputSchema?.required).toContain("sandbox");
  });

  it("publishes it as optional, naming the value in force, where the environment sets it", async () => {
    process.env[SESSION_DEFAULT_ENV.approvalPolicy] = "never";
    process.env[SESSION_DEFAULT_ENV.sandbox] = "danger-full-access";
    server = createServer(process.cwd()).server;

    const codex = tool(await listTools(), "codex");
    const properties = propertiesOf(codex.inputSchema, "codex");

    expect(codex.inputSchema?.required ?? []).not.toContain("approvalPolicy");
    expect(codex.inputSchema?.required ?? []).not.toContain("sandbox");
    expect((properties.approvalPolicy as { description: string }).description).toContain(
      "default: never"
    );
    expect((properties.sandbox as { description: string }).description).toContain(
      "default: danger-full-access"
    );
  });
});
