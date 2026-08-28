import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

describe("the server the plugin starts", () => {
  const config = JSON.parse(read("plugins/codex-mcp/.mcp.json"));
  const server = config.mcpServers["codex-mcp"];

  it("is bunx on the version this repository publishes", () => {
    const version = JSON.parse(read("package.json")).version;
    expect(server).toEqual({ command: "bunx", args: [`@kvokka/codex-mcp@${version}`] });
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
    expect(agent).toContain("codex: <progress.activity>");
    expect(agent).toContain("codex: <progress.activity> — 15 min");
    expect(agent).toContain("progress.activityStandingMs");
  });

  it("carries those lines back in the report, which is the only path they travel", () => {
    expect(agent).toContain("progress:");
    expect(agent).toContain("nothing you write mid-run is rendered anywhere");
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
