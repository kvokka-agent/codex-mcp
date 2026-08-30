// The health score behind the README's fallow badge, read out of what
// `fallow health --hotspots --score` measured. `scripts/lib/badge-file.mjs`
// holds where the document goes and what it looks like.

// fallow cuts its letter grade at A >= 85, B >= 70, C >= 55, D >= 40 and F
// below, and every grade it hands out is named here.
const GRADE_COLORS = { A: "brightgreen", B: "green", C: "yellow", D: "orange", F: "red" };

/**
 * The `health_score` of a `fallow health --hotspots --score --format json` report.
 *
 * fallow answers a coverage file it cannot read with `{"error": true, …}` on
 * stdout and exit 2, so a report carrying no `health_score` is a measurement
 * that did not happen.
 *
 * The hotspot penalty is ten points of this repository's score, and two runs
 * drop it without saying so: one without `--hotspots`, which scores 95.2 and
 * writes no `hotspots` key into `penalties` at all, and one over a clone
 * without history, which scores 95.2 with `hotspots: 0.0` because every file
 * looks added whole by a single commit. Either draws a badge ten points above
 * what `fallow health` prints, so both are refused here.
 *
 * @param {Record<string, unknown>} report the parsed fallow report
 */
export function readHealthScore(report) {
  if (report.error) throw new Error(`fallow health: ${report.message}`);
  const health = report.health_score;
  if (!health) throw new Error("fallow health --score answered with no health_score");
  if (!("hotspots" in (health.penalties ?? {}))) {
    throw new Error("fallow scored no hotspot penalty: ask for it with --hotspots");
  }
  if (report.hotspot_summary?.shallow_clone) {
    throw new Error(
      "fallow read a shallow clone, where no file is a hotspot and the penalty comes out 0. " +
        "Check the tree out with its history — actions/checkout with `fetch-depth: 0`, " +
        "or `git fetch --unshallow` — and run again."
    );
  }
  return health;
}

/**
 * The shields.io endpoint object for one health score.
 *
 * @param {{score: number, grade: string}} health fallow's `health_score`
 */
export function fallowEndpoint({ score, grade }) {
  const color = GRADE_COLORS[grade];
  if (!color) throw new Error(`fallow answered with a grade no colour is named for: ${grade}`);
  if (!Number.isFinite(score)) throw new Error(`fallow answered with no score: ${score}`);
  return {
    schemaVersion: 1,
    label: "fallow",
    message: `${grade} (${Math.round(score)})`,
    color,
  };
}
