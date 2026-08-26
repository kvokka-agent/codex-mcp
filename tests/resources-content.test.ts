import { EventEmitter } from "node:events";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * `detectCodexCliVersion` shells out to `codex --version`; the stub keeps the suite off the
 * real CLI and lets each test choose what the binary answered.
 */
const spawnState = vi.hoisted(() => ({
  calls: [] as Array<{ command: string; args: string[] }>,
  impl: (() => ({ status: 0, stdout: "codex-cli 0.52.0", stderr: "" })) as (
    command: string,
    args: string[]
  ) => unknown,
}));

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
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
const { registerResources, RESOURCE_URIS } = await import("../src/resources/register-resources.js");
const { SessionManager } = await import("../src/session/manager.js");
const {
  APPROVAL_POLICIES,
  SANDBOX_MODES,
  EFFORT_LEVELS,
  DEFAULT_EFFORT_LEVEL,
  ErrorCode,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  POLL_DEFAULT_MAX_EVENTS,
  POLL_MIN_MAX_EVENTS,
  RESPOND_DEFAULT_MAX_EVENTS,
  DEFAULT_IDLE_CLEANUP_MS,
  DEFAULT_RUNNING_CLEANUP_MS,
  DEFAULT_TERMINAL_CLEANUP_MS,
} = await import("../src/types.js");

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

/** Minimal ICodexClient stand-in: SessionManager drives it, the tests read what it was asked. */
class StubCodexClient extends EventEmitter {
  destroyed = false;
  supportsTurnOverrides = true;
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
  onNotification(): void {}
  onServerRequest(): void {}
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

  const call = async <T>(method: string, params: Record<string, unknown>): Promise<T> =>
    (await handlers.get(method)!({ jsonrpc: "2.0", id: 1, method, params }, {})) as unknown as T;

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
    const info = JSON.parse(docs.get(RESOURCE_URIS.serverInfo)!) as {
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
    const compat = JSON.parse(docs.get(RESOURCE_URIS.compatReport)!) as {
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
    const errorsText = docs.get(RESOURCE_URIS.errors)!;
    const codesSection = errorsText.split("## Codes")[1]!.split("## Recovery basics")[0]!;
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
    const configText = docs.get(RESOURCE_URIS.config)!;
    const section = configText.split("## Environment variables")[1]!.split("\n## ")[0]!;
    const documented = collectMatches(section, /^- `(CODEX_MCP_[A-Z_]+)`: (.+)$/gm);

    expect(SRC_ENV_VARS.size).toBeGreaterThan(0);
    expect(documented.sort()).toEqual(Array.from(SRC_ENV_VARS).sort());
    for (const line of section.split("\n").filter((l) => l.startsWith("- `CODEX_MCP_"))) {
      expect(line, `no default stated: ${line}`).toMatch(/default/i);
    }
  });

  it("points at the state-directory variable where the delegation guide names the path", () => {
    const guide = docs.get(RESOURCE_URIS.delegationGuide)!;
    const stateDirLine = guide.match(/^- Persisted session data .+$/m)![0];

    expect(SRC_ENV_VARS.has("CODEX_MCP_STATE_DIR")).toBe(true);
    expect(stateDirLine).toContain("`CODEX_MCP_STATE_DIR`");
  });

  it("describes `codex` required and optional parameters as the schema declares them", () => {
    const configText = docs.get(RESOURCE_URIS.config)!;
    const codexSchema = tools.get("codex")!.inputSchema!;
    const required = codexSchema.required ?? [];
    const optional = Object.keys(codexSchema.properties ?? {}).filter(
      (key) => !required.includes(key)
    );

    const requiredLine = configText.match(/^- Required: (.+)$/m)![1];
    const optionalLine = configText.match(/^- Optional: (.+)$/m)![1];

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
    const advancedProps = Object.keys(
      tools.get("codex")!.inputSchema!.properties!.advanced.properties ?? {}
    );
    const mentioned = collectMatches(allText, /advanced\.([A-Za-z]+)/g);

    expect(mentioned.length).toBeGreaterThan(0);
    expect(mentioned.filter((key) => !advancedProps.includes(key))).toEqual([]);
  });

  it("names only real `pollOptions.*` fields", () => {
    const pollOptionProps = Object.keys(
      tools.get("codex_check")!.inputSchema!.properties!.pollOptions.properties ?? {}
    );
    const mentioned = collectMatches(allText, /pollOptions\.([A-Za-z]+)/g);

    expect(mentioned.length).toBeGreaterThan(0);
    expect(mentioned.filter((key) => !pollOptionProps.includes(key))).toEqual([]);
  });

  it("uses only actions that codex_check and codex_session accept", () => {
    const checkActions = tools.get("codex_check")!.inputSchema!.properties!.action.enum ?? [];
    const sessionActions = tools.get("codex_session")!.inputSchema!.properties!.action.enum ?? [];

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
    const configText = docs.get(RESOURCE_URIS.config)!;
    const replyProps = Object.keys(tools.get("codex_reply")!.inputSchema!.properties ?? {});
    const overrideLine = configText.match(/^- `codex_reply` can override (.+)$/m)![1];
    const claimed = collectMatches(overrideLine, /`([A-Za-z]+)`/g);

    expect(claimed.length).toBeGreaterThan(0);
    expect(claimed.filter((key) => !replyProps.includes(key))).toEqual([]);
  });

  it("places outputSchema where the schemas actually put it", () => {
    const configText = docs.get(RESOURCE_URIS.config)!;
    const codexProps = Object.keys(tools.get("codex")!.inputSchema!.properties ?? {});
    const codexAdvancedProps = Object.keys(
      tools.get("codex")!.inputSchema!.properties!.advanced.properties ?? {}
    );
    const replyProps = Object.keys(tools.get("codex_reply")!.inputSchema!.properties ?? {});

    expect(configText).toContain("`codex_reply.outputSchema` is top-level.");
    expect(replyProps).toContain("outputSchema");

    expect(configText).toContain("`codex.outputSchema` lives under `advanced.outputSchema`.");
    expect(codexProps).not.toContain("outputSchema");
    expect(codexAdvancedProps).toContain("outputSchema");
  });

  it("covers every approval policy and sandbox mode in the delegation guide", () => {
    const guide = docs.get(RESOURCE_URIS.delegationGuide)!;

    for (const policy of APPROVAL_POLICIES) {
      expect(guide, `approval policy undocumented: ${policy}`).toContain(`\`${policy}\``);
    }
    for (const sandbox of SANDBOX_MODES) {
      expect(guide, `sandbox mode undocumented: ${sandbox}`).toContain(`\`${sandbox}\``);
    }
  });

  it("names under 'Effort selection' every effort level the enum defines, and no other", () => {
    const guide = docs.get(RESOURCE_URIS.delegationGuide)!;
    const section = guide.split("## Effort selection")[1]!.split("\n##")[0]!;
    const named = collectMatches(section, /`([a-z]+)`/g);

    for (const level of EFFORT_LEVELS) {
      expect(section, `effort level undocumented: ${level}`).toContain(`\`${level}\``);
    }
    expect(named.filter((level) => !EFFORT_LEVELS.includes(level as never))).toEqual([]);
    expect(named, "first mentions run out of enum order").toEqual([...EFFORT_LEVELS]);
    expect(section).toContain(`\`${DEFAULT_EFFORT_LEVEL}\` (default)`);
  });

  it("names the effort level a rejected minimal turn is actually retried at", async () => {
    const guide = docs.get(RESOURCE_URIS.delegationGuide)!;
    const section = guide.split("## Effort selection")[1]!.split("\n##")[0]!;
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
    const compat = JSON.parse(withDisk.docs.get(RESOURCE_URIS.compatReport)!) as {
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
          sessionDir: join(process.cwd(), "does-not-exist"),
        },
      ]);
      const recovered = manager.getSession("sess_recovered");

      // The session survived the restart as history: it is listed and carries its restart reason.
      expect(compat.features.diskPersistence).toBe(true);
      expect(compat.featureNotes.diskPersistence).toContain("read back at startup");
      expect(compat.runtimeWarnings).toEqual([]);
      expect(manager.listSessions().map((s) => s.sessionId)).toContain("sess_recovered");
      expect(compat.featureNotes.diskResume).toContain(`status \`${recovered.status}\``);

      // It cannot take another turn: no codex process stands behind it.
      const replied = manager.replyToSession("sess_recovered", "carry on");
      await expect(replied).rejects.toThrow(ErrorCode.SESSION_NOT_FOUND);
      expect(compat.features.diskResume).toBe(false);
      expect(compat.featureNotes.diskResume).toContain(ErrorCode.SESSION_NOT_FOUND);
    } finally {
      manager.destroy();
    }
  });

  it("denies disk persistence when the server holds no state directory", () => {
    const compat = JSON.parse(docs.get(RESOURCE_URIS.compatReport)!) as {
      features: Record<string, boolean>;
      featureNotes: Record<string, string>;
    };

    expect(compat.features.diskPersistence).toBe(false);
    expect(compat.featureNotes.diskPersistence).toContain("memory only");
    expect(compat.featureNotes.diskPersistence).toContain("restart drops their history");
  });

  it("names the backend the server drives instead of assuming app-server", async () => {
    // No injected factory: SessionManager builds an AppServerClient, so the mode is known.
    expect(
      (JSON.parse(docs.get(RESOURCE_URIS.serverInfo)!) as { clientMode: string }).clientMode
    ).toBe("app-server");

    const injected = await openServer({
      disableCleanup: true,
      createClient: () => new StubCodexClient() as never,
    });
    const declared = await openServer({
      disableCleanup: true,
      clientMode: "exec",
      createClient: () => new StubCodexClient() as never,
    });

    try {
      // An injected factory can build any client; the server is not told which, so it says so.
      expect(
        (JSON.parse(injected.docs.get(RESOURCE_URIS.serverInfo)!) as { clientMode: string })
          .clientMode
      ).toBe("unknown");
      expect(
        (JSON.parse(declared.docs.get(RESOURCE_URIS.serverInfo)!) as { clientMode: string })
          .clientMode
      ).toBe("exec");
    } finally {
      await injected.server.close();
      await declared.server.close();
    }
  });

  it("documents every execution.fallbackReason the codex tool may answer with", () => {
    const guide = docs.get(RESOURCE_URIS.delegationGuide)!;
    const execution = tools.get("codex")!.outputSchema!.properties!.execution as {
      properties: { fallbackReason: { enum?: string[]; anyOf?: Array<{ enum?: string[] }> } };
    };
    const field = execution.properties.fallbackReason;
    const reasons = field.enum ?? field.anyOf?.flatMap((entry) => entry.enum ?? []) ?? [];

    expect(reasons.length).toBeGreaterThan(0);
    for (const reason of reasons) {
      expect(guide, `fallbackReason absent from the delegation guide: ${reason}`).toContain(
        `- \`${reason}\`:`
      );
    }
  });

  it("reports the approval-policy, sandbox and effort enums the server accepts", () => {
    const info = JSON.parse(docs.get(RESOURCE_URIS.serverInfo)!) as Record<string, unknown>;
    const codexSchema = tools.get("codex")!.inputSchema!;

    expect(info.supportedApprovalPolicies).toEqual([...APPROVAL_POLICIES]);
    expect(info.supportedSandboxModes).toEqual([...SANDBOX_MODES]);
    expect(info.supportedEffortLevels).toEqual([...EFFORT_LEVELS]);
    expect(codexSchema.properties!.approvalPolicy.enum).toEqual([...APPROVAL_POLICIES]);
    expect(codexSchema.properties!.sandbox.enum).toEqual([...SANDBOX_MODES]);
    expect(codexSchema.properties!.effort.enum).toEqual([...EFFORT_LEVELS]);
  });

  it("quotes the polling and approval defaults from the shared constants", () => {
    const gotchas = docs.get(RESOURCE_URIS.gotchas)!;
    const quickstart = docs.get(RESOURCE_URIS.quickstart)!;
    const configText = docs.get(RESOURCE_URIS.config)!;
    const guide = docs.get(RESOURCE_URIS.delegationGuide)!;

    expect(gotchas).toContain(`Poll default is \`maxEvents=${POLL_DEFAULT_MAX_EVENTS}\``);
    expect(gotchas).toContain(`Poll enforces minimum \`maxEvents=${POLL_MIN_MAX_EVENTS}\``);
    expect(gotchas).toContain(`\`maxEvents=${RESPOND_DEFAULT_MAX_EVENTS}\``);
    expect(gotchas).toContain(`(default ${DEFAULT_APPROVAL_TIMEOUT_MS} ms)`);
    expect(gotchas).toContain(`default approval timeout is ${DEFAULT_APPROVAL_TIMEOUT_MS / 1000}`);
    expect(quickstart).toContain(
      `defaults are poll=${POLL_DEFAULT_MAX_EVENTS}, respond_*=${RESPOND_DEFAULT_MAX_EVENTS}`
    );
    expect(configText).toContain(`(default \`${DEFAULT_APPROVAL_TIMEOUT_MS}\` ms)`);
    expect(configText).toContain(`default \`${POLL_DEFAULT_MAX_EVENTS}\``);
    expect(guide).toContain(`Default approval timeout is ${DEFAULT_APPROVAL_TIMEOUT_MS}ms`);
  });

  it("states cleanup windows as whole minutes derived from the cleanup constants", () => {
    const gotchas = docs.get(RESOURCE_URIS.gotchas)!;

    expect(gotchas).toContain(
      `Idle sessions are auto-cleaned after ${DEFAULT_IDLE_CLEANUP_MS / 60_000} minutes`
    );
    expect(gotchas).toContain(
      `Running/waiting sessions are auto-cleaned after ${DEFAULT_RUNNING_CLEANUP_MS / 60_000} minutes`
    );
    expect(gotchas).toContain(`retained for about ${DEFAULT_TERMINAL_CLEANUP_MS / 60_000} minutes`);
  });

  it("keeps the EXEC_NOT_SUPPORTED story consistent between gotchas and the error hints", () => {
    const gotchas = docs.get(RESOURCE_URIS.gotchas)!;
    const errorsText = docs.get(RESOURCE_URIS.errors)!;

    expect(gotchas).toContain(ErrorCode.EXEC_NOT_SUPPORTED);
    expect(gotchas).toContain("threadFork");
    const hint = errorsText.match(/^- `EXEC_NOT_SUPPORTED`: (.+)$/m)![1];
    expect(hint).toContain("threadFork");
    expect(hint).toContain("app-server");
  });
});

describe("runtime metadata in server-info and compat-report", () => {
  function register(deps: {
    version?: string;
    activeSessions?: () => number;
    observedModel?: string | null;
    clientMode?: string;
    diskPersistence?: boolean;
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
        clientMode: deps.clientMode ?? "app-server",
        diskPersistence: deps.diskPersistence ?? true,
        sessionManager: {
          getActiveSessionCount: deps.activeSessions ?? (() => 0),
          getObservedDefaultModel: () => deps.observedModel ?? null,
        },
      }
    );
    return {
      json: (uri: string) =>
        JSON.parse(reads.get(uri)!().contents[0].text) as Record<string, never>,
    };
  }

  it("asks the resolved codex executable for its version once and reuses the answer", () => {
    const resources = register({});

    const first = resources.json(RESOURCE_URIS.serverInfo).codexCliVersion;
    const second = resources.json(RESOURCE_URIS.serverInfo).codexCliVersion;
    const inCompat = (resources.json(RESOURCE_URIS.compatReport).runtime as never as
      | { codexCliVersion: string }
      | undefined)!.codexCliVersion;

    expect(first).toBe("0.52.0");
    expect(second).toBe("0.52.0");
    expect(inCompat).toBe("0.52.0");
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

  it("echoes the client mode it was given without inventing one", () => {
    expect(register({ clientMode: "exec" }).json(RESOURCE_URIS.serverInfo).clientMode).toBe("exec");
    expect(register({ clientMode: "unknown" }).json(RESOURCE_URIS.serverInfo).clientMode).toBe(
      "unknown"
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
    expect(off.runtimeWarnings).toContain(
      "Disk persistence is off: sessions are held in memory only and are lost when the server restarts."
    );
    expect(on.features.diskPersistence).toBe(true);
    expect(on.featureNotes.diskPersistence).toContain("read back at startup");
    expect(on.runtimeWarnings).toEqual([]);
  });

  it("marks the default model source unknown until a session reports one", () => {
    const withoutModel = register({ observedModel: null }).json(RESOURCE_URIS.serverInfo);
    const withModel = register({ observedModel: "gpt-5-codex" }).json(RESOURCE_URIS.serverInfo);

    expect(withoutModel.defaultModel).toBeNull();
    expect(withoutModel.defaultModelSource).toBe("unknown");
    expect(withModel.defaultModel).toBe("gpt-5-codex");
    expect(withModel.defaultModelSource).toBe("session-default");
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
});
