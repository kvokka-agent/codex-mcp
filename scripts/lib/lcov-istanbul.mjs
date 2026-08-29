// Turns the lcov report `bun test --coverage` writes into the Istanbul JSON
// that fallow reads for exact per-function CRAP scores.
//
// bun emits only `DA:` line records — no `FN`/`FNDA` — so the Istanbul `fnMap`
// stays empty and every executed line becomes one statement. fallow derives a
// function's coverage from the statements inside its range, which is what the
// CRAP score needs.

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * @param {string} lcov text of an lcov report
 * @param {string} root directory the `SF:` paths are relative to
 * @returns {Record<string, object>} Istanbul coverage map keyed by absolute path
 */
export function lcovToIstanbul(lcov, root) {
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
 * @returns {{ path: string, files: number }}
 */
export function writeIstanbulReport(root) {
  const lcov = readFileSync(join(root, "coverage", "lcov.info"), "utf8");
  const coverage = lcovToIstanbul(lcov, root);
  const path = join(root, "coverage", "coverage-final.json");
  writeFileSync(path, JSON.stringify(coverage), "utf8");
  return { path, files: Object.keys(coverage).length };
}
