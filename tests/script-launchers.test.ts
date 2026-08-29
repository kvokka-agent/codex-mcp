/**
 * The command line and the report the two launcher scripts share.
 *
 * Every asserted value is what the module under test returned for the argv, the
 * environment or the child process the test handed it.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error -- plain ESM, shared with the scripts that run it.
import { parseLaunchArgs, resolveSpawnTarget, splitArgv } from "../scripts/lib/launch-args.mjs";
// @ts-expect-error -- plain ESM, shared with the scripts that run it.
import {
  buildStdioReport,
  captureChildOutput,
  describeStdioReport,
  getFixHints,
  isRuntimeFailure,
  readPositiveMs,
  readStdioMode,
  stdioCheckEnv,
} from "../scripts/lib/stdio-check.mjs";
// @ts-expect-error -- plain ESM, shared with the scripts that run it.
import {
  assertResourcesPresent,
  assertToolsPresent,
  codexMcpEnv,
  REQUIRED_RESOURCES,
  REQUIRED_TOOLS,
} from "../scripts/lib/mcp-client.mjs";

type LaunchArgs = {
  useBunx: boolean;
  cwd: string;
  overrideCommand: string | null;
  overrideArgs: string[];
  [key: string]: unknown;
};

// The scripts pass a `usage` that exits the process; this one throws, so
// parsing stops where it stops in production.
function parse(argv: string[], spec: Record<string, unknown> = {}): LaunchArgs {
  return parseLaunchArgs(argv, {
    usage: (exitCode: number) => {
      throw new Error(`usage(${exitCode})`);
    },
    ...spec,
  }) as LaunchArgs;
}

describe("splitArgv", () => {
  it("gives the whole array as the main part when no bare -- stands in it", () => {
    expect(splitArgv(["--bunx", "--cwd", "/tmp"])).toEqual({
      main: ["--bunx", "--cwd", "/tmp"],
      tail: [],
    });
  });

  it("splits at the first bare -- and drops it", () => {
    expect(splitArgv(["--bunx", "--", "node", "server.js", "--"])).toEqual({
      main: ["--bunx"],
      tail: ["node", "server.js", "--"],
    });
  });
});

describe("parseLaunchArgs", () => {
  it("defaults to the local build in the current directory", () => {
    const args = parse([]);

    expect(args.useBunx).toBe(false);
    expect(args.cwd).toBe(process.cwd());
    expect(args.overrideCommand).toBeNull();
    expect(args.overrideArgs).toEqual([]);
  });

  it("reads the shared --bunx and --cwd flags", () => {
    const args = parse(["--bunx", "--cwd", "/srv/app"]);

    expect(args.useBunx).toBe(true);
    expect(args.cwd).toBe("/srv/app");
  });

  it("takes the command and its arguments from the tail after --", () => {
    const args = parse(["--", "podman", "run", "codex-mcp"]);

    expect(args.overrideCommand).toBe("podman");
    expect(args.overrideArgs).toEqual(["run", "codex-mcp"]);
  });

  it("carries the caller's defaults through untouched", () => {
    expect(parse([], { defaults: { timeoutMs: 2000, reportJson: null } })).toMatchObject({
      timeoutMs: 2000,
      reportJson: null,
    });
  });

  it("sets the key a declared switch names", () => {
    const args = parse(["--verbose"], {
      defaults: { verbose: false },
      switches: { "--verbose": "verbose" },
    });

    expect(args.verbose).toBe(true);
  });

  it("stores what a declared reader made of the next argument", () => {
    const args = parse(["--timeout-ms", "6000"], {
      values: { "--timeout-ms": { key: "timeoutMs", read: readPositiveMs } },
    });

    expect(args.timeoutMs).toBe(6000);
  });

  it("rejects the flag when its reader rejects the argument", () => {
    expect(() =>
      parse(["--timeout-ms", "0"], {
        values: { "--timeout-ms": { key: "timeoutMs", read: readPositiveMs } },
      })
    ).toThrow("usage(2)");
  });

  it("rejects a flag that stands last with nothing to read", () => {
    expect(() => parse(["--cwd"])).toThrow("usage(2)");
  });

  it("rejects an unknown flag", () => {
    expect(() => parse(["--nope"])).toThrow("usage(2)");
  });

  it("asks for the usage text on --help and on -h", () => {
    expect(() => parse(["--help"])).toThrow("usage(0)");
    expect(() => parse(["-h"])).toThrow("usage(0)");
  });
});

describe("resolveSpawnTarget", () => {
  it("spawns the local build by default", () => {
    expect(resolveSpawnTarget({ overrideCommand: null, overrideArgs: [], useBunx: false })).toEqual(
      {
        command: "bun",
        args: ["dist/index.js"],
      }
    );
  });

  it("spawns the published package under --bunx", () => {
    expect(resolveSpawnTarget({ overrideCommand: null, overrideArgs: [], useBunx: true })).toEqual({
      command: "bunx",
      args: ["@kvokka/codex-mcp"],
    });
  });

  it("prefers the command the tail named over --bunx", () => {
    expect(
      resolveSpawnTarget({ overrideCommand: "podman", overrideArgs: ["run"], useBunx: true })
    ).toEqual({ command: "podman", args: ["run"] });
  });
});

describe("readStdioMode", () => {
  it("accepts the three modes the server knows, trimmed and lowercased", () => {
    expect(readStdioMode(" Strict ")).toBe("strict");
    expect(readStdioMode("auto")).toBe("auto");
    expect(readStdioMode("off")).toBe("off");
  });

  it("rejects anything else", () => {
    expect(readStdioMode("loud")).toBeUndefined();
  });
});

describe("readPositiveMs", () => {
  it("floors a positive number", () => {
    expect(readPositiveMs("6000.9")).toBe(6000);
  });

  it("rejects zero, a negative and a word", () => {
    expect(readPositiveMs("0")).toBeUndefined();
    expect(readPositiveMs("-1")).toBeUndefined();
    expect(readPositiveMs("soon")).toBeUndefined();
  });
});

describe("stdioCheckEnv", () => {
  it("puts the state directory inside the run's own temporary one", () => {
    const env = stdioCheckEnv({ PATH: "/usr/bin" }, "strict", "/tmp/run") as Record<string, string>;

    expect(env.PATH).toBe("/usr/bin");
    expect(env.CODEX_MCP_STDIO_MODE).toBe("strict");
    expect(env.CODEX_MCP_STATE_DIR).toBe(join("/tmp/run", "state"));
  });

  it("keeps a state directory the caller already set", () => {
    const env = stdioCheckEnv({ CODEX_MCP_STATE_DIR: "/var/state" }, "auto", "/tmp/run") as Record<
      string,
      string
    >;

    expect(env.CODEX_MCP_STATE_DIR).toBe("/var/state");
  });
});

describe("getFixHints", () => {
  it("adds the shell-wrapping hint on Windows only", () => {
    const windows = getFixHints("win32") as string[];
    const linux = getFixHints("linux") as string[];

    expect(windows).toHaveLength(linux.length + 1);
    expect(windows[0]).toContain("pwsh -NoProfile");
    expect(linux[0]).toContain("bunx");
  });
});

describe("isRuntimeFailure", () => {
  it("passes a child this check terminated", () => {
    expect(isRuntimeFailure({ childExitCode: null, childExitSignal: "SIGTERM" })).toBe(false);
    expect(isRuntimeFailure({ childExitCode: null, childExitSignal: "SIGKILL" })).toBe(false);
    expect(isRuntimeFailure({ childExitCode: 0, childExitSignal: null })).toBe(false);
  });

  it("fails a child that exited non-zero or died on another signal", () => {
    expect(isRuntimeFailure({ childExitCode: 1, childExitSignal: null })).toBe(true);
    expect(isRuntimeFailure({ childExitCode: null, childExitSignal: "SIGSEGV" })).toBe(true);
  });
});

const RUN = {
  stdioMode: "auto",
  command: "bun",
  args: ["dist/index.js"],
  cwd: "/srv/app",
  timeoutMs: 2000,
  stdout: "",
  stderr: "",
  exitCode: null,
  exitSignal: "SIGTERM",
  stdoutPath: "/tmp/run/stdout.log",
  stderrPath: "/tmp/run/stderr.log",
  platform: "linux",
};

function asReport(run: typeof RUN) {
  return buildStdioReport(run) as {
    ok: boolean;
    mode: string;
    command: string;
    args: string[];
    cwd: string;
    timeoutMs: number;
    childExitCode: number | null;
    childExitSignal: string | null;
    stdoutBytes: number;
    stderrBytes: number;
    stdoutPreview: string;
    stderrPreview: string;
    logs: { stdoutPath: string; stderrPath: string };
    hints: string[];
  };
}

describe("buildStdioReport", () => {
  it("passes a run whose stdout carried nothing", () => {
    const report = asReport({ ...RUN, stderr: "[codex-mcp] ready\n" });

    expect(report.ok).toBe(true);
    expect(report.stdoutBytes).toBe(0);
    expect(report.stderrBytes).toBe(18);
    expect(report.stderrPreview).toBe("[codex-mcp] ready\n");
    expect(report.logs).toEqual({ stdoutPath: RUN.stdoutPath, stderrPath: RUN.stderrPath });
  });

  it("fails a run whose stdout carried anything but whitespace", () => {
    expect(asReport({ ...RUN, stdout: "   \n" }).ok).toBe(true);
    expect(asReport({ ...RUN, stdout: "hello\n" }).ok).toBe(false);
  });

  it("fails a run whose child exited before this check terminated it", () => {
    expect(asReport({ ...RUN, exitCode: 1, exitSignal: null }).ok).toBe(false);
  });

  it("cuts both previews at 400 characters", () => {
    const report = asReport({ ...RUN, stdout: "x".repeat(500), stderr: "y".repeat(500) });

    expect(report.stdoutPreview).toHaveLength(400);
    expect(report.stderrPreview).toHaveLength(400);
    expect(report.stdoutBytes).toBe(500);
  });
});

describe("describeStdioReport", () => {
  function describe_(run: typeof RUN): string[] {
    return describeStdioReport(asReport(run), {
      stdout: run.stdout,
      stderr: run.stderr,
    }) as string[];
  }

  it("names the mode and the spawned command first, whatever the outcome", () => {
    for (const run of [
      RUN,
      { ...RUN, stdout: "noise" },
      { ...RUN, exitCode: 2, exitSignal: null },
    ]) {
      expect(describe_(run).slice(0, 2)).toEqual(["Mode: auto", "Spawned: bun dist/index.js"]);
    }
  });

  it("reports a clean run, and notes stderr only when the server wrote there", () => {
    expect(describe_(RUN)).toEqual([
      "Mode: auto",
      "Spawned: bun dist/index.js",
      "OK: stdout is clean.",
      `Captured logs: ${RUN.stdoutPath} (stdout), ${RUN.stderrPath} (stderr)`,
    ]);
    expect(describe_({ ...RUN, stderr: "warming up\n" })).toContain(
      "(Note) server wrote to stderr (this is fine)."
    );
  });

  it("shows the stdout preview and every hint when stdout is dirty", () => {
    const lines = describe_({ ...RUN, stdout: "banner\n" });

    expect(lines[2]).toBe("FAIL: stdout is not clean. First 400 chars:\n");
    expect(lines[3]).toBe("banner\n");
    expect(lines[4]).toBe(
      "\n---\nHint: anything printed to stdout will break MCP stdio handshake."
    );
    expect(lines.filter((line) => line.startsWith("Hint: "))).toHaveLength(
      (getFixHints("linux") as string[]).length
    );
  });

  it("reports the exit that beat the timeout", () => {
    const lines = describe_({ ...RUN, exitCode: 2, exitSignal: null });

    expect(lines[2]).toBe("FAIL: child exited before healthy startup (exitCode=2, signal=null).");
  });
});

describe("captureChildOutput", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function freshDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "codex-mcp-capture-"));
    dirs.push(dir);
    return dir;
  }

  it("returns what a child that outlived the timeout wrote to each stream", async () => {
    const dir = freshDir();

    const run = (await captureChildOutput({
      command: process.execPath,
      args: [
        "-e",
        "process.stdout.write('out\\n'); process.stderr.write('err\\n'); setTimeout(() => {}, 60000);",
      ],
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 300,
      dir,
    })) as {
      stdout: string;
      stderr: string;
      exitCode: number | null;
      exitSignal: string | null;
      stdoutPath: string;
    };

    expect(run.stdout).toBe("out\n");
    expect(run.stderr).toBe("err\n");
    expect(run.stdoutPath).toBe(join(dir, "stdout.log"));
    expect(isRuntimeFailure({ childExitCode: run.exitCode, childExitSignal: run.exitSignal })).toBe(
      false
    );
  });

  it("returns the code of a child that exited on its own", async () => {
    const run = (await captureChildOutput({
      command: process.execPath,
      args: ["-e", "process.exit(3)"],
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 100,
      dir: freshDir(),
    })) as { exitCode: number | null; exitSignal: string | null };

    expect(run.exitCode).toBe(3);
    expect(isRuntimeFailure({ childExitCode: run.exitCode, childExitSignal: run.exitSignal })).toBe(
      true
    );
  });
});

describe("the MCP contract the smoke check holds the server to", () => {
  it("names the five tools and the four resources", () => {
    expect(REQUIRED_TOOLS).toEqual([
      "codex",
      "codex_reply",
      "codex_session",
      "codex_check",
      "codex_setup",
    ]);
    expect(REQUIRED_RESOURCES).toEqual([
      "codex-mcp:///server-info",
      "codex-mcp:///config",
      "codex-mcp:///gotchas",
      "codex-mcp:///delegation-guide",
    ]);
  });

  it("passes a tools/list that carries every required tool", () => {
    const tools = (REQUIRED_TOOLS as string[]).map((name) => ({ name }));

    expect(() => assertToolsPresent([...tools, { name: "extra" }])).not.toThrow();
  });

  it("names the tool that tools/list left out", () => {
    const tools = (REQUIRED_TOOLS as string[])
      .filter((name) => name !== "codex_check")
      .map((name) => ({ name }));

    expect(() => assertToolsPresent(tools)).toThrow("missing tool from tools/list: codex_check");
  });

  it("passes a resources/list that carries every required uri", () => {
    const resources = (REQUIRED_RESOURCES as string[]).map((uri) => ({ uri }));

    expect(() => assertResourcesPresent(resources)).not.toThrow();
  });

  it("names the resource uri that resources/list left out", () => {
    const resources = (REQUIRED_RESOURCES as string[])
      .filter((uri) => uri !== "codex-mcp:///gotchas")
      .map((uri) => ({ uri }));

    expect(() => assertResourcesPresent(resources)).toThrow(
      "missing resource uri: codex-mcp:///gotchas"
    );
  });
});

describe("codexMcpEnv", () => {
  it("keeps the CODEX_MCP_ variables and drops everything else", () => {
    expect(
      codexMcpEnv({ CODEX_MCP_STATE_DIR: "/var/state", PATH: "/usr/bin", HOME: "/root" })
    ).toEqual({ CODEX_MCP_STATE_DIR: "/var/state" });
  });

  it("drops a CODEX_MCP_ name that carries no value", () => {
    expect(codexMcpEnv({ CODEX_MCP_MODE: undefined, CODEX_MCP_STATE_DIR: "/var/state" })).toEqual({
      CODEX_MCP_STATE_DIR: "/var/state",
    });
  });
});
