// The per-file ceilings fallow measures but does not gate on. `.fallowrc.jsonc`
// carries every threshold fallow enforces itself; `.fallow-gate.jsonc` carries
// these, so the two together are the whole policy and neither restates the
// other.

/** What each ceiling reads out of a measured file, and how it prints. */
const METRICS = {
  lines: { of: (file) => file.lines, label: "LOC", format: String },
  fanOut: { of: (file) => file.fan_out, label: "fan-out", format: String },
  complexityDensity: {
    of: (file) => file.complexity_density,
    label: "density",
    format: (value) => value.toFixed(2),
  },
};

/**
 * Joins what fallow scored to the files the gate covers.
 *
 * fallow scores a file its analysis reaches, and a file holding only types and
 * constants reaches no score at all — `src/types.ts` is 622 lines fallow never
 * placed in `file_scores`. Line count therefore comes from the file itself, so
 * nothing sits over a ceiling unmeasured.
 *
 * @param {object} input
 * @param {string[]} input.paths repository-relative paths the gate covers
 * @param {Array<Record<string, unknown>>} input.scores fallow `file_scores`
 * @param {(path: string) => string} input.readSource reads one file
 */
export function measuredFiles({ paths, scores, readSource }) {
  const scoreOf = new Map(scores.map((score) => [score.path, score]));
  return paths.map((path) => ({
    ...scoreOf.get(path),
    path,
    lines: readSource(path).split("\n").length,
  }));
}

/**
 * @param {object} input
 * @param {Array<Record<string, unknown>>} input.files what `measuredFiles` returned
 * @param {Record<string, number>} input.ceilings ceiling per metric name
 * @param {Array<{path: string, metric: string, limit: number, reason: string}>} input.exceptions
 */
export function gateFindings({ files, ceilings, exceptions }) {
  assertPolicy(ceilings, exceptions);

  const failures = [];
  const held = [];
  for (const file of files) {
    for (const [metric, ceiling] of Object.entries(ceilings)) {
      const verdict = judge(file, metric, ceiling, exceptionFor(exceptions, file.path, metric));
      if (verdict?.held) held.push(verdict.finding);
      else if (verdict) failures.push(verdict.finding);
    }
  }

  // An exception that holds nothing back is one nobody needs, and left in place
  // it hides the next regression on that file.
  const judged = [...held, ...failures];
  const stale = exceptions.filter(
    (entry) =>
      !judged.some((finding) => finding.path === entry.path && finding.metric === entry.metric)
  );

  return { failures, held, stale };
}

/**
 * Whether what the gate found fails the run.
 *
 * @param {ReturnType<typeof gateFindings>} findings
 */
export function gateFailed(findings) {
  return findings.failures.length + findings.stale.length > 0;
}

/** Refuses a policy naming something the report cannot answer. */
function assertPolicy(ceilings, exceptions) {
  for (const metric of Object.keys(ceilings)) {
    if (!METRICS[metric]) throw new Error(`.fallow-gate.jsonc names an unknown ceiling: ${metric}`);
  }
  for (const entry of exceptions) {
    if (!METRICS[entry.metric]) {
      throw new Error(`.fallow-gate.jsonc excepts an unknown ceiling: ${entry.metric}`);
    }
    if (!entry.reason) {
      throw new Error(`.fallow-gate.jsonc excepts ${entry.path} ${entry.metric} with no reason`);
    }
  }
}

function exceptionFor(exceptions, path, metric) {
  return exceptions.find((entry) => entry.path === path && entry.metric === metric);
}

/** What one file did against one ceiling: nothing to say, held back, or over. */
function judge(file, metric, ceiling, exception) {
  const value = METRICS[metric].of(file);
  if (typeof value !== "number" || value <= ceiling) return undefined;
  if (!exception) return { finding: { path: file.path, metric, value, limit: ceiling } };
  const finding = { path: file.path, metric, value, limit: exception.limit };
  if (value > exception.limit) return { finding };
  return { held: true, finding: { ...finding, reason: exception.reason } };
}

/**
 * @param {object} input
 * @param {Array<Record<string, unknown>>} input.files
 * @param {ReturnType<typeof gateFindings>} input.findings
 * @param {Record<string, number>} input.ceilings
 */
export function describeGate({ files, findings, ceilings }) {
  const named = Object.entries(ceilings)
    .map(([metric, ceiling]) => `${METRICS[metric].label} <= ${ceiling}`)
    .join(" · ");
  const lines = [
    "── Gate ───────────────────────────────────────────",
    "",
    `  ${files.length} files measured · ${named}`,
  ];
  for (const finding of findings.held) {
    lines.push(
      `  ~ ${finding.path} ${METRICS[finding.metric].label} ` +
        `${METRICS[finding.metric].format(finding.value)} allowed to ${finding.limit}: ${finding.reason}`
    );
  }
  lines.push("");
  for (const finding of findings.failures) {
    lines.push(
      `  ✗ ${finding.path}  ${METRICS[finding.metric].label} ` +
        `${METRICS[finding.metric].format(finding.value)} (ceiling ${finding.limit})`
    );
  }
  for (const entry of findings.stale) {
    lines.push(
      `  ✗ .fallow-gate.jsonc: the ${entry.metric} exception for ${entry.path} holds nothing back — drop it`
    );
  }
  if (!gateFailed(findings)) {
    lines.push("  ✓ every file is inside its ceilings", "");
    return lines.join("\n");
  }
  lines.push(
    "",
    `  ${findings.failures.length} file(s) over a ceiling, ${findings.stale.length} stale ` +
      "exception(s).",
    "  Split the file, or except it in .fallow-gate.jsonc with the reason.",
    ""
  );
  return lines.join("\n");
}
