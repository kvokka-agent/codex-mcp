/**
 * Conformance of src/app-server/protocol.ts with the vendored codex-schema bundle.
 *
 * Both sides of every assertion are read, not written here: method names and
 * parameter shapes come from codex-schema/*.json, and the TypeScript side comes
 * from the compiler's view of protocol.ts. Regenerating the bundle with a newer
 * `codex` CLI therefore fails this file wherever the model drifted.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { Methods } from "../src/app-server/protocol.js";

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
 * `Methods` values that are deliberately absent from the schema, with the reason.
 * Anything else in `Methods` must be a real protocol method.
 */
const SYNTHETIC_METHODS: Record<string, string> = {
  "rawResponseItem/completed":
    "ExecClient label for the `raw_response_item` event of `codex exec --json`. " +
    "The schema carries the payload (v2/RawResponseItemCompletedNotification.json) but binds it to no app-server method.",
  sessionConfigured:
    "ExecClient label for the `session_configured` event of `codex exec --json`. " +
    "The app-server equivalent is the v1 notification `codex/event/session_configured`, which this code does not use.",
};

/**
 * Server → client methods this codebase does not model, with the reason each one
 * costs nothing to drop. A method leaving this list without entering `Methods`
 * fails the reverse check below.
 */
const UNMODELED_SERVER_METHODS: Record<string, string> = {
  "thread/realtime/started": "realtime audio threads; codex-mcp starts text turns only",
  "thread/realtime/itemAdded": "realtime audio threads; codex-mcp starts text turns only",
  "thread/realtime/outputAudio/delta": "realtime audio threads; codex-mcp starts text turns only",
  "thread/realtime/error": "realtime audio threads; codex-mcp starts text turns only",
  "thread/realtime/closed": "realtime audio threads; codex-mcp starts text turns only",
  "account/updated": "account management is done in the codex CLI, not through this server",
  "account/rateLimits/updated":
    "account management is done in the codex CLI, not through this server",
  "app/list/updated": "ChatGPT app catalogue; codex-mcp exposes no app picker",
  "mcpServer/oauthLogin/completed":
    "MCP server logins are configured in the codex CLI, not through this server",
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
  ItemStartedNotification: "ItemNotificationParams",
  ItemCompletedNotification: "ItemNotificationParams",
  AgentMessageDeltaNotification: "DeltaNotificationParams",
  PlanDeltaNotification: "DeltaNotificationParams",
  CommandExecutionOutputDeltaNotification: "DeltaNotificationParams",
  FileChangeOutputDeltaNotification: "DeltaNotificationParams",
  ReasoningTextDeltaNotification: "ReasoningDeltaParams",
  TurnStartedNotification: "TurnNotificationParams",
  TurnCompletedNotification: "TurnNotificationParams",
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

  it.each(entries)("%s is a schema method or a documented synthetic one", (name, value) => {
    if (SCHEMA_METHODS.has(value)) return;
    const reason = SYNTHETIC_METHODS[value];
    expect(
      reason,
      `Methods.${name} = "${value}" is in no codex-schema envelope and has no entry in SYNTHETIC_METHODS`
    ).toBeTruthy();
  });

  it("keeps SYNTHETIC_METHODS free of names the schema does define", () => {
    for (const [method, reason] of Object.entries(SYNTHETIC_METHODS)) {
      expect(SCHEMA_METHODS.has(method), `${method} is a real schema method: ${reason}`).toBe(
        false
      );
    }
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
    const declared = checker
      .getPropertiesOfType(innerType)
      .map((p) => p.getName())
      .sort();
    expect(declared).toEqual([...(inner.required as string[])].sort());
  });
});
