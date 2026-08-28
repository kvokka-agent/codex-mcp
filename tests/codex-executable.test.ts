import { mockModule } from "./helpers/mock.js";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";

const { deniedExecute } = { deniedExecute: new Set<string>() };

// The resolver asks `fs.accessSync(file, X_OK)` whether a file carries the POSIX execute bit.
// Windows has no such bit and answers X_OK like F_OK, so the denial is injected here instead of
// taken from a mode: that keeps the POSIX branch measurable on every host.
const realModule1 = { ...(await import("fs")) };
mockModule("fs", realModule1, () => {
  const actual = realModule1;
  return {
    ...actual,
    default: actual,
    accessSync: ((file: string, mode?: number) => {
      if (deniedExecute.has(String(file))) {
        const err = new Error(
          `EACCES: permission denied, access '${file}'`
        ) as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
      return actual.accessSync(file, mode);
    }) as typeof actual.accessSync,
  };
});

import {
  AUTO_CODEX_COMMANDS,
  CODEX_MCP_COMMAND,
  CODEX_MCP_PATH,
  _resetForTesting,
  checkDefaultCodexExecutableAvailability,
  getDefaultCodexExecutable,
  resolveDefaultCodexExecutable,
} from "../src/utils/codex-executable.js";

let root: string;
const isWindows = process.platform === "win32";
const realPlatform = process.platform;
const envBackup = { ...process.env };

function setPlatform(platform: string): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

/** Make `accessSync(file, X_OK)` report the file as not executable. */
function denyExecute(file: string): void {
  deniedExecute.add(file);
}

function makeExecutable(dir: string, name: string, mode = 0o755): string {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  writeFileSync(file, "#!/bin/sh\nexit 0\n");
  chmodSync(file, mode);
  return file;
}

/**
 * A PATH entry the host itself runs: Windows takes executability from the PATHEXT suffix,
 * POSIX from the mode bits.
 */
function makeExecutableOnPath(dir: string, base: string): string {
  return makeExecutable(dir, isWindows ? `${base}.exe` : base);
}

/** A PATH entry the host refuses: no PATHEXT suffix on Windows, no execute bit on POSIX. */
function makeUnexecutableOnPath(dir: string, base: string): string {
  return makeExecutable(dir, base, 0o644);
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "codex-mcp-executable-"));
  delete process.env[CODEX_MCP_PATH];
  delete process.env[CODEX_MCP_COMMAND];
  _resetForTesting();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  setPlatform(realPlatform);
  deniedExecute.clear();
  for (const key of Object.keys(process.env)) {
    if (!(key in envBackup)) delete process.env[key];
  }
  Object.assign(process.env, envBackup);
  _resetForTesting();
  jest.restoreAllMocks();
});

describe("resolveDefaultCodexExecutable", () => {
  it("rejects setting both env vars", () => {
    expect(() =>
      resolveDefaultCodexExecutable({
        [CODEX_MCP_PATH]: "/opt/codex",
        [CODEX_MCP_COMMAND]: "codex",
      })
    ).toThrow(/Cannot set both CODEX_MCP_PATH and CODEX_MCP_COMMAND/);
  });

  it("resolves CODEX_MCP_PATH to an absolute path", () => {
    const file = makeExecutable(root, "my-codex");
    expect(resolveDefaultCodexExecutable({ [CODEX_MCP_PATH]: file })).toEqual({
      command: path.resolve(file),
      isPath: true,
      source: "env_path",
    });
  });

  it("strips surrounding quotes and whitespace from CODEX_MCP_PATH", () => {
    const file = makeExecutable(root, "my-codex");
    expect(resolveDefaultCodexExecutable({ [CODEX_MCP_PATH]: `  "${file}"  ` }).command).toBe(
      path.resolve(file)
    );
  });

  it("rejects a CODEX_MCP_PATH that does not exist", () => {
    expect(() =>
      resolveDefaultCodexExecutable({ [CODEX_MCP_PATH]: path.join(root, "absent") })
    ).toThrow(/file does not exist/);
  });

  it("rejects a CODEX_MCP_PATH without the execute bit on POSIX", () => {
    setPlatform("linux");
    const file = makeExecutable(root, "not-exec", 0o644);
    denyExecute(file);

    expect(() => resolveDefaultCodexExecutable({ [CODEX_MCP_PATH]: file })).toThrow(
      /not an executable file/
    );
  });

  it("accepts a CODEX_MCP_PATH without the execute bit on Windows", () => {
    setPlatform("win32");
    const file = makeExecutable(root, "codex.exe", 0o644);
    denyExecute(file);

    expect(resolveDefaultCodexExecutable({ [CODEX_MCP_PATH]: file })).toEqual({
      command: path.resolve(file),
      isPath: true,
      source: "env_path",
    });
  });

  it("rejects a CODEX_MCP_PATH that points at a directory", () => {
    expect(() => resolveDefaultCodexExecutable({ [CODEX_MCP_PATH]: root })).toThrow(
      /not an executable file/
    );
  });

  it("rejects a CODEX_MCP_COMMAND that looks like a path", () => {
    expect(() => resolveDefaultCodexExecutable({ [CODEX_MCP_COMMAND]: "./bin/codex" })).toThrow(
      /looks like a path. Use CODEX_MCP_PATH/
    );
  });

  it("rejects a CODEX_MCP_COMMAND that is not on PATH", () => {
    expect(() =>
      resolveDefaultCodexExecutable({ [CODEX_MCP_COMMAND]: "nope-codex", PATH: root })
    ).toThrow(/was not found in PATH/);
  });

  it("resolves CODEX_MCP_COMMAND against PATH", () => {
    const dir = path.join(root, "bin");
    const file = makeExecutableOnPath(dir, "special-codex");

    expect(
      resolveDefaultCodexExecutable({
        [CODEX_MCP_COMMAND]: "special-codex",
        PATH: [path.join(root, "empty"), dir].join(path.delimiter),
      })
    ).toEqual({ command: file, isPath: true, source: "env_command" });
  });

  it("auto-detects the first candidate present on PATH", () => {
    const dir = path.join(root, "bin");
    const codex = makeExecutableOnPath(dir, "codex");
    makeExecutableOnPath(dir, "codex-internal");

    expect(AUTO_CODEX_COMMANDS[0]).toBe("codex");
    expect(resolveDefaultCodexExecutable({ PATH: dir })).toEqual({
      command: codex,
      isPath: true,
      source: "auto_detect",
    });
  });

  it("falls back to codex-internal when codex is absent", () => {
    const dir = path.join(root, "bin");
    const internal = makeExecutableOnPath(dir, "codex-internal");

    expect(resolveDefaultCodexExecutable({ PATH: dir })).toEqual({
      command: internal,
      isPath: true,
      source: "auto_detect",
    });
  });

  it("ignores non-executable and non-file candidates on PATH", () => {
    const dir = path.join(root, "bin");
    makeUnexecutableOnPath(dir, "codex");
    mkdirSync(path.join(dir, isWindows ? "codex-internal.exe" : "codex-internal"), {
      recursive: true,
    });

    expect(resolveDefaultCodexExecutable({ PATH: dir })).toEqual({
      command: "codex",
      isPath: false,
      source: "default",
    });
  });

  it("ignores a PATH candidate without a PATHEXT suffix on Windows", () => {
    setPlatform("win32");
    const dir = path.join(root, "bin");
    makeExecutable(dir, "codex");
    mkdirSync(path.join(dir, "codex-internal.exe"), { recursive: true });

    expect(resolveDefaultCodexExecutable({ PATH: dir })).toEqual({
      command: "codex",
      isPath: false,
      source: "default",
    });
  });

  it("falls back to the bare command when PATH is empty", () => {
    expect(resolveDefaultCodexExecutable({})).toEqual({
      command: "codex",
      isPath: false,
      source: "default",
    });
  });

  it("reads Path and path as PATH aliases and strips quotes from entries", () => {
    const dir = path.join(root, "bin");
    const codex = makeExecutableOnPath(dir, "codex");

    expect(resolveDefaultCodexExecutable({ Path: `"${dir}"` }).command).toBe(codex);
    expect(resolveDefaultCodexExecutable({ path: dir }).command).toBe(codex);
  });

  it("appends PATHEXT extensions on Windows", () => {
    setPlatform("win32");
    const dir = path.join(root, "bin");
    const cmd = makeExecutable(dir, "codex.cmd", 0o644);

    expect(resolveDefaultCodexExecutable({ PATH: dir, PATHEXT: "CMD" })).toEqual({
      command: path.normalize(cmd),
      isPath: true,
      source: "auto_detect",
    });
  });

  it("ignores blank PATHEXT entries on Windows", () => {
    setPlatform("win32");
    const dir = path.join(root, "bin");
    const exe = makeExecutable(dir, "codex.exe", 0o644);

    expect(resolveDefaultCodexExecutable({ PATH: dir, PATHEXT: ";  ;.EXE" }).command).toBe(
      path.normalize(exe)
    );
  });

  it("keeps an explicit extension as given on Windows", () => {
    setPlatform("win32");
    const dir = path.join(root, "bin");
    const exe = makeExecutable(dir, "codex.exe", 0o644);

    expect(
      resolveDefaultCodexExecutable({ [CODEX_MCP_COMMAND]: "codex.exe", PATH: dir }).command
    ).toBe(path.normalize(exe));
  });

  it("splits PATH on semicolons on Windows", () => {
    setPlatform("win32");
    const dir = path.join(root, "bin");
    const bat = makeExecutable(dir, "codex.bat", 0o644);

    expect(
      resolveDefaultCodexExecutable({ PATH: `${path.join(root, "none")};${dir}` }).command
    ).toBe(path.normalize(bat));
  });
});

describe("getDefaultCodexExecutable", () => {
  it("resolves once and caches the result until reset", () => {
    const file = makeExecutable(root, "cached-codex");
    process.env[CODEX_MCP_PATH] = file;

    const first = getDefaultCodexExecutable();
    expect(first.command).toBe(path.resolve(file));

    delete process.env[CODEX_MCP_PATH];
    expect(getDefaultCodexExecutable()).toBe(first);

    _resetForTesting();
    process.env.PATH = "";
    expect(getDefaultCodexExecutable()).toEqual({
      command: "codex",
      isPath: false,
      source: "default",
    });
  });
});

describe("checkDefaultCodexExecutableAvailability", () => {
  it("names the env var that supplied the path", () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const file = makeExecutable(root, "codex");
    process.env[CODEX_MCP_PATH] = file;

    checkDefaultCodexExecutableAvailability();
    expect(errorSpy).toHaveBeenCalledWith(
      `[codex-executable] Using CODEX_MCP_PATH: ${path.resolve(file)}`
    );
  });

  it("names the env var that supplied the command", () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const dir = path.join(root, "bin");
    const file = makeExecutableOnPath(dir, "codex");
    process.env[CODEX_MCP_COMMAND] = "codex";
    process.env.PATH = dir;

    checkDefaultCodexExecutableAvailability();
    expect(errorSpy).toHaveBeenCalledWith(
      `[codex-executable] Using CODEX_MCP_COMMAND: resolved to ${file}`
    );
  });

  it("reports an auto-detected executable", () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const dir = path.join(root, "bin");
    const file = makeExecutableOnPath(dir, "codex");
    process.env.PATH = dir;

    checkDefaultCodexExecutableAvailability();
    expect(errorSpy).toHaveBeenCalledWith(`[codex-executable] Auto-detected executable: ${file}`);
  });

  it("reports the fallback and how to configure it", () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    process.env.PATH = "";

    checkDefaultCodexExecutableAvailability();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[codex-executable] No codex found on PATH; falling back to "codex"')
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Set CODEX_MCP_COMMAND or CODEX_MCP_PATH to configure.")
    );
  });
});
