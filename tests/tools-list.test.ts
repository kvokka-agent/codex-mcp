import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";
import { RESOURCE_URIS } from "../src/resources/register-resources.js";

type RequestHandler = (req: unknown, extra: unknown) => Promise<unknown>;

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: { type?: string; properties?: Record<string, unknown> };
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
  return handler!;
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
  return found!;
}

function propertiesOf(schema: McpTool["inputSchema"], label: string): Record<string, unknown> {
  expect(schema, `${label} has no inputSchema`).toBeDefined();
  expect(schema!.properties, `${label} inputSchema has no properties`).toBeDefined();
  return schema!.properties!;
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

      const annotations = entry.annotations;
      expect(annotations, `${name} annotations`).toBeDefined();
      expect(typeof annotations!.title).toBe("string");
      expect(String(annotations!.title).length).toBeGreaterThan(0);
      for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
        expect(typeof annotations![hint], `${name} annotations.${hint}`).toBe("boolean");
      }
    }
  });

  it("describes the polling contract of every tool", async () => {
    const tools = await listTools();

    const codex = tool(tools, "codex").description ?? "";
    expect(codex).toContain("pollInterval");
    expect(codex).toContain("asynchronously");

    const codexReply = tool(tools, "codex_reply").description ?? "";
    expect(codexReply).toContain("idle");
    expect(codexReply).toContain("SESSION_BUSY");

    const codexSession = tool(tools, "codex_session").description ?? "";
    expect(codexSession).toContain("includeSensitive defaults to false");
    expect(codexSession).toContain("source remains unchanged");
    expect(codexSession).toContain("clean_background_terminals");

    const codexCheck = tool(tools, "codex_check").description ?? "";
    expect(codexCheck).toContain("waitMs");
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
    expect(actionSchema!.enum).toContain("respond_permission");
    expect(actionSchema!.enum).not.toContain("respond_approval");

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
    expect(compat.toolCounts!.core).toBe(tools.size);
  });
});
