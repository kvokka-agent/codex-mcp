#!/usr/bin/env bun
// The rules of the label-driven release: which version follows the current one, which
// label asks for it, which files carry it, and how the changelog's `## [Unreleased]` block
// becomes the section of the version being cut. `.github/workflows/release.yml` calls this
// file; `tests/release.test.ts` measures it against the files themselves.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const LEVELS = ["major", "minor", "patch"];
const LABEL_PREFIX = "release:";

export const CHANGELOG = "CHANGELOG.md";
const UNRELEASED_HEADING = "## [Unreleased]";

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
const VERSION_IN_TEXT = /\d+\.\d+\.\d+/;

// Every place the released version is written. A file that stops matching its
// pattern — moved, renamed, reformatted — fails the bump instead of releasing a
// half-updated tree.
export const TARGETS = [
  // `bun.lock` records the workspace's name and its dependency ranges, not the
  // version of the package itself, so a release moves no lock file.
  { path: "package.json", pattern: /"version": "\d+\.\d+\.\d+"/g, count: 1 },
  {
    path: "plugins/codex-mcp/.claude-plugin/plugin.json",
    pattern: /"version": "\d+\.\d+\.\d+"/g,
    count: 1,
  },
  { path: ".claude-plugin/marketplace.json", pattern: /"version": "\d+\.\d+\.\d+"/g, count: 1 },
  { path: "plugins/codex-mcp/.mcp.json", pattern: /@kvokka\/codex-mcp@\d+\.\d+\.\d+/g, count: 1 },
  {
    path: "plugins/codex-mcp/README.md",
    pattern: /@kvokka\/codex-mcp@\d+\.\d+\.\d+/g,
    count: 1,
  },
];

export function nextVersion(current, level) {
  const parsed = VERSION.exec(current);
  if (!parsed) {
    throw new Error(`the current version is not a release version: ${current}`);
  }
  const [major, minor, patch] = parsed.slice(1).map(Number);
  switch (level) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
    default:
      throw new Error(`unknown release level ${level}, expected one of ${LEVELS.join(", ")}`);
  }
}

// Answers the level the pull request asks for, or null when it asks for no release.
export function releaseLevel(labels) {
  const asked = labels.filter((label) => label.startsWith(LABEL_PREFIX));
  if (asked.length === 0) {
    return null;
  }
  if (asked.length > 1) {
    throw new Error(
      `a pull request carries one release label, this one carries ${asked.join(", ")}`
    );
  }
  const level = asked[0].slice(LABEL_PREFIX.length);
  if (!LEVELS.includes(level)) {
    const known = LEVELS.map((each) => LABEL_PREFIX + each).join(", ");
    throw new Error(`unknown release label ${asked[0]}, expected one of ${known}`);
  }
  return level;
}

export function applyVersion(content, target, version) {
  const found = content.match(target.pattern) ?? [];
  if (found.length !== target.count) {
    throw new Error(
      `${target.path} holds ${found.length} version reference(s), the release expects ${target.count}`
    );
  }
  return content.replace(target.pattern, (hit) => hit.replace(VERSION_IN_TEXT, version));
}

// Claude Code resolves a plugin dependency's version range against tags named
// `{plugin-name}--v{version}` on the repository hosting the plugin, and reads no other
// form: `v{version}` alone leaves a dependent plugin at `no-matching-tag`. The release
// therefore carries both tags on the same commit.
export function pluginTag(version, root = ROOT) {
  const manifest = join(root, "plugins", "codex-mcp", ".claude-plugin", "plugin.json");
  const { name } = JSON.parse(readFileSync(manifest, "utf8"));
  if (!name) {
    throw new Error(`${manifest} carries no plugin name`);
  }
  return `${name}--v${version}`;
}

// The changelog is written into `## [Unreleased]` by the pull requests that land, and the
// release moves that block whole under the version it cuts. `date` is the day the release
// runs, in UTC, which is the day the tag carries.
export function rotateChangelog(content, version, date) {
  const lines = content.split("\n");
  const start = lines.findIndex((line) => line.trim() === UNRELEASED_HEADING);
  if (start === -1) {
    throw new Error(`${CHANGELOG} carries no ${UNRELEASED_HEADING} heading to release`);
  }
  const heading = `## [${version}] - ${date}`;
  if (lines.some((line) => line.startsWith(`## [${version}]`))) {
    throw new Error(`${CHANGELOG} already carries a section for ${version}`);
  }
  const after = lines.findIndex((line, index) => index > start && line.startsWith("## ["));
  const end = after === -1 ? lines.length : after;
  const released = lines
    .slice(start + 1, end)
    .join("\n")
    .trim();
  const rest = lines.slice(end).join("\n");
  const moved = released ? `${heading}\n\n${released}\n` : `${heading}\n`;
  const before = lines.slice(0, start).join("\n");
  return `${before}\n${UNRELEASED_HEADING}\n\n${moved}\n${rest}`;
}

export function currentVersion(root = ROOT) {
  return JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
}

// Every file the release rewrites is read and rewritten in memory before the first one
// reaches disk, so a tree a bump refuses is the tree it found.
function writeRelease(version, date, root = ROOT) {
  const changelog = join(root, CHANGELOG);
  const written = TARGETS.map((target) => {
    const file = join(root, target.path);
    return [file, applyVersion(readFileSync(file, "utf8"), target, version)];
  });
  written.push([changelog, rotateChangelog(readFileSync(changelog, "utf8"), version, date)]);
  for (const [file, content] of written) {
    writeFileSync(file, content);
  }
}

export function today(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function main(argv) {
  const [command, argument] = argv;
  if (command === "level") {
    const level = releaseLevel(JSON.parse(argument ?? "[]"));
    if (level) {
      process.stdout.write(`${level}\n`);
    }
    return;
  }
  if (command === "tag") {
    process.stdout.write(`${pluginTag(argument ?? currentVersion())}\n`);
    return;
  }
  if (command === "bump") {
    const version = nextVersion(currentVersion(), argument);
    writeRelease(version, today());
    process.stdout.write(`${version}\n`);
    return;
  }
  throw new Error(
    `usage: release.mjs level '<labels as a json array>' | release.mjs bump <${LEVELS.join("|")}>` +
      " | release.mjs tag [version]"
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
