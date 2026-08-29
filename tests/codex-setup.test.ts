import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PermissionProfileSummary } from "../src/app-server/protocol.js";
import { executeCodexSetup, type PermissionProfileLister } from "../src/tools/codex-setup.js";
import { isCodexCliBelowMinimum } from "../src/utils/codex-version.js";
import { mockModule } from "./helpers/mock.js";

const { spawnSyncMock, spawnMock, homedirMock } = {
  spawnSyncMock: jest.fn(),
  spawnMock: jest.fn(),
  homedirMock: jest.fn(),
};

const realModule1 = { ...(await import("node:child_process")) };
mockModule("child_process", realModule1, () => {
  const actual = realModule1;
  return { ...actual, spawnSync: spawnSyncMock, spawn: spawnMock };
});

const realModule2 = { ...(await import("node:os")) };
mockModule("os", realModule2, () => {
  const actual = realModule2;
  return { ...actual, default: { ...actual, homedir: homedirMock }, homedir: homedirMock };
});

let root: string;
let home: string;
let serverCwd: string;
const envBackup = { ...process.env };

/** What the stubbed `permissionProfile/list` answers, or the failure it raises. */
let profilesResult: (() => Promise<PermissionProfileSummary[]>) | null = null;
const listProfiles: PermissionProfileLister = (cwd) => {
  listedCwds.push(cwd);
  return (profilesResult ?? (async () => []))();
};
const listedCwds: string[] = [];

function makeExecutable(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  writeFileSync(file, "#!/bin/sh\nexit 0\n");
  chmodSync(file, 0o755);
  return file;
}

function writeConfig(dir: string): void {
  mkdirSync(path.join(dir, ".codex"), { recursive: true });
  writeFileSync(path.join(dir, ".codex", "config.toml"), "model = 'gpt-5'\n");
}

type SpawnResult = { status: number | null; stdout?: string; stderr?: string; error?: Error };

/** What the stubbed CLI answers `codex --version` with; every test starts on a supported build. */
let versionResult: SpawnResult = { status: 0, stdout: "codex-cli 0.150.1", stderr: "" };

/** What the stubbed CLI answers `codex login status` with. */
let authResult: SpawnResult = { status: 0 };

function loginStatus(status: number | null, stdout = "", stderr = ""): void {
  authResult = { status, stdout, stderr };
}

function installSpawnStub(): void {
  spawnSyncMock.mockImplementation((_command: string, args: string[]) =>
    args.includes("--version") ? versionResult : authResult
  );
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "codex-mcp-setup-"));
  home = path.join(root, "home");
  serverCwd = path.join(root, "server-cwd");
  mkdirSync(home, { recursive: true });
  mkdirSync(serverCwd, { recursive: true });
  homedirMock.mockReturnValue(home);
  spawnSyncMock.mockReset();
  spawnMock.mockReset();
  versionResult = { status: 0, stdout: "codex-cli 0.150.1", stderr: "" };
  loginStatus(0, "Logged in as tester");
  installSpawnStub();
  profilesResult = null;
  listedCwds.length = 0;

  delete process.env.CODEX_MCP_COMMAND;
  process.env.CODEX_MCP_STATE_DIR = path.join(root, "state");
  process.env.CODEX_MCP_PATH = makeExecutable(path.join(root, "bin"), "codex");
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) {
    if (!(key in envBackup)) delete process.env[key];
  }
  Object.assign(process.env, envBackup);
  jest.restoreAllMocks();
});

describe("executeCodexSetup", () => {
  it("reports a ready environment", async () => {
    writeConfig(home);
    const result = await executeCodexSetup(undefined, serverCwd, listProfiles);

    expect(result.ready).toBe(true);
    expect(result.cwd).toBe(serverCwd);
    expect(result.executable).toEqual({
      ok: true,
      source: "env_path",
      command: process.env.CODEX_MCP_PATH,
      isPath: true,
      detail: "Codex resolves via env_path.",
    });
    expect(result.auth).toEqual({
      ok: true,
      state: "authenticated",
      detail: "Logged in as tester",
    });
    expect(result.backend).toEqual({
      ok: true,
      cliVersion: "0.150.1",
      minimumCliVersion: "0.101.0",
      detail: "Codex CLI 0.150.1 carries `codex app-server`, which every session runs on.",
    });
    expect(result.runtime).toEqual({
      sameMachineRequired: true,
      stateDir: path.join(root, "state"),
    });
    expect(result.projectContext).toEqual({ hasUserConfig: true, hasProjectConfig: false });
    expect(result.warnings).toEqual([]);
    expect(result.nextSteps).toEqual([]);
  });

  it("probes auth with the resolved executable", async () => {
    await executeCodexSetup(undefined, serverCwd, listProfiles);

    const [cmd, args, opts] = spawnSyncMock.mock.calls[0] as [
      string,
      string[],
      { timeout: number },
    ];
    expect(cmd).toBe(process.env.CODEX_MCP_PATH);
    expect(args).toEqual(["login", "status"]);
    expect(opts.timeout).toBe(5000);
  });

  it("uses the requested cwd and detects a project config there", async () => {
    const projectCwd = path.join(root, "project");
    mkdirSync(projectCwd, { recursive: true });
    writeConfig(projectCwd);

    const result = await executeCodexSetup({ cwd: projectCwd }, serverCwd, listProfiles);
    expect(result.cwd).toBe(projectCwd);
    expect(result.projectContext).toEqual({ hasUserConfig: false, hasProjectConfig: true });
    expect(result.warnings).toEqual([]);
  });

  it("falls back to the server cwd for a blank input cwd", async () => {
    const result = await executeCodexSetup({ cwd: "   " }, serverCwd, listProfiles);
    expect(result.cwd).toBe(serverCwd);
  });

  it("warns when no Codex config is present anywhere", async () => {
    const result = await executeCodexSetup(undefined, serverCwd, listProfiles);
    expect(result.warnings).toContain(
      "No Codex config.toml was found in ~/.codex or this project."
    );
  });

  it("reports an unauthenticated CLI and the login step", async () => {
    writeConfig(home);
    loginStatus(1, "", "Not logged in. Run codex login first.");

    const result = await executeCodexSetup(undefined, serverCwd, listProfiles);
    expect(result.auth).toEqual({
      ok: false,
      state: "unauthenticated",
      detail: "Not logged in. Run codex login first.",
    });
    expect(result.ready).toBe(false);
    expect(result.nextSteps).toEqual(["Run `codex login` and rerun `codex_setup`."]);
  });

  it("refuses readiness for an auth answer it could not classify", async () => {
    // A CLI that reworded its login output leaves the probe with no verdict; calling that
    // ready sends the caller into a session that fails on authentication.
    writeConfig(home);
    loginStatus(7, "unexpected output");

    const result = await executeCodexSetup(undefined, serverCwd, listProfiles);
    expect(result.auth.state).toBe("unknown");
    expect(result.auth.ok).toBe(false);
    expect(result.ready).toBe(false);
    expect(result.warnings).toEqual(["unexpected output"]);
    expect(result.nextSteps[0]).toContain("Verify Codex authentication explicitly");
  });

  it("keeps a default detail when the probe prints nothing", async () => {
    writeConfig(home);
    loginStatus(0, "", "");

    const result = await executeCodexSetup(undefined, serverCwd, listProfiles);
    expect(result.auth.detail).toBe("Authenticated.");
  });

  it("surfaces a failed auth probe", async () => {
    writeConfig(home);
    authResult = { status: null, error: new Error("spawn ENOENT") };

    const result = await executeCodexSetup(undefined, serverCwd, listProfiles);
    expect(result.auth).toEqual({
      ok: false,
      state: "unknown",
      detail: "Failed to probe auth status: spawn ENOENT",
    });
    expect(result.ready).toBe(false);
  });

  it("skips the auth probe for a codex-internal executable", async () => {
    // The one unknown auth state that still counts as ready: the probe was deliberately skipped.
    writeConfig(home);
    process.env.CODEX_MCP_PATH = makeExecutable(path.join(root, "bin"), "codex-internal");

    const result = await executeCodexSetup(undefined, serverCwd, listProfiles);
    expect(spawnSyncMock.mock.calls.map(([, args]) => args)).toEqual([["--version"]]);
    expect(result.auth.ok).toBe(true);
    expect(result.auth.state).toBe("unknown");
    expect(result.auth.detail).toContain("codex-internal");
    expect(result.ready).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.nextSteps).toEqual([]);
  });

  it("reports a missing executable without probing anything", async () => {
    writeConfig(home);
    delete process.env.CODEX_MCP_PATH;
    process.env.PATH = "";

    const result = await executeCodexSetup(undefined, serverCwd, listProfiles);
    expect(result.executable.ok).toBe(false);
    expect(result.executable.source).toBe("default");
    expect(result.executable.detail).toContain("No codex executable was auto-detected");
    expect(result.auth).toEqual({
      ok: false,
      state: "unknown",
      detail: "Auth status not checked because no codex executable was detected.",
    });
    expect(result.backend).toEqual({
      ok: false,
      cliVersion: null,
      minimumCliVersion: "0.101.0",
      detail: "Codex CLI version not checked because no codex executable was detected.",
    });
    expect(result.ready).toBe(false);
    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(result.warnings[0]).toContain("No codex executable was auto-detected");
    expect(result.nextSteps).toContain(
      "Install Codex or fix CODEX_MCP_COMMAND / CODEX_MCP_PATH so the executable can be resolved."
    );
  });

  it("reports a misconfigured executable resolution as an error source", async () => {
    writeConfig(home);
    process.env.CODEX_MCP_COMMAND = "codex";

    const result = await executeCodexSetup(undefined, serverCwd, listProfiles);
    expect(result.executable.source).toBe("error");
    expect(result.executable.ok).toBe(false);
    expect(result.executable.command).toBeUndefined();
    expect(result.executable.detail).toContain(
      "Cannot set both CODEX_MCP_PATH and CODEX_MCP_COMMAND"
    );
    expect(result.auth.detail).toBe(
      "Auth status not checked because executable resolution failed."
    );
    expect(result.ready).toBe(false);
  });

  it("refuses readiness for a CLI below the minimum and names the upgrade", async () => {
    writeConfig(home);
    versionResult = { status: 0, stdout: "codex-cli 0.100.0", stderr: "" };

    const result = await executeCodexSetup(undefined, serverCwd, listProfiles);
    expect(result.backend.ok).toBe(false);
    expect(result.backend.cliVersion).toBe("0.100.0");
    expect(result.warnings).toContain(
      "Codex CLI 0.100.0 is below the 0.101.0 this server needs: it carries no `codex app-server`, so no session starts. Upgrade the CLI."
    );
    expect(result.nextSteps).toContain("Upgrade the Codex CLI to 0.101.0 or newer.");
    expect(result.ready).toBe(false);
  });

  it("refuses readiness when the CLI printed no version to hold against the floor", async () => {
    // An unread version is not an old CLI, and the report says which of the two it is.
    writeConfig(home);
    versionResult = { status: 1, stdout: "", stderr: "error: unrecognized argument '--version'\n" };

    const result = await executeCodexSetup(undefined, serverCwd, listProfiles);
    expect(result.backend).toEqual({
      ok: false,
      cliVersion: null,
      minimumCliVersion: "0.101.0",
      detail:
        "`codex --version` printed no version, so this build cannot be held against the 0.101.0 floor.",
    });
    expect(result.ready).toBe(false);
  });

  it("counts the floor release itself as supported", async () => {
    writeConfig(home);
    versionResult = { status: 0, stdout: "codex-cli 0.101.0", stderr: "" };

    const result = await executeCodexSetup(undefined, serverCwd, listProfiles);
    expect(result.backend.ok).toBe(true);
    expect(result.ready).toBe(true);
  });

  it("defaults the state dir under the home directory", async () => {
    delete process.env.CODEX_MCP_STATE_DIR;
    const result = await executeCodexSetup(undefined, serverCwd, listProfiles);
    expect(result.runtime.stateDir).toBe(path.join(home, ".codex-mcp", "state"));

    process.env.CODEX_MCP_STATE_DIR = "   ";
    const blank = await executeCodexSetup(undefined, serverCwd, listProfiles);
    expect(blank.runtime.stateDir).toBe(path.join(home, ".codex-mcp", "state"));
  });
});

describe("isCodexCliBelowMinimum", () => {
  it("ranks a release against the floor", () => {
    expect(isCodexCliBelowMinimum("0.100.9")).toBe(true);
    expect(isCodexCliBelowMinimum("0.101.0")).toBe(false);
    expect(isCodexCliBelowMinimum("0.150.1")).toBe(false);
    expect(isCodexCliBelowMinimum("1.0.0")).toBe(false);
  });

  it("counts a prerelease of the floor release as the floor", () => {
    expect(isCodexCliBelowMinimum("0.101.0-alpha.1")).toBe(false);
    expect(isCodexCliBelowMinimum("0.100.0-alpha.1")).toBe(true);
  });

  it("reports a string carrying no three release numbers as not below the floor", () => {
    // An unreadable version is reported as unread — `codex_setup` says so in its
    // own branch — never as an old CLI this ranked and refused.
    expect(isCodexCliBelowMinimum("0.150")).toBe(false);
    expect(isCodexCliBelowMinimum("nightly")).toBe(false);
  });
});

describe("executeCodexSetup permission profiles", () => {
  it("names the ids a codex call may pass as permissions", async () => {
    profilesResult = async () => [
      { id: ":read-only", allowed: true, description: "Reads only" },
      { id: ":workspace", allowed: true },
      { id: ":danger-full-access", allowed: false },
    ];

    const result = await executeCodexSetup(undefined, serverCwd, listProfiles);

    expect(listedCwds).toEqual([serverCwd]);
    expect(result.permissionProfiles.ok).toBe(true);
    expect(result.permissionProfiles.profiles?.map((profile) => profile.id)).toEqual([
      ":read-only",
      ":workspace",
      ":danger-full-access",
    ]);
    // The detail names the selectable ones only; `allowed: false` is a distinct
    // case the profile list itself still carries.
    expect(result.permissionProfiles.detail).toBe(
      "Pass one of these ids as `permissions`: :read-only, :workspace."
    );
    expect(result.warnings).not.toContain(result.permissionProfiles.detail);
  });

  it("resolves the profiles of the cwd the call named", async () => {
    profilesResult = async () => [];
    const projectCwd = path.join(root, "project");
    mkdirSync(projectCwd, { recursive: true });

    const result = await executeCodexSetup({ cwd: projectCwd }, serverCwd, listProfiles);

    expect(listedCwds).toEqual([projectCwd]);
    expect(result.permissionProfiles).toEqual({
      ok: true,
      profiles: [],
      detail: "This machine offers no permission profile; `permissions` has no id to name here.",
    });
  });

  it("carries a listing that failed through instead of answering with no profiles", async () => {
    profilesResult = async () => {
      throw new Error("permissionProfile/list timed out after 30000ms");
    };

    const result = await executeCodexSetup(undefined, serverCwd, listProfiles);

    expect(result.permissionProfiles.ok).toBe(false);
    expect(result.permissionProfiles.profiles).toBeUndefined();
    expect(result.permissionProfiles.detail).toBe(
      "Failed to list permission profiles: permissionProfile/list timed out after 30000ms"
    );
    expect(result.warnings).toContain(result.permissionProfiles.detail);
    expect(result.nextSteps).toContain(
      "Start a session with `sandbox` rather than `permissions` until the profile listing answers."
    );
  });

  it("does not list profiles when no codex executable resolved", async () => {
    delete process.env.CODEX_MCP_PATH;
    process.env.PATH = "";
    profilesResult = async () => {
      throw new Error("this lister must not run");
    };

    const result = await executeCodexSetup(undefined, serverCwd, listProfiles);

    expect(listedCwds).toEqual([]);
    expect(result.permissionProfiles).toEqual({
      ok: false,
      detail: "Permission profiles not listed because no codex executable was detected.",
    });
  });
});
