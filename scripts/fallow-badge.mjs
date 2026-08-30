#!/usr/bin/env bun
// Writes the shields.io endpoint document the README badge is drawn from, out
// of what `fallow health --hotspots --score` measured.
// `scripts/lib/fallow-badge.mjs` holds what it decides; this file gets fallow to
// speak and writes the file.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { BADGE_PATH, badgeDocument, badgeUpdate, readHealthScore } from "./lib/fallow-badge.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const file = join(ROOT, BADGE_PATH);

/** The file's bytes, or null where there is no file. Any other failure stands. */
function readCurrent(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

// `fallow health` scores against the coverage report `.fallowrc.jsonc` names
// and fails without it, so `bun run coverage` runs before this.
const run = spawnSync("bunx", ["fallow", "health", "--hotspots", "--score", "--format", "json"], {
  cwd: ROOT,
  encoding: "utf8",
  maxBuffer: 512 * 1024 * 1024,
});
if (run.error) throw run.error;
if (!run.stdout) throw new Error(`fallow health wrote no report:\n${run.stderr}`);

const document = badgeDocument(readHealthScore(JSON.parse(run.stdout)));
const update = badgeUpdate({ path: BADGE_PATH, document, current: readCurrent(file) });
if (update.changed) writeFileSync(file, document);
console.log(update.text);
