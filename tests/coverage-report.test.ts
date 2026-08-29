/**
 * The lcov-to-Istanbul conversion that gives fallow exact CRAP scores.
 *
 * Every asserted value is read out of what the converter returned for the lcov
 * text the test handed it.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
// @ts-expect-error -- plain ESM, shared with the script that runs it.
import { lcovToIstanbul, writeIstanbulReport } from "../scripts/lib/lcov-istanbul.mjs";

const ROOT = "/repo";

function convert(lcov: string): Record<string, IstanbulFile> {
  return lcovToIstanbul(lcov, ROOT) as Record<string, IstanbulFile>;
}

type IstanbulFile = {
  path: string;
  statementMap: Record<
    string,
    { start: { line: number; column: number }; end: { line: number; column: number } }
  >;
  fnMap: Record<string, unknown>;
  branchMap: Record<string, unknown>;
  s: Record<string, number>;
  f: Record<string, unknown>;
  b: Record<string, unknown>;
};

describe("lcovToIstanbul", () => {
  it("keys each record by the absolute path of its SF line", () => {
    const coverage = convert(["TN:", "SF:src/a.ts", "DA:1,3", "end_of_record", ""].join("\n"));

    expect(Object.keys(coverage)).toEqual([resolve(ROOT, "src/a.ts")]);
    expect(coverage[resolve(ROOT, "src/a.ts")]?.path).toBe(resolve(ROOT, "src/a.ts"));
  });

  it("turns every DA line into one statement carrying that line's hit count", () => {
    const coverage = convert(["SF:src/a.ts", "DA:6,54", "DA:7,0", "end_of_record"].join("\n"));

    const file = coverage[resolve(ROOT, "src/a.ts")] as IstanbulFile;
    expect(file.statementMap).toEqual({
      "0": { start: { line: 6, column: 0 }, end: { line: 6, column: 0 } },
      "1": { start: { line: 7, column: 0 }, end: { line: 7, column: 0 } },
    });
    expect(file.s).toEqual({ "0": 54, "1": 0 });
  });

  it("leaves the function and branch maps empty, because bun reports neither", () => {
    const coverage = convert(
      ["SF:src/a.ts", "FNF:9", "FNH:7", "DA:1,1", "LF:1", "LH:1", "end_of_record"].join("\n")
    );

    const file = coverage[resolve(ROOT, "src/a.ts")] as IstanbulFile;
    expect(file.fnMap).toEqual({});
    expect(file.branchMap).toEqual({});
    expect(file.f).toEqual({});
    expect(file.b).toEqual({});
    expect(Object.keys(file.s)).toEqual(["0"]);
  });

  it("starts a fresh statement numbering for each record", () => {
    const coverage = convert(
      [
        "SF:src/a.ts",
        "DA:1,1",
        "DA:2,2",
        "end_of_record",
        "SF:src/b.ts",
        "DA:9,4",
        "end_of_record",
      ].join("\n")
    );

    expect(coverage[resolve(ROOT, "src/b.ts")]?.s).toEqual({ "0": 4 });
  });

  it("drops a DA line that stands outside any record", () => {
    const coverage = convert(["DA:1,1", "SF:src/a.ts", "end_of_record", "DA:2,2"].join("\n"));

    expect(coverage[resolve(ROOT, "src/a.ts")]?.s).toEqual({});
  });

  it("returns an empty map for an empty report", () => {
    expect(convert("")).toEqual({});
  });
});

describe("writeIstanbulReport", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function projectWithLcov(lcov: string): string {
    const root = mkdtempSync(join(tmpdir(), "codex-mcp-lcov-"));
    roots.push(root);
    mkdirSync(join(root, "coverage"));
    writeFileSync(join(root, "coverage", "lcov.info"), lcov, "utf8");
    return root;
  }

  it("writes the converted report beside the lcov it read", () => {
    const root = projectWithLcov(["SF:src/a.ts", "DA:4,7", "end_of_record", ""].join("\n"));

    const written = writeIstanbulReport(root) as { path: string; files: number };

    expect(written.path).toBe(join(root, "coverage", "coverage-final.json"));
    expect(written.files).toBe(1);
    expect(JSON.parse(readFileSync(written.path, "utf8"))).toEqual({
      [join(root, "src", "a.ts")]: {
        path: join(root, "src", "a.ts"),
        statementMap: { "0": { start: { line: 4, column: 0 }, end: { line: 4, column: 0 } } },
        fnMap: {},
        branchMap: {},
        s: { "0": 7 },
        f: {},
        b: {},
      },
    });
  });

  it("counts every record of the report it wrote", () => {
    const root = projectWithLcov(
      ["SF:src/a.ts", "end_of_record", "SF:src/b.ts", "end_of_record"].join("\n")
    );

    expect((writeIstanbulReport(root) as { files: number }).files).toBe(2);
  });
});
