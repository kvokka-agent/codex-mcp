#!/usr/bin/env bun
// Runs the ceilings of `.fallow-gate.jsonc` over what fallow measured and fails
// the run on a file over one. `scripts/lib/fallow-gate.mjs` holds what it
// decides; this file gets fallow to speak and prints the verdict.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describeGate, gateFindings, measuredFiles } from "./lib/fallow-gate.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function runFallow(args) {
  const run = spawnSync("bunx", ["fallow", ...args, "--format", "json"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
  });
  if (run.error) throw run.error;
  if (!run.stdout) throw new Error(`fallow ${args.join(" ")} wrote no report:\n${run.stderr}`);
  const report = JSON.parse(run.stdout);
  if (report.error) throw new Error(`fallow ${args.join(" ")}: ${report.message}`);
  return report;
}

/** Every tracked file the gate covers, whatever fallow made of it. */
function trackedFiles(include, exclude) {
  // `--others` so a file written but not yet staged is measured too: the gate
  // answers on the tree in front of it, not on the last commit.
  const listed = spawnSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    {
      cwd: ROOT,
      encoding: "utf8",
    }
  );
  if (listed.status !== 0) throw new Error(`git ls-files: ${listed.stderr}`);
  const matches = (path, patterns) => patterns.some((glob) => new Bun.Glob(glob).match(path));
  return (
    listed.stdout
      .split("\0")
      .filter(Boolean)
      .filter((path) => matches(path, include) && !matches(path, exclude))
      // git lists a deleted file until the deletion is staged, and there is
      // nothing left to measure in it.
      .filter((path) => existsSync(join(ROOT, path)))
  );
}

const config = require(join(ROOT, ".fallow-gate.jsonc"));
const { include, exclude, churn, ceilings, exceptions } = config;

// `fallow health --hotspots` is asked on its own because the combined run
// hard-codes `--min-commits 3`, which drops a file with fewer commits than that
// out of the churn table entirely.
const files = measuredFiles({
  paths: trackedFiles(include, exclude),
  scores: runFallow(["health", "--file-scores"]).file_scores,
  hotspots: runFallow([
    "health",
    "--hotspots",
    "--since",
    churn.since,
    "--min-commits",
    String(churn.minCommits),
  ]).hotspots,
  readSource: (path) => readFileSync(join(ROOT, path), "utf8"),
});

const findings = gateFindings({ files, ceilings, exceptions });
console.log(describeGate({ files, findings, ceilings, since: churn.since }));
process.exit(findings.failures.length + findings.stale.length === 0 ? 0 : 1);
