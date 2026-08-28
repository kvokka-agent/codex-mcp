import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSessionDefaults } from "../src/utils/session-defaults.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

describe("the server the plugin starts", () => {
  const config = JSON.parse(read("plugins/codex-mcp/.mcp.json"));
  const server = config.mcpServers["codex-mcp"];

  it("is bunx on the version this repository publishes", () => {
    const version = JSON.parse(read("package.json")).version;
    expect(server.command).toBe("bunx");
    expect(server.args).toEqual([`@kvokka/codex-mcp@${version}`]);
  });

  // The subagent runs on Haiku and names none of these, so the plugin is where
  // the model, the effort and the approval timeout of every session are set.
  it("names the model, the effort and the approval timeout a session starts on", () => {
    expect(resolveSessionDefaults(server.env)).toEqual({
      model: "gpt-5.6-luna",
      effort: "high",
      approvalTimeoutMs: 900_000,
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

  it("starts Codex unfenced unless the delegator fenced it", () => {
    expect(agent).toContain("`approvalPolicy: never`");
    expect(agent).toContain("`sandbox: danger-full-access`");
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
