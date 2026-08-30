/**
 * The health score the README's fallow badge is drawn from.
 *
 * Every asserted value is what the module returned for the report or the health
 * score the test handed it.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error -- plain ESM, shared with the script that runs it.
import { BADGES, badgeDocument } from "../scripts/lib/badge-file.mjs";
// @ts-expect-error -- plain ESM, shared with the script that runs it.
import { fallowEndpoint, readHealthScore } from "../scripts/lib/fallow-badge.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Every grade fallow's `letter_grade` hands out: A >= 85, B >= 70, C >= 55,
// D >= 40, F below.
const GRADES = ["A", "B", "C", "D", "F"];

// What `fallow health --hotspots --score --format json` answered over this
// repository: the hotspot penalty is in `penalties` and the history behind it
// was whole.
const SCORED = {
  kind: "health",
  health_score: { score: 85.2, grade: "A", penalties: { hotspots: 10.0, coupling: 2.2 } },
  hotspot_summary: { since: "6 months", min_commits: 3, files_analyzed: 43, shallow_clone: false },
};

describe("readHealthScore", () => {
  it("returns the score section of a health report", () => {
    const health = readHealthScore(SCORED);

    expect(health).toEqual(SCORED.health_score);
  });

  // `fallow health` scores against the coverage report `.fallowrc.jsonc` names
  // and answers `{"error": true, …}` on stdout when it cannot read it.
  it("carries through the failure fallow reported instead of a score", () => {
    expect(() =>
      readHealthScore({ error: true, message: "coverage: failed to read coverage file" })
    ).toThrow("fallow health: coverage: failed to read coverage file");
  });

  it("refuses a report carrying no score at all", () => {
    expect(() => readHealthScore({ kind: "health" })).toThrow("no health_score");
  });

  // A run without `--hotspots` scores 95.2 here against the 85.2 the full
  // analysis prints, and the only place it says so is the missing key.
  it("refuses a score whose penalties never weighed the hotspots", () => {
    expect(() =>
      readHealthScore({
        kind: "health",
        health_score: { score: 95.2, grade: "A", penalties: { coupling: 2.2 } },
      })
    ).toThrow("ask for it with --hotspots");
  });

  it("refuses a hotspot penalty read out of a clone with no history", () => {
    expect(() =>
      readHealthScore({
        ...SCORED,
        health_score: { score: 95.2, grade: "A", penalties: { hotspots: 0.0, coupling: 2.2 } },
        hotspot_summary: { ...SCORED.hotspot_summary, files_analyzed: 0, shallow_clone: true },
      })
    ).toThrow("shallow clone");
  });
});

describe("fallowEndpoint", () => {
  it("names the label, the grade and the rounded score shields draws", () => {
    expect(fallowEndpoint({ score: 95.2, grade: "A" })).toEqual({
      schemaVersion: 1,
      label: "fallow",
      message: "A (95)",
      color: "brightgreen",
    });
  });

  it("rounds the score rather than cutting it", () => {
    expect(fallowEndpoint({ score: 69.6, grade: "C" }).message).toBe("C (70)");
  });

  it("gives every grade fallow hands out its own colour", () => {
    expect(GRADES.map((grade) => fallowEndpoint({ score: 50, grade }).color)).toEqual([
      "brightgreen",
      "green",
      "yellow",
      "orange",
      "red",
    ]);
  });

  it("refuses a grade no colour is named for", () => {
    expect(() => fallowEndpoint({ score: 50, grade: "E" })).toThrow("no colour is named for: E");
  });

  it("refuses a health score carrying no number", () => {
    expect(() => fallowEndpoint({ score: null, grade: "A" })).toThrow("no score");
  });
});

describe("the committed badge", () => {
  const committed = readFileSync(join(ROOT, BADGES.fallow as string), "utf8");
  const message = (JSON.parse(committed) as { message: string }).message;
  // The score the file was written from, read back out of what it shows.
  const [, grade, score] = /^([A-F]) \((\d+)\)$/.exec(message) ?? [];

  it("is byte for byte what this module writes for the score it shows", () => {
    expect(committed).toBe(badgeDocument(fallowEndpoint({ grade, score: Number(score) })));
  });
});
