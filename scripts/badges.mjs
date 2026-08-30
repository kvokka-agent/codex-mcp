#!/usr/bin/env bun
// The two shields.io endpoint documents the README badges are drawn from.
//
//   bun scripts/badges.mjs measure        measures this tree and writes both files
//   bun scripts/badges.mjs write <json>…  writes documents another run measured
//
// `measure` prints each document to stdout as one `$GITHUB_OUTPUT` line and
// what it did to the files to stderr, so `bun run badge >> "$GITHUB_OUTPUT"`
// hands what the check job measured to the release job that commits it.
// scripts/lib/ holds what all of this decides; this file runs fallow, reads the
// coverage report and touches the files.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  badgeDocument,
  badgeOutput,
  badgePath,
  badgeUpdate,
  parseEndpoint,
} from "./lib/badge-file.mjs";
import { coverageEndpoint, coverageTotals } from "./lib/coverage-badge.mjs";
import { fallowEndpoint, readHealthScore } from "./lib/fallow-badge.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The file's bytes, or null where there is no file. Any other failure stands. */
function readCurrent(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function writeBadge(endpoint) {
  const path = badgePath(endpoint);
  const document = badgeDocument(endpoint);
  const update = badgeUpdate({ path, document, current: readCurrent(join(ROOT, path)) });
  if (update.changed) writeFileSync(join(ROOT, path), document);
  console.error(update.text);
}

function fallowHealth() {
  // `fallow health` scores against the coverage report `.fallowrc.jsonc` names
  // and fails without it, so `bun run coverage` runs before this.
  const run = spawnSync("bunx", ["fallow", "health", "--hotspots", "--score", "--format", "json"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
  });
  if (run.error) throw run.error;
  if (!run.stdout) throw new Error(`fallow health wrote no report:\n${run.stderr}`);
  return JSON.parse(run.stdout);
}

/** The Istanbul report fallow scores against, read from where fallow is told to find it. */
function coverageReport() {
  const { health } = require(join(ROOT, ".fallowrc.jsonc"));
  return JSON.parse(readFileSync(join(ROOT, health.coverage), "utf8"));
}

function measure() {
  return [
    fallowEndpoint(readHealthScore(fallowHealth())),
    coverageEndpoint(coverageTotals(coverageReport(), ROOT)),
  ];
}

function main([command, ...documents]) {
  if (command === "measure") {
    for (const endpoint of measure()) {
      writeBadge(endpoint);
      process.stdout.write(`${badgeOutput(endpoint)}\n`);
    }
    return;
  }
  if (command === "write" && documents.length > 0) {
    for (const document of documents) writeBadge(parseEndpoint(document));
    return;
  }
  throw new Error("usage: badges.mjs measure | badges.mjs write '<endpoint json>'...");
}

main(process.argv.slice(2));
