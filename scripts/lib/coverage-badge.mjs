// What the README's coverage badge shows: the share of lines and of functions
// the tests reached, out of the Istanbul report `bun run coverage` writes and
// `.fallowrc.jsonc` names. `scripts/lib/badge-file.mjs` holds where the
// document goes and what it looks like.

import { relative } from "node:path";

// Every file meets 90% of lines and 90% of functions on its own or the gate
// fails, so a tree under 90 does not pass its own check and the badge says so
// in red.
const COLORS = [
  { atLeast: 95, color: "brightgreen" },
  { atLeast: 90, color: "green" },
  { atLeast: 0, color: "red" },
];

// A test imports its helpers, so bun measures them along with the code under
// test. They are test support: `.fallowrc.jsonc` leaves `tests/**` out of the
// health score for that reason, and the badge counts them out for the same one.
const TESTS = /^tests[\\/]/;

function count(total, hits) {
  total.total += hits.length;
  total.covered += hits.filter((entered) => entered > 0).length;
}

// Floored rather than rounded, so the badge never claims a share the tree does
// not carry: 89.6% of lines reads 89, under the 90 the gate demands.
function percent({ covered, total }) {
  return Math.floor((covered / total) * 100);
}

/**
 * The lines and the functions one Istanbul coverage map holds, covered and
 * total. `s` carries a hit count per measured line and `f` one per function
 * matched to the source, which is what
 * [`lcov-istanbul.mjs`](./lcov-istanbul.mjs) built the report out of.
 *
 * @param {Record<string, {s: Record<string, number>, f: Record<string, number>}>} report
 * @param {string} root the directory the report's absolute paths lie under
 */
export function coverageTotals(report, root) {
  const totals = { lines: { covered: 0, total: 0 }, functions: { covered: 0, total: 0 } };
  for (const [path, file] of Object.entries(report)) {
    if (TESTS.test(relative(root, path))) continue;
    count(totals.lines, Object.values(file.s));
    count(totals.functions, Object.values(file.f));
  }
  if (totals.lines.total === 0 || totals.functions.total === 0) {
    throw new Error("the coverage report measured no line or no function of this repository");
  }
  return totals;
}

/**
 * The shields.io endpoint object for one coverage measurement. The colour reads
 * the lower of the two shares, because the gate holds both to 90.
 *
 * @param {{lines: {covered: number, total: number}, functions: {covered: number, total: number}}} totals
 */
export function coverageEndpoint(totals) {
  const lines = percent(totals.lines);
  const functions = percent(totals.functions);
  const band = COLORS.find((each) => Math.min(lines, functions) >= each.atLeast);
  return {
    schemaVersion: 1,
    label: "coverage",
    message: `${lines}% lines, ${functions}% functions`,
    color: band.color,
  };
}
