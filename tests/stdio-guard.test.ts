import { describe, expect, it } from "bun:test";
import { resolveStdioMode, runStdioPreflight } from "../src/utils/stdio-guard.js";

describe("stdio guard", () => {
  it("defaults to auto mode when env var is missing", () => {
    const mode = resolveStdioMode({});
    expect(mode).toEqual({ mode: "auto", source: "default" });
  });

  it("falls back to auto mode for invalid env values", () => {
    const mode = resolveStdioMode({ CODEX_MCP_STDIO_MODE: "banana" });
    expect(mode.mode).toBe("auto");
    expect(mode.source).toBe("env_invalid");
    expect(mode.invalidRaw).toBe("banana");
  });

  it("reads a blank env value as an unset one", () => {
    expect(resolveStdioMode({ CODEX_MCP_STDIO_MODE: "   " })).toEqual({
      mode: "auto",
      source: "default",
    });
  });

  it("notes the mode it could not read and runs the guard on auto", () => {
    const out = runStdioPreflight({
      platform: "linux",
      env: { CODEX_MCP_STDIO_MODE: "banana" },
      stdinIsTTY: true,
      stdoutIsTTY: false,
    });

    expect(out.mode).toBe("auto");
    expect(out.invalidMode).toBe("banana");
    expect(out.notes[0]).toBe("Invalid CODEX_MCP_STDIO_MODE='banana'. Falling back to 'auto'.");
    expect(out.notes[1]).toContain("terminal (TTY)");
    expect(out.shouldBlock).toBe(false);
  });

  it("keeps PowerShell risk as warning-only in strict mode", () => {
    const out = runStdioPreflight({
      platform: "win32",
      env: {
        CODEX_MCP_STDIO_MODE: "strict",
        POWERSHELL_DISTRIBUTION_CHANNEL: "Store",
        PSModulePath: "C:\\Users\\demo\\Documents\\PowerShell\\Modules",
      },
      stdinIsTTY: false,
      stdoutIsTTY: false,
    });

    expect(out.mode).toBe("strict");
    expect(out.riskLevel).toBe("elevated");
    expect(out.shouldBlock).toBe(false);
    expect(out.blockingReasons).toEqual([]);
    expect(out.suggestions.some((s) => s.includes("NoProfile"))).toBe(true);
  });

  it("auto mode reports elevated risk but does not block", () => {
    const out = runStdioPreflight({
      platform: "win32",
      env: {
        CODEX_MCP_STDIO_MODE: "auto",
        PSExecutionPolicyPreference: "RemoteSigned",
      },
      stdinIsTTY: false,
      stdoutIsTTY: false,
    });

    expect(out.mode).toBe("auto");
    expect(out.riskLevel).toBe("elevated");
    expect(out.shouldBlock).toBe(false);
  });

  it("off mode disables risk evaluation", () => {
    const out = runStdioPreflight({
      platform: "win32",
      env: {
        CODEX_MCP_STDIO_MODE: "off",
        PSExecutionPolicyPreference: "RemoteSigned",
      },
      stdinIsTTY: false,
      stdoutIsTTY: false,
    });

    expect(out.mode).toBe("off");
    expect(out.riskLevel).toBe("low");
    expect(out.riskReasons).toEqual([]);
    expect(out.blockingReasons).toEqual([]);
    expect(out.shouldBlock).toBe(false);
  });

  it("strict mode blocks when stdio is attached to tty", () => {
    const out = runStdioPreflight({
      platform: "linux",
      env: {
        CODEX_MCP_STDIO_MODE: "strict",
      },
      stdinIsTTY: true,
      stdoutIsTTY: false,
    });

    expect(out.mode).toBe("strict");
    expect(out.riskLevel).toBe("elevated");
    expect(out.blockingReasons.length).toBeGreaterThan(0);
    expect(out.shouldBlock).toBe(true);
  });
});
