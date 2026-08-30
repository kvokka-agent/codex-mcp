/**
 * The per-file ceilings the fallow report does not gate on itself.
 *
 * Every asserted value is read out of what the gate returned for the report the
 * test handed it.
 */
import { describe, expect, it } from "bun:test";
// @ts-expect-error -- plain ESM, shared with the script that runs it.
import { describeGate, gateFindings, measuredFiles } from "../scripts/lib/fallow-gate.mjs";

const CEILINGS = { lines: 500, fanOut: 15, complexityDensity: 0.7, churn: 1000 };

const SCORES = [
  { path: "src/big.ts", fan_out: 3, complexity_density: 0.2 },
  { path: "src/coupled.ts", fan_out: 22, complexity_density: 0.9 },
  { path: "src/quiet.ts", fan_out: 1, complexity_density: 0.1 },
];

const HOTSPOTS = [
  { path: "src/big.ts", lines_added: 900, lines_deleted: 400 },
  { path: "src/coupled.ts", lines_added: 10, lines_deleted: 2 },
];

const SOURCES: Record<string, string> = {
  "src/big.ts": "x\n".repeat(600),
  "src/coupled.ts": "x\n".repeat(40),
  "src/quiet.ts": "x\n".repeat(10),
  "src/types-only.ts": "x\n".repeat(700),
};

function measure(paths: string[]) {
  return measuredFiles({
    paths,
    scores: SCORES,
    hotspots: HOTSPOTS,
    readSource: (path: string) => SOURCES[path],
  });
}

describe("measuredFiles", () => {
  it("counts the lines of a file fallow never scored", () => {
    const [file] = measure(["src/types-only.ts"]);
    expect(file.lines).toBe(701);
    expect(file.fan_out).toBeUndefined();
  });

  it("reads churn as the lines a path gained and lost", () => {
    const [file] = measure(["src/big.ts"]);
    expect(file.churn).toBe(1300);
    expect(file.fan_out).toBe(3);
  });

  it("gives a path outside the hotspot table no churn", () => {
    const [file] = measure(["src/quiet.ts"]);
    expect(file.churn).toBe(0);
  });
});

describe("gateFindings", () => {
  it("fails a file over a ceiling and names the metric", () => {
    const findings = gateFindings({
      files: measure(["src/big.ts", "src/quiet.ts"]),
      ceilings: CEILINGS,
      exceptions: [],
    });
    expect(findings.failures).toEqual([
      { path: "src/big.ts", metric: "lines", value: 601, limit: 500 },
      { path: "src/big.ts", metric: "churn", value: 1300, limit: 1000 },
    ]);
  });

  it("skips a metric the report carries no number for", () => {
    const findings = gateFindings({
      files: measure(["src/types-only.ts"]),
      ceilings: CEILINGS,
      exceptions: [],
    });
    expect(findings.failures.map((finding: { metric: string }) => finding.metric)).toEqual([
      "lines",
    ]);
  });

  it("holds a failure back under an exception and carries its reason", () => {
    const findings = gateFindings({
      files: measure(["src/big.ts"]),
      ceilings: CEILINGS,
      exceptions: [
        { path: "src/big.ts", metric: "churn", limit: 1500, reason: "the 3.0.0 rewrite" },
        { path: "src/big.ts", metric: "lines", limit: 700, reason: "one zod schema" },
      ],
    });
    expect(findings.failures).toEqual([]);
    expect(findings.held).toEqual([
      { path: "src/big.ts", metric: "lines", value: 601, limit: 700, reason: "one zod schema" },
      {
        path: "src/big.ts",
        metric: "churn",
        value: 1300,
        limit: 1500,
        reason: "the 3.0.0 rewrite",
      },
    ]);
    expect(findings.stale).toEqual([]);
  });

  it("fails an exception the file no longer needs", () => {
    const findings = gateFindings({
      files: measure(["src/quiet.ts"]),
      ceilings: CEILINGS,
      exceptions: [{ path: "src/quiet.ts", metric: "lines", limit: 900, reason: "was long" }],
    });
    expect(findings.stale).toEqual([
      { path: "src/quiet.ts", metric: "lines", limit: 900, reason: "was long" },
    ]);
  });

  it("still fails a file whose exception is under what it measures", () => {
    const findings = gateFindings({
      files: measure(["src/big.ts"]),
      ceilings: CEILINGS,
      exceptions: [{ path: "src/big.ts", metric: "lines", limit: 550, reason: "shrinking" }],
    });
    expect(findings.failures).toContainEqual({
      path: "src/big.ts",
      metric: "lines",
      value: 601,
      limit: 550,
    });
  });

  it("refuses a ceiling no metric answers to", () => {
    expect(() => gateFindings({ files: [], ceilings: { indentation: 2 }, exceptions: [] })).toThrow(
      "unknown ceiling: indentation"
    );
  });

  it("refuses an exception carrying no reason", () => {
    expect(() =>
      gateFindings({
        files: [],
        ceilings: CEILINGS,
        exceptions: [{ path: "src/big.ts", metric: "lines", limit: 900 }],
      })
    ).toThrow("with no reason");
  });
});

describe("describeGate", () => {
  it("names every failure and how many there are", () => {
    const files = measure(["src/big.ts", "src/coupled.ts"]);
    const findings = gateFindings({ files, ceilings: CEILINGS, exceptions: [] });
    const text = describeGate({ files, findings, ceilings: CEILINGS, since: "6m" });
    expect(text).toContain("2 files measured");
    expect(text).toContain("src/coupled.ts  fan-out 22 (ceiling 15)");
    expect(text).toContain("src/coupled.ts  density 0.90 (ceiling 0.7)");
    expect(text).toContain("4 file(s) over a ceiling");
  });

  it("says the tree is clean when nothing is over a ceiling", () => {
    const files = measure(["src/quiet.ts"]);
    const findings = gateFindings({ files, ceilings: CEILINGS, exceptions: [] });
    expect(describeGate({ files, findings, ceilings: CEILINGS, since: "6m" })).toContain(
      "every file is inside its ceilings"
    );
  });

  it("prints a held failure with the reason it is allowed", () => {
    const files = measure(["src/big.ts"]);
    const findings = gateFindings({
      files,
      ceilings: CEILINGS,
      exceptions: [
        { path: "src/big.ts", metric: "lines", limit: 700, reason: "one zod schema" },
        { path: "src/big.ts", metric: "churn", limit: 1500, reason: "the 3.0.0 rewrite" },
      ],
    });
    const text = describeGate({ files, findings, ceilings: CEILINGS, since: "6m" });
    expect(text).toContain("~ src/big.ts LOC 601 allowed to 700: one zod schema");
    expect(text).toContain("every file is inside its ceilings");
  });
});
