import { describe, expect, it } from "bun:test";
import path from "node:path";
import { findOnPath, resolveCodexInvocation } from "../src/app-server/codex-bin.js";

describe("resolveCodexInvocation defaults", () => {
  it("reads platform and env from the process when no deps are injected", () => {
    const out = resolveCodexInvocation(["app-server"]);

    if (process.platform === "win32") {
      expect(out.args).toContain("app-server");
      expect(out.cmd).not.toBe("");
    } else {
      expect(out).toEqual({ cmd: "codex", args: ["app-server"], spawnedViaCmd: false });
    }
  });

  it("falls back to ComSpec when the built-in file reader cannot open the shim", () => {
    // No `readFile` dep: the resolver reads the shim with fs.readFileSync, which fails on this
    // path on every platform, so the resolution must land on the cmd.exe fallback.
    const out = resolveCodexInvocation(["app-server"], {
      platform: "win32",
      env: {
        PATH: "C:\\codex-mcp-absent-fixture",
        ComSpec: "C:\\Windows\\System32\\cmd.exe",
      },
      exists: (p) => p === "C:\\codex-mcp-absent-fixture\\codex.cmd",
    });

    expect(out).toEqual({
      cmd: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", "codex", "app-server"],
      spawnedViaCmd: true,
    });
  });
});

describe("resolveCodexInvocation with an explicit executable path", () => {
  it("spawns a POSIX path directly", () => {
    const out = resolveCodexInvocation(["app-server"], {
      platform: "linux",
      env: {},
      codexCommand: "/opt/codex/bin/codex",
      codexIsPath: true,
    });

    expect(out).toEqual({
      cmd: "/opt/codex/bin/codex",
      args: ["app-server"],
      spawnedViaCmd: false,
    });
  });

  it("spawns a Windows .exe path directly", () => {
    const out = resolveCodexInvocation(["app-server"], {
      platform: "win32",
      env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      codexCommand: "C:\\Tools\\codex.exe",
      codexIsPath: true,
    });

    expect(out).toEqual({
      cmd: "C:\\Tools\\codex.exe",
      args: ["app-server"],
      spawnedViaCmd: false,
    });
  });

  it("wraps a Windows .cmd path in ComSpec with separate argument tokens", () => {
    const out = resolveCodexInvocation(["app-server", "-c", "model=gpt-5"], {
      platform: "win32",
      env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      codexCommand: "C:\\Tools\\Codex.CMD",
      codexIsPath: true,
    });

    expect(out).toEqual({
      cmd: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", "C:\\Tools\\Codex.CMD", "app-server", "-c", "model=gpt-5"],
      spawnedViaCmd: true,
    });
  });

  it("accepts the upper-case COMSPEC spelling for a .bat path", () => {
    const out = resolveCodexInvocation(["app-server"], {
      platform: "win32",
      env: { COMSPEC: "D:\\alt\\cmd.exe" },
      codexCommand: "C:\\Tools\\codex.bat",
      codexIsPath: true,
    });

    expect(out.cmd).toBe("D:\\alt\\cmd.exe");
    expect(out.spawnedViaCmd).toBe(true);
  });

  it("falls back to bare cmd.exe when no ComSpec is set", () => {
    const out = resolveCodexInvocation(["app-server"], {
      platform: "win32",
      env: {},
      codexCommand: "C:\\Tools\\codex.cmd",
      codexIsPath: true,
    });

    expect(out.cmd).toBe("cmd.exe");
    expect(out.spawnedViaCmd).toBe(true);
  });

  it("keeps a .cmd path direct on non-Windows platforms", () => {
    const out = resolveCodexInvocation(["app-server"], {
      platform: "darwin",
      env: {},
      codexCommand: "/opt/codex/codex.cmd",
      codexIsPath: true,
    });

    expect(out).toEqual({
      cmd: "/opt/codex/codex.cmd",
      args: ["app-server"],
      spawnedViaCmd: false,
    });
  });

  it("honours a custom bare command name on non-Windows", () => {
    const out = resolveCodexInvocation([], {
      platform: "linux",
      env: {},
      codexCommand: "codex-internal",
    });

    expect(out).toEqual({ cmd: "codex-internal", args: [], spawnedViaCmd: false });
  });
});

describe("resolveCodexInvocation PATH lookup on Windows", () => {
  it("spawns a resolved .exe directly", () => {
    const exe = "C:\\bin\\codex.exe";
    const out = resolveCodexInvocation(["app-server"], {
      platform: "win32",
      env: { PATH: "C:\\bin" },
      exists: (p) => p === exe,
      readFile: () => {
        throw new Error("readFile must not be called for an .exe shim");
      },
    });

    expect(out).toEqual({ cmd: exe, args: ["app-server"], spawnedViaCmd: false });
  });

  it("falls back to ComSpec when the shim cannot be read", () => {
    const shim = "C:\\bin\\codex.cmd";
    const out = resolveCodexInvocation(["app-server"], {
      platform: "win32",
      env: { PATH: "C:\\bin", ComSpec: "C:\\Windows\\cmd.exe" },
      exists: (p) => p === shim,
      readFile: () => {
        throw new Error("EACCES");
      },
    });

    expect(out).toEqual({
      cmd: "C:\\Windows\\cmd.exe",
      args: ["/d", "/s", "/c", "codex", "app-server"],
      spawnedViaCmd: true,
    });
  });

  it("falls back to ComSpec when the shim holds no script reference", () => {
    const shim = "C:\\bin\\codex.cmd";
    const out = resolveCodexInvocation(["app-server"], {
      platform: "win32",
      env: { PATH: "C:\\bin" },
      exists: (p) => p === shim,
      readFile: () => "@ECHO OFF\r\ncodex-native.exe %*\r\n",
    });

    expect(out.spawnedViaCmd).toBe(true);
    expect(out.args).toEqual(["/d", "/s", "/c", "codex", "app-server"]);
  });

  it("falls back to ComSpec when the referenced script is absent from disk", () => {
    const shim = "C:\\bin\\codex.cmd";
    const out = resolveCodexInvocation(["app-server"], {
      platform: "win32",
      env: { PATH: "C:\\bin" },
      exists: (p) => p === shim,
      readFile: () => '"%~dp0\\..\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
    });

    expect(out.spawnedViaCmd).toBe(true);
  });

  it("expands %dp0% and resolves a relative script against the shim directory", () => {
    const shim = "C:\\bin\\codex.bat";
    const script = "C:\\bin\\lib\\runner.mjs";
    const out = resolveCodexInvocation(["app-server"], {
      platform: "win32",
      env: { PATH: "C:\\bin" },
      exists: (p) => p === shim || p === script,
      readFile: () => 'node "lib/runner.mjs" %*',
    });

    expect(out.cmd).toBe(process.execPath);
    expect(out.args).toEqual([script, "app-server"]);
    expect(out.spawnedViaCmd).toBe(false);
  });

  it("expands %~dp0 for a shim sitting at a drive root without doubling the separator", () => {
    const shim = "C:\\codex.cmd";
    const script = "C:\\lib\\codex.js";
    const out = resolveCodexInvocation(["app-server"], {
      platform: "win32",
      env: { PATH: "C:\\" },
      exists: (p) => p === shim || p === script,
      readFile: () => 'node "%~dp0lib\\codex.js" %*',
    });

    expect(out.cmd).toBe(process.execPath);
    expect(out.args).toEqual([script, "app-server"]);
  });

  it("prefers the script whose path segment names the command over the last match", () => {
    const shim = "C:\\bin\\codex.cmd";
    const preferred = "C:\\pkgs\\codex\\lib\\entry.cjs";
    const out = resolveCodexInvocation([], {
      platform: "win32",
      env: { PATH: "C:\\bin" },
      exists: (p) => p === shim || p === preferred,
      readFile: () =>
        ['"C:\\pkgs\\codex\\lib\\entry.cjs"', '"C:\\pkgs\\other\\lib\\tail.js"'].join("\r\n"),
    });

    expect(out.args[0]).toBe(preferred);
  });

  it("uses the last script reference when nothing names the command", () => {
    const shim = "C:\\bin\\codex.cmd";
    const last = "C:\\pkgs\\other\\lib\\tail.js";
    const out = resolveCodexInvocation([], {
      platform: "win32",
      env: { PATH: "C:\\bin" },
      exists: (p) => p === shim || p === last,
      readFile: () => ['"C:\\pkgs\\alpha\\lib\\head.js"', `"${last}"`].join("\r\n"),
    });

    expect(out.args[0]).toBe(last);
  });

  it("resolves a shim for a custom command name containing regex metacharacters", () => {
    const shim = "C:\\bin\\codex.v2.cmd";
    const script = "C:\\pkgs\\codex.v2\\bin\\codex.v2.js";
    const out = resolveCodexInvocation(["app-server"], {
      platform: "win32",
      env: { PATH: "C:\\bin" },
      exists: (p) => p === shim || p === script,
      readFile: () => `"${script}" %*`,
      codexCommand: "codex.v2",
    });

    expect(out.cmd).toBe(process.execPath);
    expect(out.args).toEqual([script, "app-server"]);
  });

  it("falls back to ComSpec when a PATH hit has no recognised extension", () => {
    const bare = "C:\\bin\\codex";
    const out = resolveCodexInvocation(["app-server"], {
      platform: "win32",
      env: { PATH: "C:\\bin" },
      exists: (p) => p === bare,
      readFile: () => "",
    });

    expect(out.spawnedViaCmd).toBe(true);
    expect(out.cmd).toBe("cmd.exe");
  });
});

describe("findOnPath", () => {
  it("scans PATH entries in order and appends each extension", () => {
    const probed: string[] = [];
    const hit = findOnPath(
      "codex",
      { PATH: "C:\\first;C:\\second" },
      (p) => {
        probed.push(p);
        return p === "C:\\second\\codex.cmd";
      },
      path.win32,
      ";",
      [".exe", ".cmd"]
    );

    expect(hit).toBe("C:\\second\\codex.cmd");
    expect(probed.slice(0, 3)).toEqual([
      "C:\\first\\codex.exe",
      "C:\\first\\codex.cmd",
      "C:\\first\\codex",
    ]);
  });

  it("matches an extensionless entry after every extension misses", () => {
    const hit = findOnPath(
      "codex",
      { PATH: "/usr/local/bin" },
      (p) => p === "/usr/local/bin/codex",
      path.posix,
      ":",
      [".exe"]
    );

    expect(hit).toBe("/usr/local/bin/codex");
  });

  it("strips surrounding quotes and blank entries from PATH", () => {
    const hit = findOnPath(
      "codex",
      { PATH: '  "C:\\Program Files\\bin"  ;;C:\\other' },
      (p) => p === "C:\\Program Files\\bin\\codex.exe",
      path.win32,
      ";",
      [".exe"]
    );

    expect(hit).toBe("C:\\Program Files\\bin\\codex.exe");
  });

  it("falls back to the Path and path spellings of the variable", () => {
    const viaPath = findOnPath(
      "codex",
      { Path: "C:\\mixed" },
      (p) => p === "C:\\mixed\\codex.exe",
      path.win32,
      ";",
      [".exe"]
    );
    const viaLower = findOnPath(
      "codex",
      { path: "C:\\lower" },
      (p) => p === "C:\\lower\\codex.exe",
      path.win32,
      ";",
      [".exe"]
    );

    expect(viaPath).toBe("C:\\mixed\\codex.exe");
    expect(viaLower).toBe("C:\\lower\\codex.exe");
  });

  it("returns undefined when the variable is unset", () => {
    expect(findOnPath("codex", {}, () => true, path.posix, ":", [".exe"])).toBeUndefined();
  });
});
