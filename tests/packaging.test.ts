/** The runtime the package ships for, read off what the build actually wrote. */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ensureServerBuilt, REPO_ROOT, SERVER_ENTRY } from "./helpers/server-harness.js";

const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
  engines: Record<string, string>;
  scripts: Record<string, string>;
};

describe("the bundle the package ships", () => {
  it("names bun on its shebang line, which is what a bare `codex-mcp` runs", () => {
    ensureServerBuilt();
    const firstLine = readFileSync(SERVER_ENTRY, "utf8").split("\n", 1)[0];
    expect(firstLine).toBe("#!/usr/bin/env bun");
  });
});

describe("what the package asks of the machine it lands on", () => {
  it("asks for bun and for no node", () => {
    expect(pkg.engines.bun).toBe(">=1.4.0");
    expect(pkg.engines.node).toBeUndefined();
  });

  it("starts everything it runs with bun", () => {
    const runners = ["start", "check:stdio", "check:stdio:strict", "smoke:mcp"];
    for (const name of runners) expect(pkg.scripts[name]).toStartWith("bun ");
  });
});
