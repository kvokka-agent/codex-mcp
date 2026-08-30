/**
 * Where a shields.io endpoint document goes, what it looks like on disk, and
 * how it travels from the job that measured it to the job that commits it.
 *
 * Every asserted value is what the module returned for the endpoint, the
 * document or the file the test handed it.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error -- plain ESM, shared with the script that runs it.
import {
  BADGES,
  badgeDocument,
  badgeOutput,
  badgePath,
  badgeUpdate,
  parseEndpoint,
} from "../scripts/lib/badge-file.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

const badges = Object.entries(BADGES as Record<string, string>);
const FALLOW = { schemaVersion: 1, label: "fallow", message: "A (85)", color: "brightgreen" };

describe("badgePath", () => {
  it.each(badges)("puts a document labelled %s in %s", (label, path) => {
    expect(badgePath({ label })).toBe(path);
  });

  it("refuses a document no badge is drawn from", () => {
    expect(() => badgePath({ label: "quality" })).toThrow("labelled quality");
  });
});

describe("badgeDocument", () => {
  it("writes the endpoint object as a file git can diff", () => {
    const document = badgeDocument(FALLOW);

    expect(document.endsWith("\n")).toBe(true);
    expect(JSON.parse(document)).toEqual(FALLOW);
  });
});

describe("badgeOutput", () => {
  // `$GITHUB_OUTPUT` reads one entry per line unless it carries a heredoc
  // delimiter, so the document travels as JSON on a single line.
  it("names the output after the label and carries the document on one line", () => {
    const line = badgeOutput(FALLOW);

    expect(line.split("\n")).toHaveLength(1);
    expect(line.slice(0, line.indexOf("="))).toBe("fallow-badge");
    expect(JSON.parse(line.slice(line.indexOf("=") + 1))).toEqual(FALLOW);
  });

  it("hands the document back to the reader that parses it", () => {
    const line = badgeOutput(FALLOW);

    expect(parseEndpoint(line.slice(line.indexOf("=") + 1))).toEqual(FALLOW);
  });
});

describe("parseEndpoint", () => {
  // A job output that was never set arrives as the empty string, which is what
  // a broken outputs chain looks like from here.
  it("refuses an output that was never set", () => {
    expect(() => parseEndpoint("")).toThrow("arrived empty");
  });
});

describe("badgeUpdate", () => {
  const path = BADGES.fallow as string;
  const document = badgeDocument(FALLOW);

  it("leaves the file alone when it already carries this measurement", () => {
    expect(badgeUpdate({ path, document, current: document })).toEqual({
      changed: false,
      text: `${path} already reads A (85).`,
    });
  });

  it("rewrites the file when the measurement moved", () => {
    const current = badgeDocument({ ...FALLOW, message: "B (71)", color: "green" });

    expect(badgeUpdate({ path, document, current })).toEqual({
      changed: true,
      text: `${path} now reads A (85).`,
    });
  });

  it("writes the file when there is none", () => {
    expect(badgeUpdate({ path, document, current: null }).changed).toBe(true);
  });
});

// shields fetches each document from raw.githubusercontent, so the README URL
// and the committed path are one thing said twice.
describe("the committed badges", () => {
  it.each(badges)("%s is drawn by shields from %s", (_label, path) => {
    expect(read("README.md")).toContain(
      `https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/kvokka/codex-mcp/master/${path}`
    );
  });

  it.each(badges)("%s carries a document written the way this module writes one", (label, path) => {
    const committed = read(path);

    expect(committed).toBe(badgeDocument(JSON.parse(committed)));
    expect(JSON.parse(committed).label).toBe(label);
  });
});
