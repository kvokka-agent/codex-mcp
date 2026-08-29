/**
 * Conformance of src/app-server/protocol.ts with the vendored codex-schema bundle.
 *
 * Both sides of every assertion are read, not written here: method names and
 * parameter shapes come from codex-schema/*.json, and the TypeScript side comes
 * from the compiler's view of protocol.ts. Regenerating the bundle with a newer
 * `codex` CLI therefore fails this file wherever the model drifted.
 */

import { describe, expect, it, jest } from "bun:test";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import type { AppServerSpawnOptions } from "../src/app-server/lifecycle.js";
import { Methods } from "../src/app-server/protocol.js";
import { mockModule } from "./helpers/mock.js";

const spawnMock = jest.fn();

const realModule1 = { ...(await import("node:child_process")) };
mockModule("child_process", realModule1, () => {
  const actual = realModule1;
  return { ...actual, spawn: spawnMock };
});

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_DIR = resolve(REPO_ROOT, "codex-schema");
const PROTOCOL_PATH = resolve(REPO_ROOT, "src/app-server/protocol.ts");

/** The four bundle files that enumerate every method of the wire protocol. */
const ENVELOPE_FILES = [
  "ClientRequest.json",
  "ClientNotification.json",
  "ServerRequest.json",
  "ServerNotification.json",
] as const;

type JsonObject = Record<string, unknown>;

interface SchemaMethod {
  /** Envelope file the method was declared in. */
  file: string;
  method: string;
  /** Definition name the envelope points `params` at, if the method carries params. */
  paramsRef?: string;
  /** Doc text of the envelope variant; the bundle marks a gated method "EXPERIMENTAL". */
  description: string;
}

function readSchema(file: string): JsonObject {
  return JSON.parse(readFileSync(resolve(SCHEMA_DIR, file), "utf8")) as JsonObject;
}

function readEnvelope(file: string): { methods: SchemaMethod[]; definitions: JsonObject } {
  const doc = readSchema(file);
  const definitions = (doc.definitions ?? {}) as JsonObject;
  const variants = doc.oneOf as JsonObject[];
  const methods = variants.map((variant) => {
    const properties = variant.properties as JsonObject;
    const methodEnum = (properties.method as JsonObject).enum as string[];
    expect(methodEnum, `${file}: method enum must name exactly one method`).toHaveLength(1);
    const params = properties.params as { $ref?: string } | undefined;
    return {
      file,
      method: methodEnum[0],
      paramsRef: params?.$ref?.split("/").pop(),
      description: typeof variant.description === "string" ? variant.description : "",
    };
  });
  return { methods, definitions };
}

const ENVELOPES = ENVELOPE_FILES.map((file) => ({ file, ...readEnvelope(file) }));
const SCHEMA_METHODS = new Map<string, SchemaMethod>(
  ENVELOPES.flatMap((e) => e.methods).map((m) => [m.method, m])
);
const SERVER_TO_CLIENT_METHODS = ENVELOPES.filter(
  (e) => e.file === "ServerRequest.json" || e.file === "ServerNotification.json"
).flatMap((e) => e.methods.map((m) => m.method));

/**
 * Server → client methods this codebase does not model, each with the reason it
 * is not modelled. A method leaving this list without entering `Methods` fails
 * the reverse check below.
 *
 * Four of these are server → *requests*, which stall the turn if nothing
 * answers. `SessionManager.handleServerRequest` answers every method it does
 * not model with JSON-RPC -32601, so an unmodelled request is refused rather
 * than left hanging.
 */
const UNMODELED_SERVER_METHODS: Record<string, string> = {
  // Realtime audio threads.
  "thread/realtime/started": "realtime audio threads; codex-mcp starts text turns only",
  "thread/realtime/itemAdded": "realtime audio threads; codex-mcp starts text turns only",
  "thread/realtime/item/started": "realtime audio threads; codex-mcp starts text turns only",
  "thread/realtime/item/transcript/delta":
    "realtime audio threads; codex-mcp starts text turns only",
  "thread/realtime/item/completed": "realtime audio threads; codex-mcp starts text turns only",
  "thread/realtime/transcript/delta": "realtime audio threads; codex-mcp starts text turns only",
  "thread/realtime/transcript/done": "realtime audio threads; codex-mcp starts text turns only",
  "thread/realtime/outputAudio/delta": "realtime audio threads; codex-mcp starts text turns only",
  "thread/realtime/sdp": "realtime audio threads; codex-mcp starts text turns only",
  "thread/realtime/error": "realtime audio threads; codex-mcp starts text turns only",
  "thread/realtime/closed": "realtime audio threads; codex-mcp starts text turns only",

  // Server → client requests. Each is refused with -32601.
  "attestation/generate":
    "gated behind capabilities.requestAttestation, which initialize leaves at the schema default false; codex-mcp holds no attestation signer to answer with",
  "currentTime/read":
    "asks the client for a clock it owns; codex-mcp owns none, so the request is refused rather than answered with a manufactured time",
  "item/permissions/requestApproval":
    "sent only under a granular approval policy carrying request_permissions: true; codex-mcp sends a policy preset string and never the granular object",
  "mcpServer/elicitation/request":
    "an MCP server from the user's own codex config asking the end user a question; codex-mcp models the item/tool/requestUserInput question flow and not this one, so the elicitation is declined rather than answered",

  // Thread and project bookkeeping this server does not report.
  "thread/deleted": "codex-mcp exposes no thread browser; a session is addressed by its own id",
  "thread/reverted": "codex-mcp exposes no thread history view to revert in",
  "thread/goal/updated": "thread goals are a TUI affordance; codex-mcp reports turns",
  "thread/goal/cleared": "thread goals are a TUI affordance; codex-mcp reports turns",
  "thread/queue/changed":
    "the app-server's queued-input view; codex-mcp submits one turn at a time and reports its own session state",
  "thread/settings/updated":
    "echoes back settings the caller already passed to thread/start or turn/start",
  "thread/project/updated": "project assignment; codex-mcp never sets projectId",
  "project/changed": "project assignment; codex-mcp never sets projectId",
  "thread/environment/connected":
    "execution environments; codex-mcp never sets environments and runs every turn in the local cwd",
  "thread/environment/disconnected":
    "execution environments; codex-mcp never sets environments and runs every turn in the local cwd",
  "skills/changed": "an invalidation signal for skills/list, which codex-mcp never calls",
  "fs/changed": "answers an fs/watch subscription, which codex-mcp never opens",

  // Features this server never starts, so their streams never open.
  "command/exec/outputDelta": "streams a command/exec session, which codex-mcp never starts",
  "process/outputDelta": "streams a process/spawn session, which codex-mcp never starts",
  "process/exited": "ends a process/spawn session, which codex-mcp never starts",
  "externalAgentConfig/import/progress":
    "progress of an externalAgentConfig/import, which codex-mcp never starts",
  "externalAgentConfig/import/completed":
    "result of an externalAgentConfig/import, which codex-mcp never starts",
  "remoteControl/status/changed":
    "remote control of the app-server; codex-mcp drives the child it spawned over stdio",
  "mcpServer/startupStatus/updated":
    "startup status of MCP servers from the user's own codex config; codex-mcp configures none",
  "mcpServer/event/stream/notification":
    "forwards a notification from an MCP server subscription, which codex-mcp never opens",
  "mcpServer/oauthLogin/completed":
    "MCP server logins are configured in the codex CLI, not through this server",
  "serverRequest/resolved":
    "tells one client that another answered a shared server request; codex-mcp is the only client of the app-server it spawned",

  // The auto_review approvals reviewer, which codex-mcp never selects.
  "item/autoApprovalReview/started":
    "the auto_review approvals reviewer; codex-mcp leaves approvalsReviewer at the schema default user",
  "item/autoApprovalReview/completed":
    "the auto_review approvals reviewer; codex-mcp leaves approvalsReviewer at the schema default user",
  "autoApprovalReview/strictReviewRequired":
    "the auto_review approvals reviewer; codex-mcp leaves approvalsReviewer at the schema default user",

  // Advisory payloads with no field in this server's tool output.
  "model/verification": "model-side verification metadata; codex-mcp reports the turn's answer",
  "turn/moderationMetadata": "moderation metadata for a UI; codex-mcp reports the turn's answer",
  "item/fileChange/patchUpdated":
    "an updated patch preview for a file-change item; codex-mcp answers the approval from the request params and reports the item off item/completed",

  // Account and catalogue state owned by the codex CLI.
  "account/updated": "account management is done in the codex CLI, not through this server",
  "account/rateLimits/updated":
    "account management is done in the codex CLI, not through this server",
  "app/list/updated": "ChatGPT app catalogue; codex-mcp exposes no app picker",
  "windowsSandbox/setupCompleted":
    "answers the windowsSandbox/setupStart request, which this server never sends",
};

// ── TypeScript side ────────────────────────────────────────────────

interface TsInterface {
  /** Property name → whether the declaration marks it optional. */
  properties: Map<string, boolean>;
  type: ts.Type;
}

function loadProtocolInterfaces(): {
  checker: ts.TypeChecker;
  interfaces: Map<string, TsInterface>;
} {
  const program = ts.createProgram([PROTOCOL_PATH], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    skipLibCheck: true,
  });
  const checker = program.getTypeChecker();
  const sourceFile = program.getSourceFile(PROTOCOL_PATH);
  expect(sourceFile, `${PROTOCOL_PATH} must be loadable by the TypeScript compiler`).toBeDefined();
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile as ts.SourceFile);
  expect(moduleSymbol, "protocol.ts must be a module with exports").toBeDefined();

  const interfaces = new Map<string, TsInterface>();
  for (const exported of checker.getExportsOfModule(moduleSymbol as ts.Symbol)) {
    const symbol =
      exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
    if (!(symbol.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias))) continue;
    const type = checker.getDeclaredTypeOfSymbol(symbol);
    const properties = new Map<string, boolean>();
    for (const prop of checker.getPropertiesOfType(type)) {
      properties.set(prop.getName(), Boolean(prop.flags & ts.SymbolFlags.Optional));
    }
    interfaces.set(exported.getName(), { properties, type });
  }
  return { checker, interfaces };
}

const { checker, interfaces: TS_INTERFACES } = loadProtocolInterfaces();

/**
 * Schema definition name → protocol.ts type that models it.
 * Only the pairs this codebase actually sends or receives are listed; the wiring
 * is the mapping, while every field compared below is read from either side.
 */
const MODELLED_TYPES: Record<string, string> = {
  InitializeParams: "InitializeParams",
  ThreadStartParams: "ThreadStartParams",
  ThreadResumeParams: "ThreadResumeParams",
  ThreadForkParams: "ThreadForkParams",
  ThreadBackgroundTerminalsCleanParams: "ThreadBackgroundTerminalsCleanParams",
  ThreadBackgroundTerminalsListParams: "ThreadBackgroundTerminalsListParams",
  ThreadBackgroundTerminalsTerminateParams: "ThreadBackgroundTerminalsTerminateParams",
  ThreadDeleteParams: "ThreadDeleteParams",
  TurnStartParams: "TurnStartParams",
  TurnSteerParams: "TurnSteerParams",
  TurnInterruptParams: "TurnInterruptParams",
  CommandExecutionRequestApprovalParams: "CommandApprovalParams",
  FileChangeRequestApprovalParams: "FileChangeApprovalParams",
  ToolRequestUserInputParams: "UserInputRequestParams",
  DynamicToolCallParams: "DynamicToolCallParams",
  ChatgptAuthTokensRefreshParams: "ChatgptAuthTokensRefreshParams",
  ErrorNotification: "ErrorNotificationParams",
  ThreadStatusChangedNotification: "ThreadStatusChangedNotificationParams",
  ThreadClosedNotification: "ThreadStateNotificationParams",
  ThreadArchivedNotification: "ThreadStateNotificationParams",
  ThreadUnarchivedNotification: "ThreadStateNotificationParams",
  ThreadNameUpdatedNotification: "ThreadNameUpdatedNotificationParams",
  ContextCompactedNotification: "ContextCompactedNotificationParams",
  DeprecationNoticeNotification: "DeprecationNoticeNotificationParams",
  ConfigWarningNotification: "ConfigWarningNotificationParams",
  ItemStartedNotification: "ItemStartedNotificationParams",
  ItemCompletedNotification: "ItemCompletedNotificationParams",
  AgentMessageDeltaNotification: "DeltaNotificationParams",
  PlanDeltaNotification: "DeltaNotificationParams",
  CommandExecutionOutputDeltaNotification: "DeltaNotificationParams",
  FileChangeOutputDeltaNotification: "DeltaNotificationParams",
  ReasoningTextDeltaNotification: "ReasoningDeltaParams",
  TurnStartedNotification: "TurnNotificationParams",
  TurnCompletedNotification: "TurnNotificationParams",
  WarningNotification: "WarningNotificationParams",
  GuardianWarningNotification: "GuardianWarningNotificationParams",
  ModelSafetyBufferingUpdatedNotification: "ModelSafetyBufferingUpdatedNotificationParams",
  HookStartedNotification: "HookNotificationParams",
  HookCompletedNotification: "HookNotificationParams",
  HookRunSummary: "HookRunSummary",
  HookOutputEntry: "HookOutputEntry",
};

/**
 * Methods whose params protocol.ts leaves as `unknown`: the session manager reads
 * a handful of fields off them and never constructs one, so a named type would
 * only restate the schema.
 */
const PARAMS_LEFT_UNTYPED = [
  "applyPatchApproval",
  "execCommandApproval",
  "thread/started",
  "thread/tokenUsage/updated",
  "turn/diff/updated",
  "turn/plan/updated",
  "item/commandExecution/terminalInteraction",
  "item/mcpToolCall/progress",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded",
  "model/rerouted",
  "fuzzyFileSearch/sessionUpdated",
  "fuzzyFileSearch/sessionCompleted",
  "windows/worldWritableWarning",
  "account/login/completed",
];

function findDefinition(name: string): JsonObject {
  for (const envelope of ENVELOPES) {
    const found = envelope.definitions[name];
    if (found) return found as JsonObject;
  }
  throw new Error(`definition ${name} is in no codex-schema envelope file`);
}

/**
 * protocol.ts result type → the bundle file whose root object is that response.
 * The bundle binds no response to a method name, so the pairing is the wiring;
 * every field compared below is read from one side or the other.
 *
 * A response is read and never constructed, so protocol.ts models only what a
 * caller uses: field existence is checked one way, every field protocol.ts
 * declares against the schema, at every level.
 *
 * The three thread responses declare more than the id because a session reports
 * the settings it runs with, and those are what Codex answered rather than what
 * the call asked for. They share one type, `ThreadSettingsResult`: the schema
 * gives the three files the same required block, so a field that drifts in one
 * of them fails here for all three.
 */
const MODELLED_RESULTS: Record<string, string> = {
  InitializeResult: "v1/InitializeResponse.json",
  ThreadStartResult: "v2/ThreadStartResponse.json",
  ThreadForkResult: "v2/ThreadForkResponse.json",
  ThreadResumeResult: "v2/ThreadResumeResponse.json",
  TurnStartResult: "v2/TurnStartResponse.json",
  ThreadBackgroundTerminalsListResult: "v2/ThreadBackgroundTerminalsListResponse.json",
  ThreadBackgroundTerminalsTerminateResult: "v2/ThreadBackgroundTerminalsTerminateResponse.json",
};

/**
 * Methods the schema gates behind `capabilities.experimentalApi` and this
 * codebase nevertheless serves end to end, which is why the client opts in.
 */
const EXPERIMENTAL_METHODS_IN_USE = [Methods.USER_INPUT_REQUEST, Methods.PLAN_DELTA];

/** Follow `$ref` inside one bundle file and drop the `null` branch of an `anyOf`. */
function resolveNode(node: JsonObject, doc: JsonObject): JsonObject {
  let current = node;
  for (let hop = 0; hop < 16; hop++) {
    const ref = current.$ref as string | undefined;
    if (ref) {
      const name = ref.split("/").pop() as string;
      const found = ((doc.definitions ?? {}) as JsonObject)[name] as JsonObject | undefined;
      if (!found) throw new Error(`definition ${name} is not in this bundle file`);
      current = found;
      continue;
    }
    const anyOf = current.anyOf as JsonObject[] | undefined;
    if (anyOf) {
      const branch = anyOf.find((b) => b.type !== "null");
      if (!branch) return current;
      current = branch;
      continue;
    }
    return current;
  }
  throw new Error("$ref chain did not terminate");
}

/**
 * Assert every property `type` declares exists in the schema object `node` and
 * carries the same optionality the schema gives it. Recurses into a property
 * only where the schema itself describes an object, so a string never gets
 * walked as one.
 */
function assertDeclaredFieldsExist(
  type: ts.Type,
  node: JsonObject,
  doc: JsonObject,
  file: string,
  path: string
): void {
  if (type.isUnion()) {
    for (const member of type.types) {
      if (member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) continue;
      assertDeclaredFieldsExist(member, node, doc, file, path);
    }
    return;
  }

  const properties = (node.properties ?? {}) as JsonObject;
  const known = Object.keys(properties);
  const required = new Set((node.required ?? []) as string[]);
  const declared = checker.getPropertiesOfType(type);
  expect(declared.length, `${path} declares no field at all`).toBeGreaterThan(0);

  for (const prop of declared) {
    assertFieldMatches(prop, known, required, file, path);
    descendIntoField(prop, properties, doc, file, path);
  }
}

/** The field exists in the schema, and carries the optionality the schema gives it. */
function assertFieldMatches(
  prop: ts.Symbol,
  known: string[],
  required: Set<string>,
  file: string,
  path: string
): void {
  const name = prop.getName();
  expect(
    known,
    `${path}.${name} is declared in protocol.ts but ${file} defines no such field`
  ).toContain(name);
  const optional = Boolean(prop.flags & ts.SymbolFlags.Optional);
  expect(
    optional,
    required.has(name)
      ? `${path}.${name} is required by ${file} but optional in protocol.ts`
      : `${path}.${name} is optional in ${file} but non-optional in protocol.ts`
  ).toBe(!required.has(name));
}

/** Recurses into a field only where both sides describe an object. */
function descendIntoField(
  prop: ts.Symbol,
  properties: JsonObject,
  doc: JsonObject,
  file: string,
  path: string
): void {
  const name = prop.getName();
  const declaration = prop.valueDeclaration ?? prop.declarations?.[0];
  if (!declaration) return;
  const child = resolveNode(properties[name] as JsonObject, doc);
  if (!child.properties) return;
  const childType = checker.getTypeOfSymbolAtLocation(prop, declaration);
  if (!(childType.flags & ts.TypeFlags.Object) && !childType.isUnion()) return;
  assertDeclaredFieldsExist(childType, child, doc, file, `${path}.${name}`);
}

class MockStdin extends EventEmitter {
  writable = true;
  writes: string[] = [];
  end(): void {}
  write(chunk: unknown): boolean {
    this.writes.push(String(chunk));
    return true;
  }
}

class MockProc extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = new MockStdin();
  killed = false;
  exitCode: number | null = null;
  pid = 4242;
  kill(): boolean {
    this.killed = true;
    return true;
  }
}

/**
 * The `initialize` params AppServerClient puts on the child's stdin, answered by
 * a stand-in process so the captured object is the one the client produced.
 */
async function captureInitializeParams(): Promise<JsonObject> {
  const proc = new MockProc();
  spawnMock.mockReset();
  spawnMock.mockReturnValue(proc);
  const { AppServerClient } = await import("../src/app-server/client.js");
  const client = new AppServerClient();
  const started = client.start({} as AppServerSpawnOptions);

  const line = JSON.parse(proc.stdin.writes.join("").trim()) as {
    method: string;
    id: number;
    params: JsonObject;
  };
  expect(line.method).toBe(Methods.INITIALIZE);
  proc.stdout.emit(
    "data",
    Buffer.from(
      `${JSON.stringify({ jsonrpc: "2.0", id: line.id, result: { userAgent: "mock" } })}\n`,
      "utf8"
    )
  );
  await started;
  return line.params;
}

// ── Tests ──────────────────────────────────────────────────────────

describe("codex-schema bundle", () => {
  it("pins its provenance in metadata.json", () => {
    const metadata = readSchema("metadata.json") as {
      generatedAt: string;
      generator: { name: string; version: string };
      command: string;
    };
    expect(metadata.generator.name).toBe("codex-cli");
    expect(metadata.generator.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(metadata.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(metadata.command).toContain("generate-json-schema");
  });

  it("declares every method exactly once across the four envelopes", () => {
    const all = ENVELOPES.flatMap((e) => e.methods.map((m) => m.method));
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBeGreaterThan(0);
  });
});

describe("Methods against the schema", () => {
  const entries = Object.entries(Methods);

  it.each(entries)("%s names a method the schema declares", (name, value) => {
    expect(
      SCHEMA_METHODS.has(value),
      `Methods.${name} = "${value}" is in no codex-schema envelope file`
    ).toBe(true);
  });

  it("maps every constant to a distinct method", () => {
    const values = entries.map(([, value]) => value);
    expect(new Set(values).size).toBe(values.length);
  });

  it.each(SERVER_TO_CLIENT_METHODS)(
    "server→client method %s is modelled or documented as unmodelled",
    (method) => {
      const modelled = Object.values(Methods).includes(
        method as (typeof Methods)[keyof typeof Methods]
      );
      if (modelled) return;
      expect(
        UNMODELED_SERVER_METHODS[method],
        `the schema sends "${method}" to clients; add it to Methods or to UNMODELED_SERVER_METHODS with a reason`
      ).toBeTruthy();
    }
  );

  it("keeps UNMODELED_SERVER_METHODS free of stale entries", () => {
    for (const method of Object.keys(UNMODELED_SERVER_METHODS)) {
      expect(SERVER_TO_CLIENT_METHODS, `${method} is no longer a server→client method`).toContain(
        method
      );
      expect(Object.values(Methods) as string[], `${method} is modelled after all`).not.toContain(
        method
      );
    }
  });
});

describe("parameter shapes against the schema", () => {
  it("points every schema method with params at a resolvable definition", () => {
    for (const { method, paramsRef, file } of SCHEMA_METHODS.values()) {
      if (!paramsRef) continue;
      expect(() => findDefinition(paramsRef), `${file}: ${method}`).not.toThrow();
    }
  });

  it("spells out the params of every method named in Methods except the listed ones", () => {
    const unmapped = Object.values(Methods)
      .map((value) => SCHEMA_METHODS.get(value))
      .filter((m): m is SchemaMethod => Boolean(m?.paramsRef))
      .filter((m) => !MODELLED_TYPES[m.paramsRef as string])
      .map((m) => m.method)
      .sort();
    expect(unmapped).toEqual([...PARAMS_LEFT_UNTYPED].sort());
  });

  it.each(Object.entries(MODELLED_TYPES))(
    "%s: protocol.ts declares every schema property",
    (definitionName, tsName) => {
      const definition = findDefinition(definitionName);
      const schemaProperties = Object.keys((definition.properties ?? {}) as JsonObject);
      const tsInterface = TS_INTERFACES.get(tsName);
      expect(tsInterface, `protocol.ts must export type ${tsName}`).toBeDefined();
      const declared = [...(tsInterface as TsInterface).properties.keys()];
      for (const property of schemaProperties) {
        expect(
          declared,
          `${tsName} is missing "${property}" of schema ${definitionName}`
        ).toContain(property);
      }
    }
  );

  it.each(Object.entries(MODELLED_TYPES))(
    "%s: protocol.ts marks every required schema property non-optional",
    (definitionName, tsName) => {
      const definition = findDefinition(definitionName);
      const required = (definition.required ?? []) as string[];
      const properties = (TS_INTERFACES.get(tsName) as TsInterface).properties;
      for (const property of required) {
        expect(
          properties.get(property),
          `${tsName}.${property} is required by schema ${definitionName} but optional in protocol.ts`
        ).toBe(false);
      }
    }
  );

  it("keeps every optional schema property optional in protocol.ts", () => {
    const wronglyRequired: string[] = [];
    for (const [definitionName, tsName] of Object.entries(MODELLED_TYPES)) {
      const definition = findDefinition(definitionName);
      const required = new Set((definition.required ?? []) as string[]);
      const properties = (TS_INTERFACES.get(tsName) as TsInterface).properties;
      for (const property of Object.keys((definition.properties ?? {}) as JsonObject)) {
        if (required.has(property)) continue;
        if (properties.get(property) === false) {
          wronglyRequired.push(`${tsName}.${property} (schema ${definitionName})`);
        }
      }
    }
    expect(wronglyRequired).toEqual([]);
  });
});

describe("AskForApproval union", () => {
  const definition = findDefinition("AskForApproval");
  const branches = definition.oneOf as JsonObject[];
  const stringBranches = branches.filter((b) => b.type === "string");
  const objectBranches = branches.filter((b) => b.type === "object");

  function approvalPolicyType(): ts.Type {
    const params = TS_INTERFACES.get("ThreadStartParams") as TsInterface;
    const symbol = checker.getPropertyOfType(params.type, "approvalPolicy");
    expect(symbol, "ThreadStartParams must declare approvalPolicy").toBeDefined();
    const declaration = (symbol as ts.Symbol).valueDeclaration as ts.Declaration;
    return checker.getTypeOfSymbolAtLocation(symbol as ts.Symbol, declaration);
  }

  it("declares every policy string of the schema", () => {
    const declared = approvalPolicyType()
      .types.filter((t) => t.isStringLiteral())
      .map((t) => (t as ts.StringLiteralType).value);
    const expected = stringBranches.flatMap((b) => b.enum as string[]);
    expect(expected.length).toBeGreaterThan(0);
    expect(declared.sort()).toEqual([...expected].sort());
  });

  it("declares the object branch of the schema", () => {
    expect(objectBranches).toHaveLength(1);
    const [branch] = objectBranches;
    const [key] = branch.required as string[];
    const member = approvalPolicyType().types.find((t) => checker.getPropertyOfType(t, key));
    expect(member, `no member of approvalPolicy carries "${key}"`).toBeDefined();

    const inner = (branch.properties as JsonObject)[key] as JsonObject;
    const innerSymbol = checker.getPropertyOfType(member as ts.Type, key) as ts.Symbol;
    const innerType = checker.getTypeOfSymbolAtLocation(
      innerSymbol,
      innerSymbol.valueDeclaration as ts.Declaration
    );
    const declared = new Map(
      checker
        .getPropertiesOfType(innerType)
        .map((p) => [p.getName(), Boolean(p.flags & ts.SymbolFlags.Optional)] as const)
    );
    const required = new Set((inner.required ?? []) as string[]);
    expect([...declared.keys()].sort()).toEqual(
      Object.keys((inner.properties ?? {}) as JsonObject).sort()
    );
    for (const [name, optional] of declared) {
      expect(
        optional,
        required.has(name)
          ? `${key}.${name} is required by the schema but optional in protocol.ts`
          : `${key}.${name} is optional in the schema but non-optional in protocol.ts`
      ).toBe(!required.has(name));
    }
  });
});

describe("initialize capabilities against the schema", () => {
  const definition = findDefinition("InitializeParams");
  const capabilityDefinition = findDefinition("InitializeCapabilities");

  it("sends only fields the schema's InitializeParams defines", async () => {
    const params = await captureInitializeParams();
    const known = Object.keys(definition.properties as JsonObject);
    for (const field of Object.keys(params)) {
      expect(
        known,
        `initialize sends "${field}", which schema InitializeParams does not define`
      ).toContain(field);
    }
    for (const field of (definition.required ?? []) as string[]) {
      expect(Object.keys(params), `schema InitializeParams requires "${field}"`).toContain(field);
    }
  });

  it("sends only capabilities the schema's InitializeCapabilities defines", async () => {
    const params = await captureInitializeParams();
    const capabilities = params.capabilities as JsonObject | undefined;
    expect(capabilities, "initialize sends no capabilities object").toBeDefined();
    const known = Object.keys(capabilityDefinition.properties as JsonObject);
    for (const field of Object.keys(capabilities as JsonObject)) {
      expect(
        known,
        `initialize declares capability "${field}", which schema InitializeCapabilities does not define`
      ).toContain(field);
    }
  });

  it("opts into the experimental API the schema defaults to off", async () => {
    const experimentalApi = (capabilityDefinition.properties as JsonObject)
      .experimentalApi as JsonObject;
    expect(experimentalApi.default, "schema InitializeCapabilities.experimentalApi").toBe(false);

    const params = await captureInitializeParams();
    expect((params.capabilities as JsonObject).experimentalApi).toBe(true);
  });

  it.each(EXPERIMENTAL_METHODS_IN_USE)(
    "%s is served here and is EXPERIMENTAL in the bundle, so the opt-in is what delivers it",
    (method) => {
      const schemaMethod = SCHEMA_METHODS.get(method);
      expect(schemaMethod, `${method} is in no codex-schema envelope`).toBeDefined();
      expect(
        (schemaMethod as SchemaMethod).description,
        `${method} is no longer marked EXPERIMENTAL; recheck why initialize opts in`
      ).toContain("EXPERIMENTAL");
    }
  );
});

describe("response shapes against the schema", () => {
  it.each(Object.entries(MODELLED_RESULTS))("%s declares only fields of %s", (tsName, file) => {
    const doc = readSchema(file);
    const tsInterface = TS_INTERFACES.get(tsName);
    expect(tsInterface, `protocol.ts must export type ${tsName}`).toBeDefined();
    assertDeclaredFieldsExist((tsInterface as TsInterface).type, doc, doc, file, tsName);
  });
});
