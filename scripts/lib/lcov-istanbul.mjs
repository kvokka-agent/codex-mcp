// Turns the lcov report `bun test --coverage` writes into the Istanbul JSON
// that fallow reads for exact per-function CRAP scores.
//
// bun's lcov carries `DA:` line hits plus the `FNF:`/`FNH:` totals only — never
// an `FN:`/`FNDA:` record naming a function — so the per-function half has to be
// recovered from the source. fallow keys an Istanbul function by name and
// declaration line, tolerating a drift of three lines, and reads the function's
// coverage from the statements falling inside its `loc` range, using `f` only
// when that range holds none. A name it cannot match is dropped silently, so a
// file whose `fnMap` is empty scores as if nothing were covered at all: CRAP
// becomes `cc^2 + cc` instead of `cc`. `(anonymous_N)`, the name Istanbul gives
// a function with no identifier, is the one name fallow matches by position
// alone.

import { readFileSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import ts from "typescript";

const FUNCTION_KINDS = new Set([
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.Constructor,
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.SetAccessor,
]);

const SCRIPT_KINDS = {
  ".cts": ts.ScriptKind.TS,
  ".js": ts.ScriptKind.JS,
  ".jsx": ts.ScriptKind.JSX,
  ".mjs": ts.ScriptKind.JS,
  ".mts": ts.ScriptKind.TS,
  ".ts": ts.ScriptKind.TS,
  ".tsx": ts.ScriptKind.TSX,
};

function declaredName(node) {
  if (node.kind === ts.SyntaxKind.Constructor) return "constructor";
  const name = node.name;
  if (name === undefined) return undefined;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

/**
 * Every function in one source file, in source order, with the line span of its
 * body.
 *
 * @param {string} source source text
 * @param {string} path path the text was read from, for the parser's dialect
 * @returns {{ name: string, declLine: number, startLine: number, endLine: number }[]}
 */
export function sourceFunctions(source, path) {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    SCRIPT_KINDS[extname(path)] ?? ts.ScriptKind.TS
  );
  const lineOf = (position) => sourceFile.getLineAndCharacterOfPosition(position).line + 1;
  const functions = [];
  let anonymous = 0;

  const visit = (node) => {
    if (FUNCTION_KINDS.has(node.kind) && node.body !== undefined) {
      functions.push({
        name: declaredName(node) ?? `(anonymous_${anonymous++})`,
        declLine: lineOf(node.getStart(sourceFile)),
        startLine: lineOf(node.body.getStart(sourceFile)),
        endLine: lineOf(node.body.getEnd()),
      });
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return functions;
}

// The hits bun recorded for the lowest measured line of the span, which a
// function body enters exactly once per call.
function entryHits(file, startLine, endLine) {
  let found;
  for (const [id, statement] of Object.entries(file.statementMap)) {
    const line = statement.start.line;
    if (line < startLine || line > endLine) continue;
    if (found === undefined || line < found.line) found = { line, hits: file.s[id] };
  }
  return found?.hits;
}

function addFunctions(file, source, path) {
  let id = 0;
  for (const fn of sourceFunctions(source, path)) {
    const hits = entryHits(file, fn.startLine, fn.endLine);
    // A body holding no measured line — an empty one, or one bun folded away —
    // is left out rather than written down as zero hits bun never reported.
    if (hits === undefined) continue;
    const key = String(id++);
    file.fnMap[key] = {
      name: fn.name,
      decl: {
        start: { line: fn.declLine, column: 0 },
        end: { line: fn.declLine, column: 0 },
      },
      loc: {
        start: { line: fn.startLine, column: 0 },
        end: { line: fn.endLine, column: 0 },
      },
      line: fn.declLine,
    };
    file.f[key] = hits;
  }
}

/**
 * @param {string} lcov text of an lcov report
 * @param {string} root directory the `SF:` paths are relative to
 * @param {(path: string) => string} [readSource] reads one source file
 * @returns {Record<string, object>} Istanbul coverage map keyed by absolute path
 */
export function lcovToIstanbul(lcov, root, readSource = (path) => readFileSync(path, "utf8")) {
  const coverage = {};
  let current = null;
  for (const raw of lcov.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("SF:")) {
      const path = resolve(root, line.slice("SF:".length));
      current = { path, statementMap: {}, fnMap: {}, branchMap: {}, s: {}, f: {}, b: {} };
      coverage[path] = current;
      continue;
    }
    if (line === "end_of_record") {
      if (current !== null) addFunctions(current, readSource(current.path), current.path);
      current = null;
      continue;
    }
    if (current === null || !line.startsWith("DA:")) continue;
    const [lineNumber, hits] = line.slice("DA:".length).split(",");
    const id = String(Object.keys(current.statementMap).length);
    const at = { line: Number(lineNumber), column: 0 };
    current.statementMap[id] = { start: at, end: at };
    current.s[id] = Number(hits);
  }
  return coverage;
}

/**
 * Converts `coverage/lcov.info` under `root` into `coverage/coverage-final.json`
 * beside it.
 *
 * @param {string} root project root
 * @returns {{ path: string, files: number, functions: number }}
 */
export function writeIstanbulReport(root) {
  const lcov = readFileSync(join(root, "coverage", "lcov.info"), "utf8");
  const coverage = lcovToIstanbul(lcov, root);
  const path = join(root, "coverage", "coverage-final.json");
  writeFileSync(path, JSON.stringify(coverage), "utf8");
  const files = Object.values(coverage);
  return {
    path,
    files: files.length,
    functions: files.reduce((total, file) => total + Object.keys(file.fnMap).length, 0),
  };
}
