import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error -- the launcher is plain ESM, started by the plugin's .mcp.json.
import {
  PACKAGE,
  ensureInstalled,
  entryPoint,
  installArgs,
  installDir,
  pluginVersion,
} from "../plugins/codex-mcp/bin/codex-mcp.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

type SpawnCall = { command: string; args: string[]; options: Record<string, unknown> };

/** A `spawnSync` that records the call and reports what the test tells it to. */
function fakeNpm(
  outcome: { status?: number | null; signal?: string; error?: Error },
  onRun?: (call: SpawnCall) => void
) {
  const calls: SpawnCall[] = [];
  const run = (command: string, args: string[], options: Record<string, unknown>) => {
    const call = { command, args, options };
    calls.push(call);
    onRun?.(call);
    return {
      status: outcome.status === undefined ? 0 : outcome.status,
      signal: outcome.signal,
      error: outcome.error,
    };
  };
  return { run, calls };
}

describe("the version the launcher starts", () => {
  it("is the one the plugin manifest declares", () => {
    const manifest = JSON.parse(read("plugins/codex-mcp/.claude-plugin/plugin.json"));
    expect(pluginVersion()).toBe(manifest.version);
  });

  it("is the version this repository publishes", () => {
    expect(pluginVersion()).toBe(JSON.parse(read("package.json")).version);
  });
});

describe("the server the plugin starts", () => {
  it("is this launcher, and carries no version of its own", () => {
    const config = JSON.parse(read("plugins/codex-mcp/.mcp.json"));
    expect(config.mcpServers["codex-mcp"]).toEqual({
      command: "node",
      args: ["${CLAUDE_PLUGIN_ROOT}/bin/codex-mcp.mjs"],
    });
  });
});

describe("installDir", () => {
  it("keys the directory by the version, under the cache the environment names", () => {
    expect(installDir("2.4.1", { XDG_CACHE_HOME: "/c" }, "/home/u")).toBe(
      join("/c", "codex-mcp", "versions", "2.4.1")
    );
  });

  it("falls back to .cache of the home directory", () => {
    expect(installDir("2.4.1", {}, "/home/u")).toBe(
      join("/home/u", ".cache", "codex-mcp", "versions", "2.4.1")
    );
  });

  it("gives two versions two directories", () => {
    const env = { XDG_CACHE_HOME: "/c" };
    expect(installDir("2.4.1", env, "/h")).not.toBe(installDir("2.4.2", env, "/h"));
  });
});

describe("installArgs", () => {
  it("installs the pinned package into the directory it was given and saves nothing", () => {
    expect(installArgs("/c/2.4.1", "2.4.1")).toEqual([
      "install",
      "--prefix",
      "/c/2.4.1",
      "--no-save",
      "--no-audit",
      "--no-fund",
      "--loglevel",
      "error",
      `${PACKAGE}@2.4.1`,
    ]);
  });
});

describe("ensureInstalled", () => {
  const cache = () => mkdtempSync(join(tmpdir(), "codex-mcp-launcher-"));

  /** Write the entry point a finished install leaves behind. */
  const layDown = (dir: string) => {
    const entry = entryPoint(dir) as string;
    mkdirSync(dirname(entry), { recursive: true });
    writeFileSync(entry, "");
    return entry;
  };

  it("runs npm once for a version it has not installed", () => {
    const home = cache();
    const dir = installDir("2.4.1", {}, home) as string;
    const npm = fakeNpm({ status: 0 }, () => layDown(dir));

    const entry = ensureInstalled("2.4.1", npm.run, {}, home);

    expect(entry).toBe(entryPoint(dir));
    expect(npm.calls).toHaveLength(1);
    expect(npm.calls[0].command).toBe("npm");
    expect(npm.calls[0].args).toEqual(installArgs(dir, "2.4.1"));
  });

  it("keeps npm's own output off stdout, which the server writes MCP frames to", () => {
    const home = cache();
    const npm = fakeNpm({ status: 0 }, () => layDown(installDir("2.4.1", {}, home) as string));

    ensureInstalled("2.4.1", npm.run, {}, home);

    expect(npm.calls[0].options.stdio).toEqual(["ignore", 2, 2]);
  });

  it("runs no npm for a version already installed", () => {
    const home = cache();
    layDown(installDir("2.4.1", {}, home) as string);
    const npm = fakeNpm({ status: 0 });

    expect(ensureInstalled("2.4.1", npm.run, {}, home)).toBe(
      entryPoint(installDir("2.4.1", {}, home))
    );
    expect(npm.calls).toHaveLength(0);
  });

  it("reports the exit code of an npm that failed", () => {
    const home = cache();
    const npm = fakeNpm({ status: 1 });

    expect(() => ensureInstalled("2.4.1", npm.run, {}, home)).toThrow(/exited 1/);
  });

  it("reports the signal an npm died on", () => {
    const home = cache();
    const npm = fakeNpm({ status: null, signal: "SIGKILL" });

    expect(() => ensureInstalled("2.4.1", npm.run, {}, home)).toThrow(/on SIGKILL/);
  });

  it("reports an npm that could not be started", () => {
    const home = cache();
    const npm = fakeNpm({ error: new Error("spawn npm ENOENT") });

    expect(() => ensureInstalled("2.4.1", npm.run, {}, home)).toThrow(/spawn npm ENOENT/);
  });

  it("refuses an install that reported success and left no entry point", () => {
    const home = cache();
    const npm = fakeNpm({ status: 0 });

    expect(() => ensureInstalled("2.4.1", npm.run, {}, home)).toThrow(/left no/);
  });
});

describe("the driver the plugin ships", () => {
  const agent = read("plugins/codex-mcp/agents/codex.md");

  it("polls in rounds short enough to say something between them", () => {
    expect(agent).toContain('codex_check(action="poll", sessionId: <id>, waitMs: 60000)');
    // A poll held for the maximum reports nothing to the person watching a
    // subagent: its progress notifications reach the client and stop there.
    expect(agent).not.toContain("3600000");
  });

  it("writes the activity line out itself", () => {
    expect(agent).toContain("codex: <progress.activity>");
  });

  it("hands every request to Codex rather than answering one", () => {
    expect(agent).toContain("You do none of the work yourself.");
  });
});
