import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error -- the release rules are plain ESM, shared with the workflow that runs them.
import {
  applyVersion,
  currentVersion,
  nextVersion,
  ROOT,
  releaseLevel,
  TARGETS,
} from "../scripts/release.mjs";

type Target = { path: string; pattern: RegExp; count: number };

const targets = TARGETS as Target[];
const read = (path: string) => readFileSync(join(ROOT as string, path), "utf8");

describe("nextVersion", () => {
  it("raises the patch, the minor and the major of 2.2.0", () => {
    expect(nextVersion("2.2.0", "patch")).toBe("2.2.1");
    expect(nextVersion("2.2.0", "minor")).toBe("2.3.0");
    expect(nextVersion("2.2.0", "major")).toBe("3.0.0");
  });

  it("resets the parts below the one it raises", () => {
    expect(nextVersion("1.9.7", "minor")).toBe("1.10.0");
    expect(nextVersion("1.9.7", "major")).toBe("2.0.0");
  });

  it("refuses a level it does not know", () => {
    expect(() => nextVersion("2.2.0", "pre")).toThrow(/unknown release level pre/);
  });

  it("refuses a version that is not three numbers", () => {
    expect(() => nextVersion("2.2.0-rc.1", "patch")).toThrow(/not a release version/);
    expect(() => nextVersion("2.2", "patch")).toThrow(/not a release version/);
  });
});

describe("releaseLevel", () => {
  it("reads the level out of the release label", () => {
    expect(releaseLevel(["release:patch"])).toBe("patch");
    expect(releaseLevel(["bug", "release:major", "docs"])).toBe("major");
  });

  it("asks for no release when no label asks for one", () => {
    expect(releaseLevel([])).toBeNull();
    expect(releaseLevel(["bug", "docs"])).toBeNull();
  });

  it("refuses two release labels at once", () => {
    expect(() => releaseLevel(["release:minor", "release:patch"])).toThrow(/one release label/);
  });

  it("refuses a release label it does not know", () => {
    expect(() => releaseLevel(["release:hotfix"])).toThrow(/unknown release label/);
  });
});

describe("the files that carry the version", () => {
  const current = currentVersion() as string;
  const raised = nextVersion(current, "minor") as string;

  it("names the package, the plugin, the marketplace and both pins", () => {
    expect(targets.map((target) => target.path)).toEqual([
      "package.json",
      "plugins/codex-mcp/.claude-plugin/plugin.json",
      ".claude-plugin/marketplace.json",
      "plugins/codex-mcp/.mcp.json",
      "plugins/codex-mcp/README.md",
    ]);
  });

  it.each(targets)("moves $path to the new version and touches nothing else", (target) => {
    const before = read(target.path);
    const after = applyVersion(before, target, raised);

    expect(after).not.toBe(before);
    for (const hit of after.match(target.pattern) ?? []) {
      expect(hit).toContain(raised);
    }
    // Putting the old version back through the same patterns restores the file byte for
    // byte, so the edit reached the version references and nothing around them.
    expect(applyVersion(after, target, current)).toBe(before);
  });

  it("leaves valid json behind", () => {
    for (const target of targets.filter((each) => each.path.endsWith(".json"))) {
      const after = applyVersion(read(target.path), target, raised);
      expect(() => JSON.parse(after)).not.toThrow();
    }
  });

  it("reports the version the npm package declares", () => {
    expect(current).toBe(JSON.parse(read("package.json")).version);
  });

  it("fails instead of releasing a tree where a file no longer carries the version", () => {
    const target = targets[0];
    expect(() => applyVersion("{}", target, raised)).toThrow(
      /package\.json holds 0 version reference\(s\)/
    );
  });
});
