/**
 * The share of lines and functions the README's coverage badge shows.
 *
 * Every asserted value is what the module returned for the coverage report or
 * the totals the test handed it.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error -- plain ESM, shared with the script that runs it.
import { BADGES, badgeDocument } from "../scripts/lib/badge-file.mjs";
// @ts-expect-error -- plain ESM, shared with the script that runs it.
import { coverageEndpoint, coverageTotals } from "../scripts/lib/coverage-badge.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = "/repo";

type Share = { covered: number; total: number };
type Totals = { lines: Share; functions: Share };

/** One file of an Istanbul report: `s` is a hit count per line, `f` one per function. */
function file(lines: number[], functions: number[]) {
  return {
    s: Object.fromEntries(lines.map((hits, id) => [String(id), hits])),
    f: Object.fromEntries(functions.map((hits, id) => [String(id), hits])),
  };
}

const totals = (report: Record<string, unknown>) => coverageTotals(report, REPO) as Totals;

/** The totals of a tree at exactly these percentages. */
const at = (lines: number, functions: number): Totals => ({
  lines: { covered: lines, total: 100 },
  functions: { covered: functions, total: 100 },
});

describe("coverageTotals", () => {
  it("counts the measured lines and functions, and the ones the tests entered", () => {
    const report = {
      [resolve(REPO, "src/a.ts")]: file([4, 0, 7], [4, 0]),
      [resolve(REPO, "scripts/lib/b.mjs")]: file([1, 1], [1]),
    };

    expect(totals(report)).toEqual({
      lines: { covered: 4, total: 5 },
      functions: { covered: 2, total: 3 },
    });
  });

  // A test imports its helpers, so bun measures them along with the code under
  // test; `.fallowrc.jsonc` leaves `tests/**` out of the health score for the
  // same reason.
  it("counts out the test helpers a test dragged into the report", () => {
    const report = {
      [resolve(REPO, "src/a.ts")]: file([1, 0], [1]),
      [resolve(REPO, "tests/helpers/clock.ts")]: file([1, 1, 1, 1], [1, 1]),
    };

    expect(totals(report)).toEqual({
      lines: { covered: 1, total: 2 },
      functions: { covered: 1, total: 1 },
    });
  });

  it("refuses a report holding nothing of this repository", () => {
    expect(() => totals({ [resolve(REPO, "tests/helpers/clock.ts")]: file([1], [1]) })).toThrow(
      "measured no line"
    );
  });
});

describe("coverageEndpoint", () => {
  it("names both shares shields draws, and the label the badge carries", () => {
    expect(coverageEndpoint(at(94, 91))).toEqual({
      schemaVersion: 1,
      label: "coverage",
      message: "94% lines, 91% functions",
      color: "green",
    });
  });

  // Floored, so the badge never claims a share the tree does not carry: the
  // gate demands 90 and 89.6% is under it.
  it("floors a share rather than rounding it up over the gate", () => {
    const measured = {
      lines: { covered: 896, total: 1000 },
      functions: { covered: 999, total: 1000 },
    };

    expect(coverageEndpoint(measured).message).toBe("89% lines, 99% functions");
  });

  it("reads the colour off the lower of the two shares", () => {
    expect(coverageEndpoint(at(99, 89)).color).toBe("red");
    expect(coverageEndpoint(at(89, 99)).color).toBe("red");
  });

  it("gives each band above the gate its own colour", () => {
    expect([95, 94, 90, 89, 0].map((share) => coverageEndpoint(at(share, share)).color)).toEqual([
      "brightgreen",
      "green",
      "green",
      "red",
      "red",
    ]);
  });
});

describe("the committed badge", () => {
  const committed = readFileSync(join(ROOT, BADGES.coverage as string), "utf8");
  const message = (JSON.parse(committed) as { message: string }).message;
  // The shares the file was written from, read back out of what it shows.
  const [, lines, functions] = /^(\d+)% lines, (\d+)% functions$/.exec(message) ?? [];

  it("is byte for byte what this module writes for the shares it shows", () => {
    expect(committed).toBe(badgeDocument(coverageEndpoint(at(Number(lines), Number(functions)))));
  });
});
