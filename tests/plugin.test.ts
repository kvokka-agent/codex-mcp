import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSessionDefaults } from "../src/utils/session-defaults.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

const PLUGIN_SERVER = JSON.parse(read("plugins/codex-mcp/.mcp.json")).mcpServers["codex-mcp"];

describe("the server the plugin starts", () => {
  const server = PLUGIN_SERVER;

  it("is bunx on the version this repository publishes", () => {
    const version = JSON.parse(read("package.json")).version;
    expect(server.command).toBe("bunx");
    expect(server.args).toEqual([`@kvokka/codex-mcp@${version}`]);
  });

  // The subagent runs on Haiku and names none of these, so the plugin is where
  // every session's model, effort, approval timeout, approval policy and
  // sandbox are set.
  it("names what a session starts on, down to the permission level of the turn", () => {
    expect(resolveSessionDefaults(server.env)).toEqual({
      model: "gpt-5.6-luna",
      effort: "high",
      approvalTimeoutMs: 900_000,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
  });

  // npm exec answers a package request from the tree of the directory the client
  // started the server in, so in this repository's own checkout — and in any
  // project depending on the package — it ran the bare name `codex-mcp` from PATH,
  // exited 127 and the client read CONNECTION_CLOSED. bunx fetches the pin.
  it("is not npx, which cannot start it inside a tree that carries the package", () => {
    expect(server.command).not.toBe("npx");
  });
});

describe("the hook the plugin installs", () => {
  const hooks = JSON.parse(read("plugins/codex-mcp/hooks/hooks.json"));
  const command = hooks.hooks.PreToolUse[0].hooks[0].command;

  it("runs under bun, the one runtime the plugin already asks for", () => {
    expect(command).toStartWith("bun ");
  });
});

describe("the driver the plugin ships", () => {
  const agent = read("plugins/codex-mcp/agents/codex.md");

  it("polls in rounds short enough to say something between them", () => {
    expect(agent).toContain('codex_check(action="poll", sessionId, waitMs: 300000)');
    // A round of the maximum says nothing to the person waiting for an hour.
    expect(agent).not.toContain("3600000");
  });

  it("writes the activity line out itself, and says how long it has stood", () => {
    expect(agent).toContain("**Progress summary**: <progress.activity>");
    expect(agent).toContain("**Progress summary**: <progress.activity> — 15 min");
    expect(agent).toContain("progress.activityStandingMs");
  });

  it("leaves those lines out of the report, where the run is already over", () => {
    const report = agent.slice(agent.indexOf("## Report"));
    expect(report).not.toContain("progress:");
  });

  it("runs on the cheapest model, since it decides nothing", () => {
    expect(agent).toContain("model: haiku");
  });

  // `.mcp.json` is where a session's model, effort, approval timeout, approval
  // policy and sandbox are stated. A copy in the driver's prose is a second
  // place to change and a Haiku turn away from disagreeing with the server.
  it("repeats none of the values .mcp.json sets", () => {
    const defaults = resolveSessionDefaults(PLUGIN_SERVER.env);
    const named = [
      `model: ${defaults.model}`,
      `effort: ${defaults.effort}`,
      `approvalPolicy: ${defaults.approvalPolicy}`,
      `sandbox: ${defaults.sandbox}`,
      `approvalTimeoutMs: ${defaults.approvalTimeoutMs}`,
    ];
    for (const line of named) {
      expect(agent, `the driver names ${line} itself`).not.toContain(line);
    }
  });

  it("proxies every prompt to Codex rather than answering one", () => {
    expect(agent).toContain("You are a proxy.");
    // The three the driver kept answering itself instead of forwarding.
    expect(agent).toContain("1 + 1");
    expect(agent).toContain("прпгшукрпагкышщп");
    expect(agent).toContain("A page of shell commands");
  });

  it("keeps its own decisions to how Codex is started", () => {
    expect(agent).toContain("**What you decide is only how Codex is started**");
  });
});
