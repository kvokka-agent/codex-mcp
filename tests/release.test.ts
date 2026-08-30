import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error -- the release rules are plain ESM, shared with the workflow that runs them.
import {
  applyVersion,
  CHANGELOG,
  currentVersion,
  nextVersion,
  pluginTag,
  ROOT,
  releaseLevel,
  rotateChangelog,
  TARGETS,
  today,
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

describe("pluginTag", () => {
  it("names the tag Claude Code resolves a dependency range against", () => {
    expect(pluginTag("3.2.1")).toBe("codex-mcp--v3.2.1");
  });

  it("takes the plugin name from the manifest that ships it", () => {
    const manifest = JSON.parse(read("plugins/codex-mcp/.claude-plugin/plugin.json"));
    expect(pluginTag(manifest.version)).toBe(`${manifest.name}--v${manifest.version}`);
  });

  it("tags the version the release is cutting, not the one on disk", () => {
    const raised = nextVersion(currentVersion(), "major") as string;
    expect(pluginTag(raised)).toBe(`codex-mcp--v${raised}`);
    expect(pluginTag(raised)).not.toBe(pluginTag(currentVersion()));
  });
});

describe("rotateChangelog", () => {
  const doc = [
    "# Changelog",
    "",
    "## [Unreleased]",
    "",
    "### Added",
    "",
    "- a thing the release ships",
    "",
    "## [2.2.0] - 2026-08-26",
    "",
    "### Added",
    "",
    "- what 2.2.0 shipped",
    "",
  ].join("\n");

  it("moves the whole Unreleased block under the version being cut", () => {
    expect(rotateChangelog(doc, "2.3.0", "2026-08-30")).toBe(
      [
        "# Changelog",
        "",
        "## [Unreleased]",
        "",
        "## [2.3.0] - 2026-08-30",
        "",
        "### Added",
        "",
        "- a thing the release ships",
        "",
        "## [2.2.0] - 2026-08-26",
        "",
        "### Added",
        "",
        "- what 2.2.0 shipped",
        "",
      ].join("\n")
    );
  });

  it("leaves an empty Unreleased behind for the next pull request to write into", () => {
    const rotated = rotateChangelog(doc, "2.3.0", "2026-08-30") as string;
    const unreleased = rotated.slice(
      rotated.indexOf("## [Unreleased]") + "## [Unreleased]".length,
      rotated.indexOf("## [2.3.0]")
    );
    expect(unreleased.trim()).toBe("");
  });

  it("carries a release that wrote no entry as a heading and nothing under it", () => {
    const empty = "# Changelog\n\n## [Unreleased]\n\n## [2.2.0] - 2026-08-26\n\n- old\n";
    expect(rotateChangelog(empty, "2.2.1", "2026-08-30")).toBe(
      "# Changelog\n\n## [Unreleased]\n\n## [2.2.1] - 2026-08-30\n\n## [2.2.0] - 2026-08-26\n\n- old\n"
    );
  });

  it("refuses a changelog with no Unreleased heading", () => {
    expect(() =>
      rotateChangelog("# Changelog\n\n## [2.2.0] - 2026-08-26\n", "2.3.0", "2026-08-30")
    ).toThrow(/carries no ## \[Unreleased\] heading/);
  });

  it("refuses to write a version the changelog already carries", () => {
    expect(() => rotateChangelog(doc, "2.2.0", "2026-08-30")).toThrow(
      /already carries a section for 2\.2\.0/
    );
  });

  it("dates the section in UTC, the day the tag carries", () => {
    expect(today(new Date("2026-08-30T23:30:00Z"))).toBe("2026-08-30");
  });
});

describe("CHANGELOG.md", () => {
  const content = read(CHANGELOG as string);
  const headings = content.split("\n").filter((line) => line.startsWith("## ["));

  it("opens with Unreleased, so a pull request has one place to write into", () => {
    expect(headings[0]).toBe("## [Unreleased]");
  });

  it("gives every released version its own dated section", () => {
    for (const heading of headings.slice(1)) {
      expect(heading).toMatch(/^## \[\d+\.\d+\.\d+\] - \d{4}-\d{2}-\d{2}$/);
    }
  });

  it("holds the sections newest first", () => {
    const rank = (heading: string) => {
      const [major, minor, patch] = heading
        .slice(heading.indexOf("[") + 1, heading.indexOf("]"))
        .split(".")
        .map(Number);
      return major * 1_000_000 + minor * 1_000 + patch;
    };
    const order = headings.slice(1).map(rank);
    expect(order).toEqual([...order].sort((a, b) => b - a));
  });

  it("carries a section for the version the package declares", () => {
    expect(headings.some((heading) => heading.startsWith(`## [${currentVersion()}] -`))).toBe(true);
  });

  it("rotates into a file the next release can rotate again", () => {
    const raised = nextVersion(currentVersion(), "minor") as string;
    const rotated = rotateChangelog(content, raised, today()) as string;
    expect(rotated).toContain(`## [Unreleased]\n\n## [${raised}] - ${today()}`);
    expect(rotated).toContain(`## [${currentVersion()}] -`);
    expect(() => rotateChangelog(rotated, raised, today())).toThrow(/already carries/);
  });
});
