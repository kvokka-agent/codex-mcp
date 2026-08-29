import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { mockModule } from "./helpers/mock.js";
import { present } from "./helpers/present.js";

/**
 * `statSync` is the only dependency whose failure mode cannot be produced from a real
 * temporary directory: `existsSync` already returns false for every path `statSync` rejects.
 * The wrapper delegates to the real implementation unless a test arms `statError`.
 */
const fsState = { statError: null as Error | null };

const realModule1 = { ...(await import("node:fs")) };
mockModule("fs", realModule1, () => {
  const actual = realModule1;
  return {
    ...actual,
    default: actual,
    statSync: (...args: Parameters<typeof actual.statSync>) => {
      if (fsState.statError) throw fsState.statError;
      return actual.statSync(...args);
    },
  };
});

const { resolveAndValidateCwd } = await import("../src/utils/cwd.js");

const tempRoots: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "codex-mcp-cwd-"));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  fsState.statError = null;
  while (tempRoots.length > 0) {
    rmSync(present(tempRoots.pop(), "the temporary directory to remove"), {
      recursive: true,
      force: true,
    });
  }
});

describe("resolveAndValidateCwd", () => {
  it("falls back to baseCwd when no cwd is supplied", () => {
    const dir = makeTempDir();

    expect(resolveAndValidateCwd(undefined, dir)).toBe(dir);
  });

  it("returns an absolute cwd untouched", () => {
    const dir = makeTempDir();
    const nested = path.join(dir, "workspace");
    mkdirSync(nested);

    expect(resolveAndValidateCwd(nested, dir)).toBe(nested);
  });

  it("resolves a relative cwd against baseCwd, not process.cwd()", () => {
    const dir = makeTempDir();
    const nested = path.join(dir, "workspace", "inner");
    mkdirSync(nested, { recursive: true });

    expect(resolveAndValidateCwd(path.join("workspace", "inner"), dir)).toBe(nested);
    expect(resolveAndValidateCwd("workspace/../workspace", dir)).toBe(path.join(dir, "workspace"));
  });

  it("reports the resolved path when the directory is missing", () => {
    const dir = makeTempDir();
    const missing = path.join(dir, "nope");

    expect(() => resolveAndValidateCwd("nope", dir)).toThrow(
      `Error [INVALID_ARGUMENT]: cwd does not exist: ${missing}`
    );
  });

  it("rejects a regular file as cwd", () => {
    const dir = makeTempDir();
    const file = path.join(dir, "notes.txt");
    writeFileSync(file, "x");

    let message = "";
    try {
      resolveAndValidateCwd(file, dir);
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message).toBe(`Error [INVALID_ARGUMENT]: cwd is not a directory: ${file}`);
    expect(message).not.toContain("cannot access");
  });

  it("wraps an unexpected stat failure as 'cannot access cwd'", () => {
    const dir = makeTempDir();
    fsState.statError = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });

    expect(() => resolveAndValidateCwd(dir, dir)).toThrow(
      `Error [INVALID_ARGUMENT]: cannot access cwd: ${dir}`
    );
  });
});
