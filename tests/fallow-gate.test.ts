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

const CEILINGS = { lines: 500, fanOut: 15, complexityDensity: 0.7 };

const SCORES = [
  { path: "src/big.ts", fan_out: 3, complexity_density: 0.2 },
  { path: "src/coupled.ts", fan_out: 22, complexity_density: 0.9 },
  { path: "src/quiet.ts", fan_out: 1, complexity_density: 0.1 },
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
    readSource: (path: string) => SOURCES[path],
  });
}

describe("measuredFiles", () => {
  it("counts the lines of a file fallow never scored", () => {
    const [file] = measure(["src/types-only.ts"]);
    expect(file.lines).toBe(701);
    expect(file.fan_out).toBeUndefined();
  });

  it("carries the score fallow gave a path alongside the lines it counted", () => {
    const [file] = measure(["src/big.ts"]);
    expect(file.lines).toBe(601);
    expect(file.fan_out).toBe(3);
    expect(file.complexity_density).toBe(0.2);
  });
});

describe("gateFindings", () => {
  it("fails a file over a ceiling and names the metric", () => {
    const findings = gateFindings({
      files: measure(["src/coupled.ts", "src/quiet.ts"]),
      ceilings: CEILINGS,
      exceptions: [],
    });
    expect(findings.failures).toEqual([
      { path: "src/coupled.ts", metric: "fanOut", value: 22, limit: 15 },
      { path: "src/coupled.ts", metric: "complexityDensity", value: 0.9, limit: 0.7 },
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
      exceptions: [{ path: "src/big.ts", metric: "lines", limit: 700, reason: "one zod schema" }],
    });
    expect(findings.failures).toEqual([]);
    expect(findings.held).toEqual([
      { path: "src/big.ts", metric: "lines", value: 601, limit: 700, reason: "one zod schema" },
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
    expect(gateFailed(findings)).toBe(true);
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

  it("refuses an exception on a ceiling no metric answers to", () => {
    expect(() =>
      gateFindings({
        files: [],
        ceilings: CEILINGS,
        exceptions: [{ path: "src/big.ts", metric: "indentation", limit: 4, reason: "deep" }],
      })
    ).toThrow("excepts an unknown ceiling: indentation");
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

  it("passes the run when nothing is over a ceiling", () => {
    const findings = gateFindings({
      files: measure(["src/quiet.ts"]),
      ceilings: CEILINGS,
      exceptions: [],
    });
    expect(gateFailed(findings)).toBe(false);
  });
});

describe("describeGate", () => {
  it("names every failure and how many there are", () => {
    const files = measure(["src/big.ts", "src/coupled.ts"]);
    const findings = gateFindings({ files, ceilings: CEILINGS, exceptions: [] });
    const text = describeGate({ files, findings, ceilings: CEILINGS });
    expect(text).toContain("2 files measured · LOC <= 500 · fan-out <= 15 · density <= 0.7");
    expect(text).toContain("src/big.ts  LOC 601 (ceiling 500)");
    expect(text).toContain("src/coupled.ts  fan-out 22 (ceiling 15)");
    expect(text).toContain("src/coupled.ts  density 0.90 (ceiling 0.7)");
    expect(text).toContain("3 file(s) over a ceiling");
  });

  it("names a stale exception and tells the reader to drop it", () => {
    const files = measure(["src/quiet.ts"]);
    const findings = gateFindings({
      files,
      ceilings: CEILINGS,
      exceptions: [{ path: "src/quiet.ts", metric: "lines", limit: 900, reason: "was long" }],
    });
    const text = describeGate({ files, findings, ceilings: CEILINGS });
    expect(text).toContain("the lines exception for src/quiet.ts holds nothing back — drop it");
    expect(text).toContain("1 stale exception(s)");
    expect(text).not.toContain("every file is inside its ceilings");
  });

  it("says the tree is clean when nothing is over a ceiling", () => {
    const files = measure(["src/quiet.ts"]);
    const findings = gateFindings({ files, ceilings: CEILINGS, exceptions: [] });
    expect(describeGate({ files, findings, ceilings: CEILINGS })).toContain(
      "every file is inside its ceilings"
    );
  });

  it("prints a held failure with the reason it is allowed", () => {
    const files = measure(["src/big.ts"]);
    const findings = gateFindings({
      files,
      ceilings: CEILINGS,
      exceptions: [{ path: "src/big.ts", metric: "lines", limit: 700, reason: "one zod schema" }],
    });
    const text = describeGate({ files, findings, ceilings: CEILINGS });
    expect(text).toContain("~ src/big.ts LOC 601 allowed to 700: one zod schema");
    expect(text).toContain("every file is inside its ceilings");
  });
});
