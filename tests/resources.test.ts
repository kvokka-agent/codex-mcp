import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_APPROVAL_TIMEOUT_MS, DEFAULT_EFFORT_LEVEL } from "../src/types.js";
import { mockModule } from "./helpers/mock.js";
import { present } from "./helpers/present.js";

/**
 * `detectCodexCliVersion` runs the resolved executable with `--version` under a
 * 1.5s budget. Left real, every read of these two resources spawns a process and
 * a runner slow enough to miss that budget turns the version into null; the stub
 * decides what the binary answered instead.
 */
const cliVersionRun = {
  result: { status: 0, stdout: "codex-cli 0.150.1", stderr: "" } as unknown,
};

const realModule1 = { ...(await import("node:child_process")) };
mockModule("child_process", realModule1, () => {
  const actual = realModule1;
  return {
    ...actual,
    default: actual,
    spawnSync: () => cliVersionRun.result,
  };
});

const { registerResources, RESOURCE_URIS } = await import("../src/resources/register-resources.js");
const { _resetForTesting } = await import("../src/utils/codex-executable.js");

interface ReadResult {
  contents?: Array<{ uri?: string; text?: string; mimeType?: string }>;
}

interface Registered {
  name: string;
  uri: string;
  title?: string;
  description?: string;
  mimeType?: string;
  read: () => ReadResult;
}

const EXPECTED_MIME_TYPES: Record<keyof typeof RESOURCE_URIS, string> = {
  serverInfo: "application/json",
  compatReport: "application/json",
  config: "text/markdown",
  gotchas: "text/markdown",
  quickstart: "text/markdown",
  errors: "text/markdown",
  delegationGuide: "text/markdown",
};

/**
 * Both the CLI-version probe and the stdio mode come from the environment, so every read is
 * measured with those pinned; getDefaultCodexExecutable() caches, hence the reset around each.
 */
const PINNED_ENV_KEYS = [
  "PATH",
  "Path",
  "path",
  "CODEX_MCP_PATH",
  "CODEX_MCP_COMMAND",
  "CODEX_MCP_STDIO_MODE",
] as const;

let emptyBinDir: string;
let envBackup: Record<string, string | undefined>;

function pinEnv(overrides: Record<string, string | undefined>): void {
  for (const key of PINNED_ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  _resetForTesting();
}

function collect(
  overrides: {
    version?: string;
    activeSessions?: number;
    observedModel?: string;
    diskPersistence?: boolean;
  } = {}
): Registered[] {
  const registered: Registered[] = [];
  const fakeServer = {
    registerResource: (
      name: string,
      uriOrTemplate: string,
      config: { title?: string; description?: string; mimeType?: string },
      readCallback: () => ReadResult
    ) => {
      registered.push({
        name,
        uri: uriOrTemplate,
        title: config.title,
        description: config.description,
        mimeType: config.mimeType,
        read: readCallback,
      });
      return {};
    },
  };

  registerResources(fakeServer as never, {
    version: overrides.version ?? "0.0.0-test",
    diskPersistence: overrides.diskPersistence ?? true,
    sessionDefaults: {
      effort: DEFAULT_EFFORT_LEVEL,
      approvalTimeoutMs: DEFAULT_APPROVAL_TIMEOUT_MS,
    },
    sessionManager: {
      getActiveSessionCount: () => overrides.activeSessions ?? 3,
      getObservedDefaultModel: () =>
        "observedModel" in overrides ? overrides.observedModel : "o4-mini",
    } as never,
  });

  return registered;
}

function resource(registered: Registered[], uri: string): Registered {
  const found = registered.find((r) => r.uri === uri);
  expect(found, `resource not registered: ${uri}`).toBeDefined();
  return present(found, `the registered resource ${uri}`);
}

function readText(entry: Registered): string {
  const result = entry.read();
  expect(result.contents, `${entry.uri} returned no contents`).toHaveLength(1);
  const contents = present(result.contents, `the contents of ${entry.uri}`);
  const content = contents[0];
  expect(content.uri).toBe(entry.uri);
  expect(content.mimeType).toBe(entry.mimeType);
  expect(typeof content.text).toBe("string");
  return present(content.text, `the text of ${entry.uri}`);
}

function readJson(entry: Registered): Record<string, unknown> {
  return JSON.parse(readText(entry)) as Record<string, unknown>;
}

describe("resources", () => {
  beforeAll(() => {
    emptyBinDir = mkdtempSync(path.join(os.tmpdir(), "codex-mcp-resources-"));
  });

  afterAll(() => {
    rmSync(emptyBinDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    envBackup = Object.fromEntries(PINNED_ENV_KEYS.map((key) => [key, process.env[key]]));
    cliVersionRun.result = { status: 0, stdout: "codex-cli 0.150.1", stderr: "" };
    pinEnv({ PATH: emptyBinDir, CODEX_MCP_PATH: process.execPath, CODEX_MCP_STDIO_MODE: "strict" });
  });

  afterEach(() => {
    for (const key of PINNED_ENV_KEYS) {
      const value = envBackup[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    _resetForTesting();
  });

  it("registers every catalogued URI with its declared metadata", () => {
    const registered = collect();

    expect(registered.map((r) => r.uri).sort()).toEqual(Object.values(RESOURCE_URIS).sort());

    for (const [key, uri] of Object.entries(RESOURCE_URIS)) {
      const entry = resource(registered, uri);
      expect(entry.mimeType, `${key} mimeType`).toBe(
        EXPECTED_MIME_TYPES[key as keyof typeof RESOURCE_URIS]
      );
      expect(entry.name, `${key} name`).toMatch(/^[a-z][a-z0-9_]*$/);
      const title = present(entry.title, `the title of ${key}`);
      const description = present(entry.description, `the description of ${key}`);
      expect(title.length, `${key} title`).toBeGreaterThan(0);
      expect(description.length, `${key} description`).toBeGreaterThan(0);
      // Every resource must actually render; readText also checks the echoed uri/mimeType.
      expect(readText(entry).length).toBeGreaterThan(0);
    }
  });

  it("reports the running process and the injected runtime in server-info", () => {
    const registered = collect({ version: "9.9.9-test", activeSessions: 7 });
    const payload = readJson(resource(registered, RESOURCE_URIS.serverInfo));

    expect(payload.name).toBe("codex-mcp");
    expect(payload.version).toBe("9.9.9-test");
    expect(payload.runtime).toBe(`bun v${process.versions.bun}`);
    expect(payload.platform).toBe(process.platform);
    expect(payload.arch).toBe(process.arch);
    expect(payload.stdioMode).toBe("strict");
    expect(payload.codexCliVersion).toBe("0.150.1");
    expect(payload.activeSessions).toBe(7);
    expect(payload.defaultModel).toBe("o4-mini");
    expect(payload.defaultModelSource).toBe("session-default");

    expect(payload.supportedApprovalPolicies).toEqual(["untrusted", "on-request", "never"]);
    expect(payload.supportedSandboxModes).toEqual([
      "read-only",
      "workspace-write",
      "danger-full-access",
    ]);
    expect(payload.advertisedEffortLevels).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);

    const advertised = payload.resources as Array<{
      uri: string;
      title: string;
      mimeType: string;
      description: string;
    }>;
    expect(advertised.map((r) => r.uri).sort()).toEqual(Object.values(RESOURCE_URIS).sort());
    for (const entry of advertised) {
      const registration = resource(registered, entry.uri);
      expect(entry.title).toBe(registration.title);
      expect(entry.mimeType).toBe(registration.mimeType);
      expect(entry.description).toBe(registration.description);
    }
  });

  it("marks the model unknown until a session observes one", () => {
    const payload = readJson(
      resource(collect({ observedModel: undefined }), RESOURCE_URIS.serverInfo)
    );

    expect(payload.defaultModel).toBeUndefined();
    expect(payload.defaultModelSource).toBe("unknown");
  });

  it("reports capability flags and the runtime block in the compat report", () => {
    const registered = collect({ version: "9.9.9-test", activeSessions: 7 });
    const payload = readJson(resource(registered, RESOURCE_URIS.compatReport));

    expect(payload.schemaVersion).toBe("1.0.0");

    const features = payload.features as Record<string, unknown>;
    expect(features, "compat report has no features").toBeDefined();
    expect(features.respondPermission).toBe(true);
    expect(features.respondApprovalAlias).toBe(false);
    expect(features.statusOnlyCheck).toBe(true);
    expect(features.checkLongPoll).toBe(true);
    expect(features.compatWarnings).toBe(true);
    expect(features.diskPersistence).toBe(true);
    expect(features.diskResume).toBe(true);
    expect(features.dynamicTools).toBe(false);

    const runtime = payload.runtime as Record<string, unknown>;
    expect(runtime, "compat report has no runtime block").toBeDefined();
    expect(runtime.codexMcpVersion).toBe("9.9.9-test");
    expect(runtime.activeSessions).toBe(7);
    expect(runtime.codexCliVersion).toBe("0.150.1");

    // toolCounts.core is compared against the tools the server really registers in
    // tests/tools-list.test.ts; here only its shape is fixed.
    const toolCounts = payload.toolCounts as Record<string, unknown>;
    expect(toolCounts, "compat report has no toolCounts").toBeDefined();
    expect(Object.keys(toolCounts)).toEqual(["core"]);
    expect(Number.isInteger(toolCounts.core)).toBe(true);
    expect(toolCounts.core as number).toBeGreaterThan(0);
  });

  it("says session history is memory-only when the server claimed no state directory", () => {
    const payload = readJson(
      resource(collect({ diskPersistence: false }), RESOURCE_URIS.compatReport)
    );

    expect((payload.features as Record<string, unknown>).diskPersistence).toBe(false);
    expect((payload.featureNotes as Record<string, string>).diskPersistence).toContain(
      "memory only"
    );
    expect(payload.runtimeWarnings).toContain(
      "Disk persistence is off: sessions are held in memory only and are lost when the server restarts."
    );
  });

  it("warns only when the codex CLI version cannot be detected", () => {
    const detected = readJson(resource(collect(), RESOURCE_URIS.compatReport));
    expect(detected.runtimeWarnings).toEqual([]);

    // A binary that could not be launched at all is what "not detected" means.
    cliVersionRun.result = { error: new Error("spawnSync codex ENOENT"), status: null };
    _resetForTesting();
    const undetected = readJson(resource(collect(), RESOURCE_URIS.compatReport));
    expect(undetected.runtime).toMatchObject({ codexCliVersion: null });
    expect(undetected.runtimeWarnings).toEqual([
      "Unable to detect local codex CLI version from PATH.",
    ]);
  });

  it("documents parameters, gotchas, quickstart, errors and delegation", () => {
    const registered = collect();

    const config = readText(resource(registered, RESOURCE_URIS.config));
    expect(config).toContain("advanced.config");
    expect(config).toContain("`codex_reply` differences");
    expect(config).toContain("approvalTimeoutMs");
    expect(config).toContain("Override persistence");

    const gotchas = readText(resource(registered, RESOURCE_URIS.gotchas));
    expect(gotchas).toContain("waitMs");
    expect(gotchas).toContain("rollout log");
    expect(gotchas).toContain("untrusted");
    expect(gotchas).toContain("Idle sessions are auto-cleaned");

    const quickstart = readText(resource(registered, RESOURCE_URIS.quickstart));
    expect(quickstart).toContain("Minimal flow");
    expect(quickstart).toContain('"action": "respond_permission"');

    const errors = readText(resource(registered, RESOURCE_URIS.errors));
    expect(errors).toContain("Error [CODE]");
    expect(errors).toContain("REQUEST_NOT_FOUND");

    const delegation = readText(resource(registered, RESOURCE_URIS.delegationGuide));
    expect(delegation).toContain("| Task | approvalPolicy | sandbox | Notes |");
    expect(delegation).toContain("Default approval timeout is 60000ms");
  });
});
