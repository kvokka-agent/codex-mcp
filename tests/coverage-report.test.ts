/**
 * The lcov-to-Istanbul conversion that gives fallow exact CRAP scores.
 *
 * Every asserted value is read out of what the converter returned for the lcov
 * text and the source the test handed it.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
// @ts-expect-error -- plain ESM, shared with the script that runs it.
import {
  lcovToIstanbul,
  sourceFunctions,
  writeIstanbulReport,
} from "../scripts/lib/lcov-istanbul.mjs";

const ROOT = "/repo";

/** Line 1 is `add`; the class holds a constructor, a method, an arrow, an empty body. */
const SOURCE = [
  "export function add(a: number, b: number): number {",
  "  return a + b;",
  "}",
  "",
  "export class Counter {",
  "  constructor(private value: number) {",
  "    this.value = value;",
  "  }",
  "",
  "  bump(): () => void {",
  "    return () => {",
  "      this.value += 1;",
  "    };",
  "  }",
  "",
  "  noop(): void {}",
  "}",
  "",
].join("\n");

type Location = { start: { line: number; column: number }; end: { line: number; column: number } };

type IstanbulFile = {
  path: string;
  statementMap: Record<string, Location>;
  fnMap: Record<string, { name: string; decl: Location; loc: Location; line: number }>;
  branchMap: Record<string, unknown>;
  s: Record<string, number>;
  f: Record<string, number>;
  b: Record<string, unknown>;
};

type SourceFunction = { name: string; declLine: number; startLine: number; endLine: number };

/** Converts against a one-file project whose only source is {@link SOURCE}. */
function convert(lcov: string, source = SOURCE): Record<string, IstanbulFile> {
  return lcovToIstanbul(lcov, ROOT, () => source) as Record<string, IstanbulFile>;
}

function fileOf(coverage: Record<string, IstanbulFile>, relative: string): IstanbulFile {
  return coverage[resolve(ROOT, relative)] as IstanbulFile;
}

describe("sourceFunctions", () => {
  it("reports every function of the file in source order, with its body span", () => {
    expect(sourceFunctions(SOURCE, "/repo/src/a.ts") as SourceFunction[]).toEqual([
      { name: "add", declLine: 1, startLine: 1, endLine: 3 },
      { name: "constructor", declLine: 6, startLine: 6, endLine: 8 },
      { name: "bump", declLine: 10, startLine: 10, endLine: 14 },
      { name: "(anonymous_0)", declLine: 11, startLine: 11, endLine: 13 },
      { name: "noop", declLine: 16, startLine: 16, endLine: 16 },
    ]);
  });

  it("parses a .mjs file as JavaScript", () => {
    const source = ["export const wrap = (value) => {", "  return [value];", "};", ""].join("\n");

    expect(sourceFunctions(source, "/repo/scripts/lib/wrap.mjs") as SourceFunction[]).toEqual([
      { name: "(anonymous_0)", declLine: 1, startLine: 1, endLine: 3 },
    ]);
  });

  it("skips a declaration that carries no body", () => {
    const source = ["export declare function ping(): void;", ""].join("\n");

    expect(sourceFunctions(source, "/repo/src/a.ts") as SourceFunction[]).toEqual([]);
  });
});

describe("lcovToIstanbul", () => {
  it("keys each record by the absolute path of its SF line", () => {
    const coverage = convert(["TN:", "SF:src/a.ts", "DA:2,3", "end_of_record", ""].join("\n"));

    expect(Object.keys(coverage)).toEqual([resolve(ROOT, "src/a.ts")]);
    expect(fileOf(coverage, "src/a.ts").path).toBe(resolve(ROOT, "src/a.ts"));
  });

  it("turns every DA line into one statement carrying that line's hit count", () => {
    const coverage = convert(["SF:src/a.ts", "DA:2,54", "DA:7,0", "end_of_record"].join("\n"));

    expect(fileOf(coverage, "src/a.ts").statementMap).toEqual({
      "0": { start: { line: 2, column: 0 }, end: { line: 2, column: 0 } },
      "1": { start: { line: 7, column: 0 }, end: { line: 7, column: 0 } },
    });
    expect(fileOf(coverage, "src/a.ts").s).toEqual({ "0": 54, "1": 0 });
  });

  it("names each function of the source and spans its body, so fallow can match it", () => {
    const coverage = convert(
      ["SF:src/a.ts", "DA:2,7", "DA:7,3", "DA:11,4", "DA:12,2", "end_of_record"].join("\n")
    );

    const { fnMap } = fileOf(coverage, "src/a.ts");
    expect(Object.values(fnMap).map((fn) => fn.name)).toEqual([
      "add",
      "constructor",
      "bump",
      "(anonymous_0)",
    ]);
    expect(fnMap["0"]).toEqual({
      name: "add",
      decl: { start: { line: 1, column: 0 }, end: { line: 1, column: 0 } },
      loc: { start: { line: 1, column: 0 }, end: { line: 3, column: 0 } },
      line: 1,
    });
    expect(fnMap["3"]?.loc).toEqual({
      start: { line: 11, column: 0 },
      end: { line: 13, column: 0 },
    });
  });

  it("gives each function the hits of the lowest measured line of its body", () => {
    const coverage = convert(
      ["SF:src/a.ts", "DA:2,7", "DA:7,3", "DA:11,4", "DA:12,2", "end_of_record"].join("\n")
    );

    expect(fileOf(coverage, "src/a.ts").f).toEqual({ "0": 7, "1": 3, "2": 4, "3": 4 });
  });

  it("leaves out a function whose body holds no measured line", () => {
    const coverage = convert(["SF:src/a.ts", "DA:2,7", "end_of_record"].join("\n"));

    const { fnMap } = fileOf(coverage, "src/a.ts");
    expect(Object.values(fnMap).map((fn) => fn.name)).toEqual(["add"]);
    expect(fileOf(coverage, "src/a.ts").f).toEqual({ "0": 7 });
  });

  it("records a function bun never entered with the zero hits bun reported", () => {
    const coverage = convert(["SF:src/a.ts", "DA:2,0", "end_of_record"].join("\n"));

    expect(fileOf(coverage, "src/a.ts").f).toEqual({ "0": 0 });
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

    expect(fileOf(coverage, "src/b.ts").s).toEqual({ "0": 4 });
  });

  it("drops a DA line that stands outside any record", () => {
    const coverage = convert(["DA:1,1", "SF:src/a.ts", "end_of_record", "DA:2,2"].join("\n"));

    expect(fileOf(coverage, "src/a.ts").s).toEqual({});
  });

  it("leaves the branch maps empty, because bun reports no branch data", () => {
    const coverage = convert(["SF:src/a.ts", "DA:2,7", "end_of_record"].join("\n"));

    expect(fileOf(coverage, "src/a.ts").branchMap).toEqual({});
    expect(fileOf(coverage, "src/a.ts").b).toEqual({});
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

  function project(lcov: string, sources: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "codex-mcp-lcov-"));
    roots.push(root);
    mkdirSync(join(root, "coverage"));
    writeFileSync(join(root, "coverage", "lcov.info"), lcov, "utf8");
    for (const [relative, source] of Object.entries(sources)) {
      mkdirSync(dirname(join(root, relative)), { recursive: true });
      writeFileSync(join(root, relative), source, "utf8");
    }
    return root;
  }

  it("writes the converted report beside the lcov it read", () => {
    const root = project(["SF:src/a.ts", "DA:2,7", "end_of_record", ""].join("\n"), {
      "src/a.ts": SOURCE,
    });

    const written = writeIstanbulReport(root) as {
      path: string;
      files: number;
      functions: number;
    };

    expect(written.path).toBe(join(root, "coverage", "coverage-final.json"));
    expect(written.files).toBe(1);
    expect(written.functions).toBe(1);
    expect(JSON.parse(readFileSync(written.path, "utf8"))).toEqual({
      [join(root, "src", "a.ts")]: {
        path: join(root, "src", "a.ts"),
        statementMap: { "0": { start: { line: 2, column: 0 }, end: { line: 2, column: 0 } } },
        fnMap: {
          "0": {
            name: "add",
            decl: { start: { line: 1, column: 0 }, end: { line: 1, column: 0 } },
            loc: { start: { line: 1, column: 0 }, end: { line: 3, column: 0 } },
            line: 1,
          },
        },
        branchMap: {},
        s: { "0": 7 },
        f: { "0": 7 },
        b: {},
      },
    });
  });

  it("counts the records and the functions of the report it wrote", () => {
    const root = project(
      [
        "SF:src/a.ts",
        "DA:2,7",
        "DA:7,3",
        "end_of_record",
        "SF:src/b.ts",
        "DA:2,1",
        "end_of_record",
      ].join("\n"),
      { "src/a.ts": SOURCE, "src/b.ts": SOURCE }
    );

    expect(writeIstanbulReport(root) as { files: number; functions: number }).toMatchObject({
      files: 2,
      functions: 3,
    });
  });
});
