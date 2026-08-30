// The shields.io endpoint documents the README badges are drawn from. shields
// fetches each file from raw.githubusercontent and draws the badge from it, so
// the path below is half of the README URL and a new measurement reaches a
// reader only once the file is committed.

/** Where each badge's document lives, repository-relative, keyed by its shields label. */
export const BADGES = {
  fallow: "docs/fallow-badge.json",
  coverage: "docs/coverage-badge.json",
};

/**
 * The file one endpoint document belongs in.
 *
 * The label routes it, so a document that travelled through a workflow output
 * reaches its own badge whatever order the outputs were read in.
 *
 * @param {{label: string}} endpoint a shields.io endpoint object
 */
export function badgePath(endpoint) {
  const path = BADGES[endpoint.label];
  if (!path) throw new Error(`no badge is drawn from a document labelled ${endpoint.label}`);
  return path;
}

/**
 * The bytes a badge file carries. shields reads the document, git diffs the
 * bytes, so the formatting is part of what the release compares.
 *
 * @param {object} endpoint a shields.io endpoint object
 */
export function badgeDocument(endpoint) {
  return `${JSON.stringify(endpoint, null, 2)}\n`;
}

/**
 * The `name=value` line a workflow step appends to `$GITHUB_OUTPUT`, which is
 * how the job that measures a badge hands it to the job that commits it.
 *
 * A `$GITHUB_OUTPUT` entry is one line unless it carries a heredoc delimiter,
 * so the document travels as JSON on a single line and is written out in the
 * committed formatting at the other end.
 *
 * @param {{label: string}} endpoint a shields.io endpoint object
 */
export function badgeOutput(endpoint) {
  return `${endpoint.label}-badge=${JSON.stringify(endpoint)}`;
}

/**
 * One endpoint document read back off a workflow output.
 *
 * A job output that was never set arrives as the empty string rather than as a
 * failure, so a broken outputs chain reaches this as `""` and is refused here
 * instead of being written over a badge.
 *
 * @param {string} text what the output carried
 */
export function parseEndpoint(text) {
  if (!text) {
    throw new Error("a badge document arrived empty: the job that measured it set no output");
  }
  return JSON.parse(text);
}

/**
 * What the run has to do with the file on disk.
 *
 * @param {object} input
 * @param {string} input.path where the document belongs
 * @param {string} input.document what this run measured
 * @param {string | null} input.current what the file carries, null when there is none
 */
export function badgeUpdate({ path, document, current }) {
  const { message } = JSON.parse(document);
  if (current === document) return { changed: false, text: `${path} already reads ${message}.` };
  return { changed: true, text: `${path} now reads ${message}.` };
}
