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

describe("the driver the plugin ships", () => {
  const skill = read("plugins/codex-mcp/skills/codex/SKILL.md");

  it("polls in rounds short enough to say something between them", () => {
    expect(skill).toContain('codex_check(action="poll", sessionId, waitMs: 300000)');
    // A round of the maximum says nothing to the person waiting for an hour.
    expect(skill).not.toContain("3600000");
  });

  it("writes the activity line out itself, and says how long it has stood", () => {
    expect(skill).toContain("codex: <progress.activity>");
    expect(skill).toContain("codex: <progress.activity> — 15 min");
    expect(skill).toContain("progress.activityStandingMs");
  });

  it("keeps the loop where the person waiting reads it", () => {
    expect(skill).toContain("A poll made inside a subagent shows them nothing");
  });

  it("hands every request to Codex rather than answering one", () => {
    expect(skill).toContain("Codex does the work.");
  });
});
