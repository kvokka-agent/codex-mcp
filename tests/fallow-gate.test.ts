/**
 * The per-file ceilings the fallow report does not gate on itself.
 *
 * Every asserted value is read out of what the gate returned for the report the
 * test handed it.
 */
import { describe, expect, it } from "bun:test";
// @ts-expect-error -- plain ESM, shared with the script that runs it.
import {
  describeGate,
  gateFailed,
  gateFindings,
  measuredFiles,
} from "../scripts/lib/fallow-gate.mjs";

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

// fallow says the git history churn is read from was whole. A shallow clone
// answers `true` here and a report from a fallow that wrote no hotspot summary
// carries no such object at all.
const WHOLE_HISTORY = { since: "6 months", min_commits: 1, shallow_clone: false };
const SHALLOW = { ...WHOLE_HISTORY, shallow_clone: true };

const SOURCES: Record<string, string> = {
  "src/big.ts": "x\n".repeat(600),
  "src/coupled.ts": "x\n".repeat(40),
  "src/quiet.ts": "x\n".repeat(10),
  "src/types-only.ts": "x\n".repeat(700),
};

function measure(paths: string[], hotspotSummary = WHOLE_HISTORY) {
  return measuredFiles({
    paths,
    scores: SCORES,
    hotspots: HOTSPOTS,
    hotspotSummary,
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

  it("carries no churn out of a shallow clone, whose hotspot table counts one commit", () => {
    const [file] = measure(["src/big.ts"], SHALLOW);
    expect(file.churn).toBeUndefined();
    expect(file.lines).toBe(601);
  });

  it("carries no churn out of a report that wrote no hotspot summary", () => {
    const [file] = measuredFiles({
      paths: ["src/big.ts"],
      scores: SCORES,
      hotspots: HOTSPOTS,
      readSource: (path: string) => SOURCES[path],
    });
    expect(file.churn).toBeUndefined();
  });
});

describe("gateFindings", () => {
  it("fails a file over a ceiling and names the metric", () => {
    const findings = gateFindings({
      files: measure(["src/big.ts", "src/quiet.ts"]),
      ceilings: CEILINGS,
      hotspotSummary: WHOLE_HISTORY,
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
      hotspotSummary: WHOLE_HISTORY,
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
      hotspotSummary: WHOLE_HISTORY,
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
      hotspotSummary: WHOLE_HISTORY,
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
      hotspotSummary: WHOLE_HISTORY,
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
    expect(() =>
      gateFindings({
        files: [],
        ceilings: { indentation: 2 },
        exceptions: [],
        hotspotSummary: WHOLE_HISTORY,
      })
    ).toThrow("unknown ceiling: indentation");
  });

  it("blocks the churn ceiling a shallow clone measured nothing for", () => {
    const files = measure(["src/big.ts"], SHALLOW);
    const findings = gateFindings({
      files,
      ceilings: CEILINGS,
      hotspotSummary: SHALLOW,
      exceptions: [],
    });
    expect(findings.blocked).toEqual([
      { metric: "churn", reason: expect.stringContaining("shallow clone") },
    ]);
    expect(findings.failures.map((finding: { metric: string }) => finding.metric)).toEqual([
      "lines",
    ]);
    expect(gateFailed(findings)).toBe(true);
  });

  it("leaves a churn exception standing while nothing measured churn", () => {
    const files = measure(["src/big.ts"], SHALLOW);
    const findings = gateFindings({
      files,
      ceilings: CEILINGS,
      hotspotSummary: SHALLOW,
      exceptions: [{ path: "src/big.ts", metric: "churn", limit: 1500, reason: "the rewrite" }],
    });
    expect(findings.stale).toEqual([]);
    expect(findings.held).toEqual([]);
  });

  // The churn ceiling is what reads git history; a policy without it has nothing
  // to block over.
  it("blocks nothing when the ceilings name no metric read from history", () => {
    const findings = gateFindings({
      files: measure(["src/big.ts"], SHALLOW),
      ceilings: { lines: 500 },
      hotspotSummary: SHALLOW,
      exceptions: [],
    });
    expect(findings.blocked).toEqual([]);
    expect(gateFailed(findings)).toBe(true);
  });

  it("passes the run when nothing is over a ceiling and every ceiling was measured", () => {
    const findings = gateFindings({
      files: measure(["src/quiet.ts"]),
      ceilings: CEILINGS,
      hotspotSummary: WHOLE_HISTORY,
      exceptions: [],
    });
    expect(gateFailed(findings)).toBe(false);
  });

  it("refuses an exception carrying no reason", () => {
    expect(() =>
      gateFindings({
        files: [],
        ceilings: CEILINGS,
        hotspotSummary: WHOLE_HISTORY,
        exceptions: [{ path: "src/big.ts", metric: "lines", limit: 900 }],
      })
    ).toThrow("with no reason");
  });
});

describe("describeGate", () => {
  it("names every failure and how many there are", () => {
    const files = measure(["src/big.ts", "src/coupled.ts"]);
    const findings = gateFindings({
      files,
      ceilings: CEILINGS,
      exceptions: [],
      hotspotSummary: WHOLE_HISTORY,
    });
    const text = describeGate({ files, findings, ceilings: CEILINGS, since: "6m" });
    expect(text).toContain("2 files measured");
    expect(text).toContain("src/coupled.ts  fan-out 22 (ceiling 15)");
    expect(text).toContain("src/coupled.ts  density 0.90 (ceiling 0.7)");
    expect(text).toContain("4 file(s) over a ceiling");
  });

  it("says the tree is clean when nothing is over a ceiling", () => {
    const files = measure(["src/quiet.ts"]);
    const findings = gateFindings({
      files,
      ceilings: CEILINGS,
      exceptions: [],
      hotspotSummary: WHOLE_HISTORY,
    });
    expect(describeGate({ files, findings, ceilings: CEILINGS, since: "6m" })).toContain(
      "every file is inside its ceilings"
    );
  });

  it("prints a held failure with the reason it is allowed", () => {
    const files = measure(["src/big.ts"]);
    const findings = gateFindings({
      files,
      ceilings: CEILINGS,
      hotspotSummary: WHOLE_HISTORY,
      exceptions: [
        { path: "src/big.ts", metric: "lines", limit: 700, reason: "one zod schema" },
        { path: "src/big.ts", metric: "churn", limit: 1500, reason: "the 3.0.0 rewrite" },
      ],
    });
    const text = describeGate({ files, findings, ceilings: CEILINGS, since: "6m" });
    expect(text).toContain("~ src/big.ts LOC 601 allowed to 700: one zod schema");
    expect(text).toContain("every file is inside its ceilings");
  });

  it("names the missing measurement and how to give it", () => {
    const files = measure(["src/quiet.ts"], SHALLOW);
    const findings = gateFindings({
      files,
      ceilings: CEILINGS,
      hotspotSummary: SHALLOW,
      exceptions: [],
    });
    const text = describeGate({ files, findings, ceilings: CEILINGS, since: "6m" });
    expect(text).toContain("churn is not measured here");
    expect(text).toContain("fetch-depth: 0");
    expect(text).toContain("1 ceiling(s) nothing measured");
    expect(text).not.toContain("every file is inside its ceilings");
  });
});
