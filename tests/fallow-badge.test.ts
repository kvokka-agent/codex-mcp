/**
 * The shields.io endpoint document the README's fallow badge is drawn from.
 *
 * Every asserted value is what the module returned for the report, the health
 * score or the file the test handed it.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error -- plain ESM, shared with the script that runs it.
import {
  BADGE_PATH,
  badgeDocument,
  badgeEndpoint,
  badgeUpdate,
  readHealthScore,
} from "../scripts/lib/fallow-badge.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

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

describe("badgeEndpoint", () => {
  it("names the label, the grade and the rounded score shields draws", () => {
    expect(badgeEndpoint({ score: 95.2, grade: "A" })).toEqual({
      schemaVersion: 1,
      label: "fallow",
      message: "A (95)",
      color: "brightgreen",
    });
  });

  it("rounds the score rather than cutting it", () => {
    expect(badgeEndpoint({ score: 69.6, grade: "C" }).message).toBe("C (70)");
  });

  it("gives every grade fallow hands out its own colour", () => {
    expect(GRADES.map((grade) => badgeEndpoint({ score: 50, grade }).color)).toEqual([
      "brightgreen",
      "green",
      "yellow",
      "orange",
      "red",
    ]);
  });

  it("refuses a grade no colour is named for", () => {
    expect(() => badgeEndpoint({ score: 50, grade: "E" })).toThrow("no colour is named for: E");
  });

  it("refuses a health score carrying no number", () => {
    expect(() => badgeEndpoint({ score: null, grade: "A" })).toThrow("no score");
  });
});

describe("badgeDocument", () => {
  it("writes the endpoint object as a file git can diff", () => {
    const document = badgeDocument({ score: 41.4, grade: "D" });

    expect(document.endsWith("\n")).toBe(true);
    expect(JSON.parse(document)).toEqual(badgeEndpoint({ score: 41.4, grade: "D" }));
  });
});

describe("badgeUpdate", () => {
  const document = badgeDocument({ score: 95.2, grade: "A" });

  it("leaves the file alone when it already carries this score", () => {
    expect(badgeUpdate({ path: BADGE_PATH, document, current: document })).toEqual({
      changed: false,
      text: `${BADGE_PATH} already reads A (95).`,
    });
  });

  it("rewrites the file when the score moved", () => {
    const current = badgeDocument({ score: 71.2, grade: "B" });

    expect(badgeUpdate({ path: BADGE_PATH, document, current })).toEqual({
      changed: true,
      text: `${BADGE_PATH} now reads A (95).`,
    });
  });

  it("writes the file when there is none", () => {
    expect(badgeUpdate({ path: BADGE_PATH, document, current: null }).changed).toBe(true);
  });
});

describe("the committed badge", () => {
  const committed = read(BADGE_PATH);
  const endpoint = JSON.parse(committed) as { message: string };
  // The score the file was written from, read back out of what it shows.
  const [, grade, score] = /^([A-F]) \((\d+)\)$/.exec(endpoint.message) ?? [];

  it("is byte for byte what this module writes for the score it shows", () => {
    expect(committed).toBe(badgeDocument({ grade, score: Number(score) }));
  });

  it("is the file the README badge points shields at", () => {
    expect(read("README.md")).toContain(
      `https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/kvokka/codex-mcp/master/${BADGE_PATH}`
    );
  });
});
