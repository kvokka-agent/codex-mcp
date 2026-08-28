import { mockModule } from "./helpers/mock.js";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

/**
 * `statSync` is the only dependency whose failure mode cannot be produced from a real
 * temporary directory: `existsSync` already returns false for every path `statSync` rejects.
 * The wrapper delegates to the real implementation unless a test arms `statError`.
 */
const fsState = { statError: null as Error | null };

const realModule1 = { ...(await import("fs")) };
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

const { resolveAndValidateFilePath } = await import("../src/utils/files.js");

const tempRoots: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "codex-mcp-files-"));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  fsState.statError = null;
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

describe("resolveAndValidateFilePath", () => {
  it("returns an absolute input path untouched", () => {
    const dir = makeTempDir();
    const file = path.join(dir, "shot.png");
    writeFileSync(file, "x");

    expect(resolveAndValidateFilePath(file, path.join(dir, "unused-base"))).toBe(file);
  });

  it("resolves a relative input path against baseDir, not process.cwd()", () => {
    const dir = makeTempDir();
    const nested = path.join(dir, "assets");
    mkdirSync(nested);
    const file = path.join(nested, "shot.png");
    writeFileSync(file, "x");

    expect(resolveAndValidateFilePath("assets/shot.png", dir)).toBe(file);
  });

  it("reports the resolved path when the file is missing", () => {
    const dir = makeTempDir();
    const missing = path.join(dir, "gone.png");

    let caught: unknown;
    try {
      resolveAndValidateFilePath("gone.png", dir);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe(
      `Error [INVALID_ARGUMENT]: path does not exist: ${missing}`
    );
  });

  it("uses the caller label in the not-a-file message", () => {
    const dir = makeTempDir();
    const subdir = path.join(dir, "images");
    mkdirSync(subdir);

    expect(() => resolveAndValidateFilePath(subdir, dir, "image")).toThrow(
      `Error [INVALID_ARGUMENT]: image is not a file: ${subdir}`
    );
  });

  it("keeps the not-a-file diagnosis instead of collapsing it into 'cannot access'", () => {
    const dir = makeTempDir();
    const subdir = path.join(dir, "images");
    mkdirSync(subdir);

    let message = "";
    try {
      resolveAndValidateFilePath("images", dir, "image");
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message).toContain("is not a file");
    expect(message).not.toContain("cannot access");
  });

  it("wraps an unexpected stat failure as 'cannot access <label>'", () => {
    const dir = makeTempDir();
    const file = path.join(dir, "shot.png");
    writeFileSync(file, "x");
    fsState.statError = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });

    expect(() => resolveAndValidateFilePath(file, dir, "image")).toThrow(
      `Error [INVALID_ARGUMENT]: cannot access image: ${file}`
    );
  });

  it("labels errors 'path' by default", () => {
    const dir = makeTempDir();
    const file = path.join(dir, "shot.png");
    writeFileSync(file, "x");
    fsState.statError = new Error("boom");

    expect(() => resolveAndValidateFilePath(file, dir)).toThrow(
      `Error [INVALID_ARGUMENT]: cannot access path: ${file}`
    );
  });
});
