import { mockModule } from "./helpers/mock.js";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";

import { executeCodexSetup } from "../src/tools/codex-setup.js";

const { spawnSyncMock, spawnMock, homedirMock } = {
  spawnSyncMock: jest.fn(),
  spawnMock: jest.fn(),
  homedirMock: jest.fn(),
};

const realModule1 = { ...(await import("child_process")) };
mockModule("child_process", realModule1, () => {
  const actual = realModule1;
  return { ...actual, spawnSync: spawnSyncMock, spawn: spawnMock };
});

const realModule2 = { ...(await import("os")) };
mockModule("os", realModule2, () => {
  const actual = realModule2;
  return { ...actual, default: { ...actual, homedir: homedirMock }, homedir: homedirMock };
});

let root: string;
let home: string;
let serverCwd: string;
const envBackup = { ...process.env };

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

/** spawnSync result for `codex login status`. */
function loginStatus(status: number | null, stdout = "", stderr = ""): void {
  spawnSyncMock.mockReturnValue({ status, stdout, stderr });
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
  loginStatus(0, "Logged in as tester");

  delete process.env.CODEX_MCP_COMMAND;
  process.env.CODEX_MCP_MODE = "app-server";
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
    const result = await executeCodexSetup(undefined, serverCwd);

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
    expect(result.runtime).toEqual({
      sameMachineRequired: true,
      clientMode: "app-server",
      stateDir: path.join(root, "state"),
    });
    expect(result.projectContext).toEqual({ hasUserConfig: true, hasProjectConfig: false });
    expect(result.warnings).toEqual([]);
    expect(result.nextSteps).toEqual([]);
  });

  it("probes auth with the resolved executable", async () => {
    await executeCodexSetup(undefined, serverCwd);

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

    const result = await executeCodexSetup({ cwd: projectCwd }, serverCwd);
    expect(result.cwd).toBe(projectCwd);
    expect(result.projectContext).toEqual({ hasUserConfig: false, hasProjectConfig: true });
    expect(result.warnings).toEqual([]);
  });

  it("falls back to the server cwd for a blank input cwd", async () => {
    const result = await executeCodexSetup({ cwd: "   " }, serverCwd);
    expect(result.cwd).toBe(serverCwd);
  });

  it("warns when no Codex config is present anywhere", async () => {
    const result = await executeCodexSetup(undefined, serverCwd);
    expect(result.warnings).toContain(
      "No Codex config.toml was found in ~/.codex or this project."
    );
  });

  it("reports an unauthenticated CLI and the login step", async () => {
    writeConfig(home);
    loginStatus(1, "", "Not logged in. Run codex login first.");

    const result = await executeCodexSetup(undefined, serverCwd);
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

    const result = await executeCodexSetup(undefined, serverCwd);
    expect(result.auth.state).toBe("unknown");
    expect(result.auth.ok).toBe(false);
    expect(result.ready).toBe(false);
    expect(result.warnings).toEqual(["unexpected output"]);
    expect(result.nextSteps[0]).toContain("Verify Codex authentication explicitly");
  });

  it("keeps a default detail when the probe prints nothing", async () => {
    writeConfig(home);
    loginStatus(0, "", "");

    const result = await executeCodexSetup(undefined, serverCwd);
    expect(result.auth.detail).toBe("Authenticated.");
  });

  it("surfaces a failed auth probe", async () => {
    writeConfig(home);
    spawnSyncMock.mockReturnValue({ status: null, error: new Error("spawn ENOENT") });

    const result = await executeCodexSetup(undefined, serverCwd);
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

    const result = await executeCodexSetup(undefined, serverCwd);
    expect(spawnSyncMock).not.toHaveBeenCalled();
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

    const result = await executeCodexSetup(undefined, serverCwd);
    expect(result.executable.ok).toBe(false);
    expect(result.executable.source).toBe("default");
    expect(result.executable.detail).toContain("No codex executable was auto-detected");
    expect(result.auth).toEqual({
      ok: false,
      state: "unknown",
      detail: "Auth status not checked because no codex executable was detected.",
    });
    expect(result.runtime.clientMode).toBeUndefined();
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

    const result = await executeCodexSetup(undefined, serverCwd);
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

  it("warns about the reduced capabilities of exec fallback mode", async () => {
    writeConfig(home);
    process.env.CODEX_MCP_MODE = "exec";

    const result = await executeCodexSetup(undefined, serverCwd);
    expect(result.runtime.clientMode).toBe("exec");
    expect(result.warnings).toContain(
      "Codex app-server support was not detected; codex-mcp would run in exec fallback mode with fewer capabilities."
    );
    expect(result.ready).toBe(true);
  });

  it("defaults the state dir under the home directory", async () => {
    delete process.env.CODEX_MCP_STATE_DIR;
    const result = await executeCodexSetup(undefined, serverCwd);
    expect(result.runtime.stateDir).toBe(path.join(home, ".codex-mcp", "state"));

    process.env.CODEX_MCP_STATE_DIR = "   ";
    const blank = await executeCodexSetup(undefined, serverCwd);
    expect(blank.runtime.stateDir).toBe(path.join(home, ".codex-mcp", "state"));
  });
});
