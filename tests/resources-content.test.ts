import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mockModule } from "./helpers/mock.js";
import { present } from "./helpers/present.js";

/**
 * `detectCodexCliVersion` shells out to `codex --version`; the stub keeps the suite off the
 * real CLI and lets each test choose what the binary answered.
 */
const spawnState = {
  calls: [] as Array<{ command: string; args: string[] }>,
  impl: (() => ({ status: 0, stdout: "codex-cli 0.150.1", stderr: "" })) as (
    command: string,
    args: string[]
  ) => unknown,
};

const realModule1 = { ...(await import("node:child_process")) };
mockModule("child_process", realModule1, () => {
  const actual = realModule1;
  return {
    ...actual,
    default: actual,
    spawnSync: (command: string, args: string[]) => {
      spawnState.calls.push({ command, args });
      return spawnState.impl(command, args);
    },
  };
});

const { createServer } = await import("../src/server.js");
const { Methods } = await import("../src/app-server/wire/index.js");

import type { SessionDefaults } from "../src/utils/session-defaults.js";

const { registerResources, RESOURCE_URIS } = await import("../src/resources/index.js");
const { SessionManager } = await import("../src/session/manager/session-manager.js");
const {
  APPROVAL_POLICIES,
  SANDBOX_MODES,
  ADVERTISED_EFFORT_LEVELS,
  DEFAULT_EFFORT_LEVEL,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  ErrorCode,
  MAX_LONG_POLL_WAIT_MS,
  DEFAULT_IDLE_CLEANUP_MS,
  DEFAULT_RUNNING_CLEANUP_MS,
  DEFAULT_TERMINAL_CLEANUP_MS,
} = await import("../src/types/index.js");
const { MIN_CODEX_CLI_VERSION } = await import("../src/utils/codex-version.js");

const DEFAULT_SPAWN_IMPL = spawnState.impl;

afterEach(() => {
  spawnState.impl = DEFAULT_SPAWN_IMPL;
  spawnState.calls.length = 0;
});

type JsonSchema = {
  properties?: Record<string, { properties?: Record<string, unknown>; enum?: unknown[] }>;
  required?: string[];
};

function collectMatches(text: string, re: RegExp): string[] {
  return Array.from(new Set(Array.from(text.matchAll(re), (m) => m[1])));
}

/**
 * Every `CODEX_MCP_*` name the server source carries — the reads themselves and the constants
 * naming them. A variable added to src/ without a line in the config guide fails the run.
 */
function scanEnvVarNames(dir: string, found = new Set<string>()): Set<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) scanEnvVarNames(full, found);
    else if (entry.name.endsWith(".ts")) {
      for (const [name] of readFileSync(full, "utf8").matchAll(/CODEX_MCP_[A-Z_]+/g))
        found.add(name);
    }
  }
  return found;
}

const SRC_ENV_VARS = scanEnvVarNames(fileURLToPath(new URL("../src", import.meta.url)));

type SchemaNode = Record<string, unknown>;

/**
 * Every message of the vendored codex-schema bundle, as name -> its property names.
 *
 * Keyed by message rather than pooled into one bag of names: `output` is a property of
 * several exec payloads and of no `Turn`, so a document claiming `turn.output` has to be
 * measured against `Turn` alone.
 */
function loadProtocolMessages(
  dir: string,
  index = new Map<string, Set<string>>()
): Map<string, Set<string>> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) loadProtocolMessages(full, index);
    else if (entry.name.endsWith(".json")) {
      const doc = JSON.parse(readFileSync(full, "utf8")) as SchemaNode;
      indexMessage(doc, typeof doc.title === "string" ? doc.title : undefined, index);
    }
  }
  return index;
}

function recordProperties(
  name: string,
  properties: SchemaNode,
  index: Map<string, Set<string>>
): void {
  const key = name.toLowerCase();
  const known = index.get(key) ?? new Set<string>();
  for (const property of Object.keys(properties)) known.add(property);
  index.set(key, known);
}

/** Walks one entry of a node: a named schema container carries its own names. */
function indexEntry(
  key: string,
  value: unknown,
  name: string | undefined,
  index: Map<string, Set<string>>
): void {
  if ((key === "definitions" || key === "properties") && value && typeof value === "object") {
    for (const [child, body] of Object.entries(value as SchemaNode))
      indexMessage(body, child, index);
    return;
  }
  indexMessage(value, name, index);
}

function indexMessage(
  node: unknown,
  name: string | undefined,
  index: Map<string, Set<string>>
): void {
  if (Array.isArray(node)) {
    for (const item of node) indexMessage(item, name, index);
    return;
  }
  if (!node || typeof node !== "object") return;
  const record = node as SchemaNode;
  const properties = record.properties as SchemaNode | undefined;
  if (name && properties) recordProperties(name, properties, index);
  for (const [key, value] of Object.entries(record)) indexEntry(key, value, name, index);
}

const PROTOCOL_MESSAGES = loadProtocolMessages(
  fileURLToPath(new URL("../codex-schema", import.meta.url))
);

/** Schemas reachable at `node`, looking through arrays and anyOf/oneOf/allOf branches. */
function branchesOf(node: unknown): SchemaNode[] {
  if (!node || typeof node !== "object") return [];
  const record = node as SchemaNode;
  const branches = [record];
  const nested = [
    record.items,
    ...(Array.isArray(record.anyOf) ? record.anyOf : []),
    ...(Array.isArray(record.oneOf) ? record.oneOf : []),
    ...(Array.isArray(record.allOf) ? record.allOf : []),
  ];
  for (const child of nested) branches.push(...branchesOf(child));
  return branches;
}

/** Whether every segment of `path` names a property, segment by segment, under `node`. */
function resolvesInSchema(node: unknown, path: string[]): boolean {
  if (path.length === 0) return true;
  for (const branch of branchesOf(node)) {
    const properties = branch.properties as SchemaNode | undefined;
    const child = properties?.[path[0]];
    if (child !== undefined && resolvesInSchema(child, path.slice(1))) return true;
  }
  return false;
}

/** Whether `path` names a field of a codex-schema message, following it segment by segment. */
function resolvesInProtocol(path: string[]): boolean {
  const [root, ...rest] = path;
  let owner = PROTOCOL_MESSAGES.get(root.toLowerCase());
  if (!owner) return false;
  for (const segment of rest) {
    if (!owner?.has(segment)) return false;
    owner = PROTOCOL_MESSAGES.get(segment.toLowerCase());
  }
  return true;
}

/** One file of the vendored bundle, for a claim that names a single message. */
function readSchemaFile(file: string): SchemaNode {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(`../codex-schema/${file}`, import.meta.url)), "utf8")
  ) as SchemaNode;
}

/** The fenced JSON examples of a document, parsed. */
function jsonExamples(text: string): SchemaNode[] {
  return Array.from(
    text.matchAll(/```json\n([\s\S]*?)```/g),
    (match) => JSON.parse(match[1]) as SchemaNode
  );
}

/** Backticked dotted paths of the documents: `turn.status`, `advanced.images`, `result.text`. */
function documentedFieldPaths(text: string): string[][] {
  return collectMatches(text, /`([a-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)`/g).map((path) =>
    path.split(".")
  );
}

/** Minimal ICodexClient stand-in: SessionManager drives it, the tests read what it was asked. */
class StubCodexClient extends EventEmitter {
  /** Handler the manager registered, so a test can play backend notifications into it. */
  private notify: ((method: string, params: unknown) => void) | null = null;
  destroyed = false;
  childPid: number | undefined = undefined;
  turnStartCalls: Array<{ effort?: string }> = [];
  /** Codex CLI builds that reject minimal effort answer with this shape of message. */
  rejectMinimalEffort = false;

  start = async () => ({ userAgent: "stub" });
  threadStart = async () => ({ thread: { id: "thread_stub" } });
  threadFork = async () => ({ thread: { id: "thread_stub" } });
  threadResume = async () => ({ thread: { id: "thread_stub" } });
  threadBackgroundTerminalsClean = async () => ({});
  turnStart = async (params: { effort?: string }) => {
    this.turnStartCalls.push(params);
    if (this.rejectMinimalEffort && params.effort === "minimal") {
      throw new Error("reasoning effort minimal is not supported with the web_search tool");
    }
    return { turn: { id: "turn_stub" } };
  };
  turnInterrupt = async () => {};
  respondToServer = () => {};
  respondErrorToServer = () => {};
  destroy = async () => {
    this.destroyed = true;
  };
  onNotification(handler: (method: string, params: unknown) => void): void {
    this.notify = handler;
  }
  onServerRequest(): void {}

  notifyManager(method: string, params: unknown): void {
    this.notify?.(method, params);
  }
}

type OpenedServer = {
  server: Awaited<ReturnType<typeof createServer>>["server"];
  docs: Map<string, string>;
  listedResources: Array<Record<string, unknown>>;
  tools: Map<string, { inputSchema?: JsonSchema; outputSchema?: JsonSchema }>;
};

/** Everything a real MCP client can read off a server built with `options`. */
async function openServer(options: Parameters<typeof createServer>[1]): Promise<OpenedServer> {
  const created = createServer(process.cwd(), options);
  const handlers = (
    created.server as unknown as {
      server: {
        _requestHandlers: Map<
          string,
          (req: unknown, extra: unknown) => Promise<Record<string, never>>
        >;
      };
    }
  ).server._requestHandlers;

  const call = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
    const handler = present(handlers.get(method), `the ${method} request handler`);
    return (await handler({ jsonrpc: "2.0", id: 1, method, params }, {})) as unknown as T;
  };

  const resourceList = await call<{ resources: Array<Record<string, unknown>> }>(
    "resources/list",
    {}
  );

  const docs = new Map<string, string>();
  for (const resource of resourceList.resources) {
    const read = await call<{ contents: Array<{ uri: string; text: string }> }>("resources/read", {
      uri: resource.uri,
    });
    docs.set(String(resource.uri), read.contents[0].text);
  }

  const toolList = await call<{ tools: Array<Record<string, unknown>> }>("tools/list", {});
  return {
    server: created.server,
    docs,
    listedResources: resourceList.resources,
    tools: new Map(
      toolList.tools.map((tool) => [
        String(tool.name),
        tool as { inputSchema?: JsonSchema; outputSchema?: JsonSchema },
      ])
    ),
  };
}

describe("resource documents served over MCP", () => {
  let server: Awaited<ReturnType<typeof createServer>>["server"];
  let docs: Map<string, string>;
  let listedResources: Array<Record<string, unknown>>;
  let tools: Map<string, { inputSchema?: JsonSchema; outputSchema?: JsonSchema }>;
  let allText: string;

  beforeAll(async () => {
    // No persistence adapter: this server keeps sessions in memory only, and the documents
    // it serves have to say so.
    const opened = await openServer({ disableCleanup: true });
    server = opened.server;
    docs = opened.docs;
    listedResources = opened.listedResources;
    tools = opened.tools;
    allText = Array.from(docs.values()).join("\n");
  });

  afterAll(async () => {
    await server.close();
  });

  it("serves every advertised resource with a non-empty body", () => {
    expect(Array.from(docs.keys()).sort()).toEqual(Object.values(RESOURCE_URIS).sort());
    for (const [uri, text] of docs) {
      expect(text.length, `empty resource body: ${uri}`).toBeGreaterThan(0);
    }
  });

  it("lists in server-info exactly the resources the server registered", () => {
    const serverInfo = present(docs.get(RESOURCE_URIS.serverInfo), "the server-info resource");
    const info = JSON.parse(serverInfo) as {
      resources: Array<Record<string, unknown>>;
    };

    expect(info.resources).toEqual(
      listedResources.map((r) => ({
        uri: r.uri,
        title: r.title,
        mimeType: r.mimeType,
        description: r.description,
      }))
    );
  });

  it("links only to resource URIs that exist", () => {
    const referenced = Array.from(new Set(allText.match(/codex-mcp:\/\/\/[a-z-]+/g) ?? []));

    expect(referenced.length).toBeGreaterThan(0);
    expect(referenced.sort()).toEqual(
      referenced.filter((uri) => docs.has(uri)).sort(),
      `dangling resource links: ${referenced.filter((uri) => !docs.has(uri)).join(", ")}`
    );
  });

  it("counts in the compat report the tools the server actually exposes", () => {
    const compatReport = present(
      docs.get(RESOURCE_URIS.compatReport),
      "the compat-report resource"
    );
    const compat = JSON.parse(compatReport) as {
      toolCounts: { core: number };
      runtimeWarnings: string[];
      runtime: { codexMcpVersion: string; codexCliVersion: string | null };
    };

    expect(compat.toolCounts.core).toBe(tools.size);
    // The stubbed CLI answers `--version`, so the only warning left is the one this server earns:
    // it was built without a persistence adapter.
    expect(compat.runtimeWarnings).toEqual([
      "Disk persistence is off: sessions are held in memory only and are lost when the server restarts.",
    ]);
  });

  it("names every registered tool somewhere in the docs", () => {
    for (const name of tools.keys()) {
      expect(allText, `tool absent from all resources: ${name}`).toContain(name);
    }
  });

  it("documents error codes that match the ErrorCode enum one-for-one", () => {
    const errorsText = present(docs.get(RESOURCE_URIS.errors), "the errors resource");
    const codesSection = errorsText.split("## Codes")[1].split("## Recovery basics")[0];
    const documented = Array.from(codesSection.matchAll(/^- `([A-Z_]+)`: (.+)$/gm));

    expect(documented.map((m) => m[1])).toEqual(Object.values(ErrorCode));
    for (const [, code, hint] of documented) {
      expect(hint.trim().length, `empty hint for ${code}`).toBeGreaterThan(10);
    }
  });

  it("mentions no error code that the enum does not define", () => {
    const known = new Set<string>([...Object.values(ErrorCode), ...SRC_ENV_VARS]);
    const mentioned = collectMatches(allText, /`([A-Z][A-Z_]{4,})`/g);

    expect(mentioned.length).toBeGreaterThan(0);
    expect(mentioned.filter((code) => !known.has(code))).toEqual([]);
  });

  it("documents in the config guide every CODEX_MCP_* variable the source carries", () => {
    const configText = present(docs.get(RESOURCE_URIS.config), "the config resource");
    const section = configText.split("## Environment variables")[1].split("\n## ")[0];
    const documented = collectMatches(section, /^- `(CODEX_MCP_[A-Z_]+)`: (.+)$/gm);

    expect(SRC_ENV_VARS.size).toBeGreaterThan(0);
    expect(documented.sort()).toEqual(Array.from(SRC_ENV_VARS).sort());
    for (const line of section.split("\n").filter((l) => l.startsWith("- `CODEX_MCP_"))) {
      expect(line, `no default stated: ${line}`).toMatch(/default/i);
    }
  });

  it("points at the state-directory variable where the delegation guide names the path", () => {
    const guide = present(docs.get(RESOURCE_URIS.delegationGuide), "the delegation guide resource");
    const stateDirLine = present(
      guide.match(/^- Persisted session data .+$/m),
      "the persisted-session-data line of the delegation guide"
    )[0];

    expect(SRC_ENV_VARS.has("CODEX_MCP_STATE_DIR")).toBe(true);
    expect(stateDirLine).toContain("`CODEX_MCP_STATE_DIR`");
  });

  it("describes `codex` required and optional parameters as the schema declares them", () => {
    const configText = present(docs.get(RESOURCE_URIS.config), "the config resource");
    const codexTool = present(tools.get("codex"), "the codex tool");
    const codexSchema = present(codexTool.inputSchema, "the codex input schema");
    const required = codexSchema.required ?? [];
    const optional = Object.keys(codexSchema.properties ?? {}).filter(
      (key) => !required.includes(key)
    );

    const requiredLine = present(
      configText.match(/^- Required: (.+)$/m),
      "the required-parameter line of the config guide"
    )[1];
    const optionalLine = present(
      configText.match(/^- Optional: (.+)$/m),
      "the optional-parameter line of the config guide"
    )[1];

    for (const key of required) {
      expect(requiredLine, `required param missing from config guide: ${key}`).toContain(
        `\`${key}\``
      );
    }
    for (const key of optional) {
      expect(optionalLine, `optional param missing from config guide: ${key}`).toContain(
        `\`${key}\``
      );
      expect(requiredLine, `optional param listed as required: ${key}`).not.toContain(`\`${key}\``);
    }
  });

  it("names only real `advanced.*` fields", () => {
    const codexTool = present(tools.get("codex"), "the codex tool");
    const codexSchema = present(codexTool.inputSchema, "the codex input schema");
    const codexProperties = present(codexSchema.properties, "the codex input schema properties");
    const advancedProps = Object.keys(codexProperties.advanced.properties ?? {});
    const mentioned = collectMatches(allText, /advanced\.([A-Za-z]+)/g);

    expect(mentioned.length).toBeGreaterThan(0);
    expect(mentioned.filter((key) => !advancedProps.includes(key))).toEqual([]);
  });

  it("uses only actions that codex_check and codex_session accept", () => {
    const checkTool = present(tools.get("codex_check"), "the codex_check tool");
    const checkSchema = present(checkTool.inputSchema, "the codex_check input schema");
    const checkProperties = present(
      checkSchema.properties,
      "the codex_check input schema properties"
    );
    const sessionTool = present(tools.get("codex_session"), "the codex_session tool");
    const sessionSchema = present(sessionTool.inputSchema, "the codex_session input schema");
    const sessionProperties = present(
      sessionSchema.properties,
      "the codex_session input schema properties"
    );
    const checkActions = checkProperties.action.enum ?? [];
    const sessionActions = sessionProperties.action.enum ?? [];

    const usedCheckActions = [
      ...collectMatches(allText, /codex_check\(action="([a-z_]+)"\)/g),
      ...collectMatches(allText, /"action": "([a-z_]+)"/g),
    ];
    const usedSessionActions = collectMatches(allText, /codex_session\(action="([a-z_]+)"\)/g);

    expect(usedCheckActions.length).toBeGreaterThan(0);
    expect(usedSessionActions.length).toBeGreaterThan(0);
    expect(usedCheckActions.filter((a) => !checkActions.includes(a))).toEqual([]);
    expect(usedSessionActions.filter((a) => !sessionActions.includes(a))).toEqual([]);
  });

  it("keeps the `codex_reply` override list in step with its schema", () => {
    const configText = present(docs.get(RESOURCE_URIS.config), "the config resource");
    const replyTool = present(tools.get("codex_reply"), "the codex_reply tool");
    const replySchema = present(replyTool.inputSchema, "the codex_reply input schema");
    const replyProps = Object.keys(replySchema.properties ?? {});
    const overrideLine = present(
      configText.match(/^- `codex_reply` can override (.+)$/m),
      "the codex_reply override line of the config guide"
    )[1];
    const claimed = collectMatches(overrideLine, /`([A-Za-z]+)`/g);

    expect(claimed.length).toBeGreaterThan(0);
    expect(claimed.filter((key) => !replyProps.includes(key))).toEqual([]);
  });

  it("places outputSchema where the schemas actually put it", () => {
    const configText = present(docs.get(RESOURCE_URIS.config), "the config resource");
    const codexTool = present(tools.get("codex"), "the codex tool");
    const codexSchema = present(codexTool.inputSchema, "the codex input schema");
    const codexSchemaProperties = present(
      codexSchema.properties,
      "the codex input schema properties"
    );
    const replyTool = present(tools.get("codex_reply"), "the codex_reply tool");
    const replySchema = present(replyTool.inputSchema, "the codex_reply input schema");
    const codexProps = Object.keys(codexSchema.properties ?? {});
    const codexAdvancedProps = Object.keys(codexSchemaProperties.advanced.properties ?? {});
    const replyProps = Object.keys(replySchema.properties ?? {});

    expect(configText).toContain(
      "`codex_reply.outputSchema` is top-level; `codex` takes the same schema as `advanced.outputSchema`."
    );
    expect(replyProps).toContain("outputSchema");
    expect(codexProps).not.toContain("outputSchema");
    expect(codexAdvancedProps).toContain("outputSchema");
  });

  it("covers every approval policy and sandbox mode in the delegation guide", () => {
    const guide = present(docs.get(RESOURCE_URIS.delegationGuide), "the delegation guide resource");

    for (const policy of APPROVAL_POLICIES) {
      expect(guide, `approval policy undocumented: ${policy}`).toContain(`\`${policy}\``);
    }
    for (const sandbox of SANDBOX_MODES) {
      expect(guide, `sandbox mode undocumented: ${sandbox}`).toContain(`\`${sandbox}\``);
    }
  });

  it("names under 'Effort selection' every effort level Codex advertises, and no other", () => {
    const guide = present(docs.get(RESOURCE_URIS.delegationGuide), "the delegation guide resource");
    const section = guide.split("## Effort selection")[1].split("\n##")[0];
    // `minimal` is named there by the web_search retry note, not as a level to pick.
    const named = collectMatches(section, /`([a-z]+)`/g).filter((level) => level !== "minimal");

    for (const level of ADVERTISED_EFFORT_LEVELS) {
      expect(section, `effort level undocumented: ${level}`).toContain(`\`${level}\``);
    }
    expect(named, "first mentions run out of advertised order").toEqual([
      ...ADVERTISED_EFFORT_LEVELS,
    ]);
    expect(section).toContain(`names no effort runs at ${DEFAULT_EFFORT_LEVEL}`);
  });

  it("names the effort level a rejected minimal turn is actually retried at", async () => {
    const guide = present(docs.get(RESOURCE_URIS.delegationGuide), "the delegation guide resource");
    const section = guide.split("## Effort selection")[1].split("\n##")[0];
    const client = new StubCodexClient();
    client.rejectMinimalEffort = true;
    const manager = new SessionManager({
      disableCleanup: true,
      createClient: () => client as never,
    });

    try {
      const started = await manager.createSession("hi", process.cwd(), {}, "minimal");
      const efforts = client.turnStartCalls.map((call) => call.effort);

      expect(efforts[0]).toBe("minimal");
      expect(efforts).toHaveLength(2);
      expect(section).toContain(`retries that turn at \`${efforts[1]}\``);
      expect(started.compatWarnings?.length).toBeGreaterThan(0);
      expect(section).toContain("`compatWarnings`");
    } finally {
      manager.destroy();
    }
  });

  it("reports disk flags the recovered-session behavior backs up", async () => {
    // The flag follows the adapter the server was built with, so the report is read off a
    // server that claimed a state directory.
    const withDisk = await openServer({
      disableCleanup: true,
      persistence: {} as never,
    });
    const withDiskReport = present(
      withDisk.docs.get(RESOURCE_URIS.compatReport),
      "the compat-report resource of the disk-backed server"
    );
    const compat = JSON.parse(withDiskReport) as {
      features: Record<string, boolean>;
      featureNotes: Record<string, string>;
      runtimeWarnings: string[];
    };
    await withDisk.server.close();
    const now = new Date().toISOString();
    const manager = new SessionManager({
      disableCleanup: true,
      createClient: () => new StubCodexClient() as never,
    });

    try {
      manager.ingestRecovered([
        {
          sessionId: "sess_recovered",
          meta: {
            schemaVersion: 1,
            sessionId: "sess_recovered",
            status: "running",
            createdAt: now,
            lastActiveAt: now,
            threadId: "thread_old",
            cwd: process.cwd(),
          },
          events: [],
          lastSeq: -1,
          result: null,
          pidInfo: null,
          owner: { kind: "unowned" },
          sessionDir: join(process.cwd(), "does-not-exist"),
        },
      ]);
      const recovered = manager.getSession("sess_recovered");

      // The session came back as work that was cut off, not as a failure.
      expect(compat.features.diskPersistence).toBe(true);
      expect(compat.featureNotes.diskPersistence).toContain("every server sharing the directory");
      expect(compat.runtimeWarnings).toEqual([]);
      expect(manager.listSessions().map((s) => s.sessionId)).toContain("sess_recovered");
      expect(recovered.status).toBe("abandoned");
      expect(compat.featureNotes.diskResume).toContain(`status \`${recovered.status}\``);

      // It cannot take another turn until it is resumed: no codex process stands behind it.
      const replied = manager.replyToSession("sess_recovered", "carry on");
      await expect(replied).rejects.toThrow(ErrorCode.SESSION_NOT_RUNNING);
      expect(compat.features.diskResume).toBe(true);
      expect(compat.featureNotes.diskResume).toContain(ErrorCode.SESSION_NOT_RUNNING);
    } finally {
      manager.destroy();
    }
  });

  it("denies disk persistence when the server holds no state directory", () => {
    const compatReport = present(
      docs.get(RESOURCE_URIS.compatReport),
      "the compat-report resource"
    );
    const compat = JSON.parse(compatReport) as {
      features: Record<string, boolean>;
      featureNotes: Record<string, string>;
    };

    expect(compat.features.diskPersistence).toBe(false);
    expect(compat.featureNotes.diskPersistence).toContain("memory only");
    expect(compat.featureNotes.diskPersistence).toContain("restart drops their history");
  });

  it("names the round the driver polls in, and the server's own ceiling", () => {
    const guide = present(docs.get(RESOURCE_URIS.delegationGuide), "the delegation guide resource");

    expect(guide).toContain('codex_check(action="poll", waitMs=300000)');
    expect(guide).toContain("progress.activity");
    expect(guide).toContain(String(MAX_LONG_POLL_WAIT_MS));
  });

  it("tells a caller whose progress notifications reach nobody to write the activity out", () => {
    const gotchas = present(docs.get(RESOURCE_URIS.gotchas), "the gotchas resource");

    expect(gotchas).toContain("A caller nobody can see");
    expect(gotchas).toContain("`progress.activity`");
    expect(gotchas).toContain("`waitMs: 300000`");
  });

  it("states cleanup windows as whole minutes derived from the cleanup constants", () => {
    const gotchas = present(docs.get(RESOURCE_URIS.gotchas), "the gotchas resource");

    expect(gotchas).toContain(
      `Idle sessions are auto-cleaned after ${DEFAULT_IDLE_CLEANUP_MS / 60_000} minutes`
    );
    expect(gotchas).toContain(
      `Running/waiting sessions are auto-cleaned after ${DEFAULT_RUNNING_CLEANUP_MS / 60_000} minutes`
    );
    expect(gotchas).toContain(`retained for about ${DEFAULT_TERMINAL_CLEANUP_MS / 60_000} minutes`);
  });

  it("resolves every documented field path in a tool schema or in the codex-schema bundle", () => {
    /** Subschemas of the served tool schemas, keyed by the tool and by the property that opens them. */
    const byRoot = new Map<string, unknown[]>();
    const register = (key: string, node: unknown): void => {
      byRoot.set(key, [...(byRoot.get(key) ?? []), node]);
    };
    const walk = (node: unknown): void => {
      for (const branch of branchesOf(node)) {
        const properties = branch.properties as SchemaNode | undefined;
        if (!properties) continue;
        for (const [name, child] of Object.entries(properties)) {
          register(name, child);
          walk(child);
        }
      }
    };
    for (const [name, tool] of tools) {
      register(name, tool.inputSchema);
      register(name, tool.outputSchema);
      walk(tool.inputSchema);
      walk(tool.outputSchema);
    }

    const viaProtocol: string[] = [];
    const unresolved: string[] = [];
    const paths = documentedFieldPaths(allText);
    for (const path of paths) {
      const roots = byRoot.get(path[0]) ?? [];
      if (roots.some((root) => resolvesInSchema(root, path.slice(1)))) continue;
      if (resolvesInProtocol(path)) viaProtocol.push(path.join("."));
      else unresolved.push(path.join("."));
    }

    expect(paths.length).toBeGreaterThan(20);
    expect(
      unresolved,
      "documented field paths that neither a tool schema nor codex-schema defines"
    ).toEqual([]);
    // The bundle has to be a live side of the comparison: the documents describe backend
    // messages, and a claim about one must fail here once the schema stops carrying it.
    expect(
      viaProtocol.length,
      "no documented path was checked against codex-schema"
    ).toBeGreaterThan(0);
  });

  it("leaves an app-server turn no text field to promise", async () => {
    const client = new StubCodexClient();
    const manager = new SessionManager({
      disableCleanup: true,
      createClient: () => client as never,
    });

    try {
      const { sessionId } = await manager.createSession("hi", process.cwd(), {}, "low");
      client.notifyManager(Methods.ITEM_COMPLETED, {
        threadId: "thread_stub",
        turnId: "turn_stub",
        item: { id: "item_1", type: "agentMessage", text: "the answer" },
      });
      // `turn/completed` carrying a Turn exactly as codex-schema defines it: no text field.
      client.notifyManager(Methods.TURN_COMPLETED, {
        turn: { id: "turn_stub", items: [], status: "completed" },
      });
      const result = present(manager.getLastResult(sessionId), "the last result of the session");
      const turnMessage = present(
        PROTOCOL_MESSAGES.get("turn"),
        "the Turn message of codex-schema"
      );

      expect(turnMessage.has("output")).toBe(false);
      expect(result.text).toBe("the answer");
      expect(docs.get(RESOURCE_URIS.gotchas)).toContain(
        "The app-server `Turn` carries no text field"
      );
    } finally {
      manager.destroy();
    }
  });

  it("promises `progress` on exactly the tools whose output schema carries it", () => {
    const configText = present(docs.get(RESOURCE_URIS.config), "the config resource");
    const progressLine = present(
      configText.match(/^- `progress` is included on (.+)$/m),
      "the progress line of the config guide"
    )[1];
    const claimed = collectMatches(progressLine, /`([a-z_]+)`/g);
    const declaring = Array.from(tools)
      .filter(([, tool]) => Boolean(tool.outputSchema?.properties?.progress))
      .map(([name]) => name);

    expect(claimed.sort()).toEqual(declaring.sort());
  });

  it("answers approvals with a decision both the tool and the backend accept", () => {
    const response = readSchemaFile("CommandExecutionRequestApprovalResponse.json");
    const variants = (
      (response.definitions as SchemaNode).CommandExecutionApprovalDecision as {
        oneOf: SchemaNode[];
      }
    ).oneOf;
    const backend = variants.flatMap((variant) =>
      Array.isArray(variant.enum)
        ? (variant.enum as string[])
        : Object.keys((variant.properties ?? {}) as SchemaNode)
    );
    const checkTool = present(tools.get("codex_check"), "the codex_check tool");
    const checkSchema = present(checkTool.inputSchema, "the codex_check input schema");
    const checkProperties = present(
      checkSchema.properties,
      "the codex_check input schema properties"
    );
    const toolDecisions = (checkProperties.decision.enum ?? []) as string[];
    const used = collectMatches(allText, /"decision": "([A-Za-z]+)"/g);

    expect(used.length).toBeGreaterThan(0);
    for (const decision of used) {
      expect(toolDecisions, `codex_check rejects decision ${decision}`).toContain(decision);
      expect(backend, `codex-schema has no approval decision ${decision}`).toContain(decision);
    }
  });

  it("shapes the user-input example the way the backend takes an answer", () => {
    const answerShape = (
      readSchemaFile("ToolRequestUserInputResponse.json").definitions as {
        ToolRequestUserInputAnswer: { required: string[] };
      }
    ).ToolRequestUserInputAnswer;
    const quickstart = present(docs.get(RESOURCE_URIS.quickstart), "the quickstart resource");
    const example = present(
      jsonExamples(quickstart).find((block) => block.action === "respond_user_input"),
      "the respond_user_input example of the quickstart"
    );
    const answers = Object.values(example.answers as Record<string, SchemaNode>);

    expect(answers.length).toBeGreaterThan(0);
    for (const answer of answers) expect(Object.keys(answer)).toEqual(answerShape.required);
  });

  it("names the Codex CLI floor in the gotchas resource", () => {
    const gotchas = present(docs.get(RESOURCE_URIS.gotchas), "the gotchas resource");

    expect(gotchas).toContain(MIN_CODEX_CLI_VERSION);
    expect(gotchas).toContain("codex app-server");
  });
});

describe("runtime metadata in server-info and compat-report", () => {
  function register(deps: {
    version?: string;
    activeSessions?: () => number;
    codexDefaultModel?: string | null;
    diskPersistence?: boolean;
    sessionDefaults?: SessionDefaults;
  }) {
    const reads = new Map<string, () => { contents: Array<{ text: string; mimeType: string }> }>();
    registerResources(
      {
        registerResource: (
          _name: string,
          uri: string,
          _config: unknown,
          read: () => { contents: Array<{ text: string; mimeType: string }> }
        ) => {
          reads.set(uri, read);
          return {};
        },
      } as never,
      {
        version: deps.version ?? "0.0.0-test",
        diskPersistence: deps.diskPersistence ?? true,
        sessionDefaults: deps.sessionDefaults ?? {
          effort: DEFAULT_EFFORT_LEVEL,
          approvalTimeoutMs: DEFAULT_APPROVAL_TIMEOUT_MS,
        },
        sessionManager: {
          getActiveSessionCount: deps.activeSessions ?? (() => 0),
          getCodexDefaultModel: () => deps.codexDefaultModel ?? null,
        },
      }
    );
    return {
      json: (uri: string) => {
        const read = present(reads.get(uri), `the registered read of ${uri}`);
        return JSON.parse(read().contents[0].text) as Record<string, never>;
      },
      text: (uri: string) => {
        const read = present(reads.get(uri), `the registered read of ${uri}`);
        return read().contents[0].text;
      },
    };
  }

  it("asks the resolved codex executable for its version once and reuses the answer", () => {
    const resources = register({});

    const first = resources.json(RESOURCE_URIS.serverInfo).codexCliVersion;
    const second = resources.json(RESOURCE_URIS.serverInfo).codexCliVersion;
    const inCompat = present(
      resources.json(RESOURCE_URIS.compatReport).runtime as never as
        | { codexCliVersion: string }
        | undefined,
      "the runtime block of the compat report"
    ).codexCliVersion;

    expect(first).toBe("0.150.1");
    expect(second).toBe("0.150.1");
    expect(inCompat).toBe("0.150.1");
    expect(spawnState.calls).toHaveLength(1);
    expect(spawnState.calls[0].args).toEqual(["--version"]);
    expect(spawnState.calls[0].command.length).toBeGreaterThan(0);
  });

  it("strips a leading v and keeps prerelease suffixes", () => {
    spawnState.impl = () => ({ status: 0, stdout: "", stderr: "codex-cli v1.2.3-alpha.1\n" });

    expect(register({}).json(RESOURCE_URIS.serverInfo).codexCliVersion).toBe("1.2.3-alpha.1");
  });

  it("reports no version when the CLI output carries no version number", () => {
    spawnState.impl = () => ({ status: 0, stdout: "unknown-build (dev)\n", stderr: "" });

    expect(register({}).json(RESOURCE_URIS.serverInfo).codexCliVersion).toBeNull();
  });

  it("reports no version when the CLI rejects --version instead of answering it", () => {
    // A codex build without `--version` prints its usage error and exits non-zero; the first
    // word of that message is not a version, and a caller must see the detection failure.
    spawnState.impl = () => ({
      status: 1,
      stdout: "",
      stderr: "error: unrecognized subcommand '--version'\n",
    });
    const resources = register({});

    expect(resources.json(RESOURCE_URIS.serverInfo).codexCliVersion).toBeNull();
    expect(resources.json(RESOURCE_URIS.compatReport).runtimeWarnings).toContain(
      "Unable to detect local codex CLI version from PATH."
    );
  });

  it("reports no version when the probe was killed before it finished answering", () => {
    // A spawnSync that hits its timeout kills the child: it reports the error, leaves status
    // null, and hands back whatever the process had written by then.
    spawnState.impl = () => ({
      status: null,
      stdout: "codex-cli 9.9.9 (parti",
      stderr: "",
      error: new Error("spawnSync codex ETIMEDOUT"),
    });

    expect(register({}).json(RESOURCE_URIS.serverInfo).codexCliVersion).toBeNull();
  });

  it("reports no version and warns in the compat report when the CLI prints nothing", () => {
    spawnState.impl = () => ({ status: 0, stdout: undefined, stderr: undefined });
    const resources = register({});

    expect(resources.json(RESOURCE_URIS.serverInfo).codexCliVersion).toBeNull();
    expect(resources.json(RESOURCE_URIS.compatReport).runtimeWarnings).toEqual([
      "Unable to detect local codex CLI version from PATH.",
    ]);
  });

  it("reports no version when spawning the CLI throws", () => {
    spawnState.impl = () => {
      throw new Error("ENOENT: codex not found");
    };

    expect(register({}).json(RESOURCE_URIS.serverInfo).codexCliVersion).toBeNull();
  });

  it("names the Codex CLI floor in server-info", () => {
    expect(register({}).json(RESOURCE_URIS.serverInfo).minCodexCliVersion).toBe(
      MIN_CODEX_CLI_VERSION
    );
  });

  it("warns in the compat report when the detected CLI is below the floor", () => {
    spawnState.impl = () => ({ status: 0, stdout: "codex-cli 0.100.0", stderr: "" });

    expect(register({}).json(RESOURCE_URIS.compatReport).runtimeWarnings).toContain(
      "Codex CLI 0.100.0 is below the 0.101.0 this server needs: it carries no `codex app-server`, so no session starts. Upgrade the CLI."
    );
  });

  it("mirrors the persistence state it was given in flag, note and warning", () => {
    const off = register({ diskPersistence: false }).json(RESOURCE_URIS.compatReport) as never as {
      features: { diskPersistence: boolean };
      featureNotes: { diskPersistence: string };
      runtimeWarnings: string[];
    };
    const on = register({ diskPersistence: true }).json(RESOURCE_URIS.compatReport) as never as {
      features: { diskPersistence: boolean };
      featureNotes: { diskPersistence: string };
      runtimeWarnings: string[];
    };

    expect(off.features.diskPersistence).toBe(false);
    expect(off.featureNotes.diskPersistence).toContain("memory only");
    expect(off.featureNotes.diskPersistence).toContain("restart drops their history");
    expect(off.runtimeWarnings).toContain(
      "Disk persistence is off: sessions are held in memory only and are lost when the server restarts."
    );
    expect(on.features.diskPersistence).toBe(true);
    expect(on.featureNotes.diskPersistence).toContain("every server sharing the directory");
    expect(on.runtimeWarnings).toEqual([]);
  });

  it("reports the default model Codex answered with, and null until one has", () => {
    const withoutModel = register({ codexDefaultModel: null }).json(RESOURCE_URIS.serverInfo);
    const withModel = register({ codexDefaultModel: "gpt-5-codex" }).json(RESOURCE_URIS.serverInfo);

    expect(withoutModel.defaultModel).toBeNull();
    expect(withModel.defaultModel).toBe("gpt-5-codex");
    // One source, so nothing names it: null is what unknown looks like.
    expect(withModel).not.toHaveProperty("defaultModelSource");
  });

  it("re-reads the live session count on every read", () => {
    let count = 0;
    const resources = register({ activeSessions: () => count });

    expect(resources.json(RESOURCE_URIS.serverInfo).activeSessions).toBe(0);
    count = 4;
    expect(resources.json(RESOURCE_URIS.serverInfo).activeSessions).toBe(4);
    expect(
      (resources.json(RESOURCE_URIS.compatReport).runtime as never as { activeSessions: number })
        .activeSessions
    ).toBe(4);
  });

  it("carries the server version into both metadata documents", () => {
    const resources = register({ version: "7.7.7-test" });

    expect(resources.json(RESOURCE_URIS.serverInfo).version).toBe("7.7.7-test");
    expect(
      (resources.json(RESOURCE_URIS.compatReport).runtime as never as { codexMcpVersion: string })
        .codexMcpVersion
    ).toBe("7.7.7-test");
  });
  it("names the permission level a call that states none starts on, and says when there is none", () => {
    const configured = register({
      sessionDefaults: {
        effort: DEFAULT_EFFORT_LEVEL,
        approvalTimeoutMs: DEFAULT_APPROVAL_TIMEOUT_MS,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      },
    }).text(RESOURCE_URIS.delegationGuide);

    expect(configured).toContain(
      "A call that names neither starts on `never` with `danger-full-access`"
    );

    expect(register({}).text(RESOURCE_URIS.delegationGuide)).toContain(
      "A call states its own approval policy and sandbox"
    );
  });
});
