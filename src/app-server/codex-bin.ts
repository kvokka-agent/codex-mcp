/**
 * Resolve how to spawn the `codex` CLI across platforms.
 *
 * Goal: avoid going through a shell on Windows when possible (npm `.cmd` shims are shell-parsed),
 * while keeping "zero-config local integration" (PATH + ~/.codex/config.toml).
 *
 * The command name is configurable via the `codexCommand` field in `ResolverDeps`.
 * When `codexIsPath` is true, the value is treated as a direct filesystem path
 * and PATH resolution is skipped.
 */
import { existsSync, readFileSync } from "fs";
import path from "path";

export interface CodexInvocation {
  cmd: string;
  args: string[];
  /** True when spawning via `cmd.exe` (fallback path). */
  spawnedViaCmd: boolean;
}

type ResolverDeps = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exists?: (p: string) => boolean;
  readFile?: (p: string) => string;
  /** The codex command name or filesystem path. Defaults to "codex". */
  codexCommand?: string;
  /** True when `codexCommand` is a filesystem path (not a bare command name). */
  codexIsPath?: boolean;
};

export function resolveCodexInvocation(
  codexArgs: string[],
  deps: ResolverDeps = {}
): CodexInvocation {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const exists = deps.exists ?? existsSync;
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const delimiter = platform === "win32" ? ";" : ":";
  const codexCommand = deps.codexCommand ?? "codex";
  const codexIsPath = deps.codexIsPath ?? false;

  // ── Direct path mode ────────────────────────────────────────────
  // When an explicit filesystem path is provided, use it directly.
  // On Windows, .cmd/.bat files cannot be spawned directly — wrap via cmd.exe.
  if (codexIsPath) {
    if (
      platform === "win32" &&
      (codexCommand.toLowerCase().endsWith(".cmd") || codexCommand.toLowerCase().endsWith(".bat"))
    ) {
      const comspec = env.ComSpec || env.COMSPEC || "cmd.exe";
      return {
        cmd: comspec,
        args: ["/d", "/s", "/c", codexCommand, ...codexArgs],
        spawnedViaCmd: true,
      };
    }
    return { cmd: codexCommand, args: codexArgs, spawnedViaCmd: false };
  }

  // ── Non-Windows: bare command ───────────────────────────────────
  if (platform !== "win32") {
    return { cmd: codexCommand, args: codexArgs, spawnedViaCmd: false };
  }

  // ── Windows: try to resolve from PATH ───────────────────────────
  const shim = findOnPath(codexCommand, env, exists, pathApi, delimiter, [".exe", ".cmd", ".bat"]);
  if (shim && shim.toLowerCase().endsWith(".exe")) {
    return { cmd: shim, args: codexArgs, spawnedViaCmd: false };
  }

  if (shim && (shim.toLowerCase().endsWith(".cmd") || shim.toLowerCase().endsWith(".bat"))) {
    const script = tryResolveNodeScriptFromShim(shim, codexCommand, exists, readFile, pathApi);
    if (script) {
      return { cmd: process.execPath, args: [script, ...codexArgs], spawnedViaCmd: false };
    }
  }

  // Last resort: spawn via cmd.exe. Keep arguments as separate tokens to avoid nested-quote issues
  // when Node builds the final CreateProcess command line.
  const comspec = env.ComSpec || env.COMSPEC || "cmd.exe";
  return {
    cmd: comspec,
    args: ["/d", "/s", "/c", codexCommand, ...codexArgs],
    spawnedViaCmd: true,
  };
}

export function findOnPath(
  base: string,
  env: NodeJS.ProcessEnv,
  exists: (p: string) => boolean,
  pathApi: typeof path.posix | typeof path.win32,
  delimiter: string,
  exts: string[]
): string | undefined {
  const pathEnv = env.PATH || env.Path || env.path || "";
  const dirs = pathEnv
    .split(delimiter)
    .map((d) => stripSurroundingQuotes(d.trim()))
    .filter(Boolean);

  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = pathApi.join(dir, `${base}${ext}`);
      if (exists(candidate)) return candidate;
    }
    const raw = pathApi.join(dir, base);
    if (exists(raw)) return raw;
  }
  return undefined;
}

function stripSurroundingQuotes(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  return value;
}

function tryResolveNodeScriptFromShim(
  shimPath: string,
  codexCommand: string,
  exists: (p: string) => boolean,
  readFile: (p: string) => string,
  pathApi: typeof path.posix | typeof path.win32
): string | undefined {
  let contents: string;
  try {
    contents = readFile(shimPath);
  } catch {
    return undefined;
  }

  // npm `.cmd` shims typically contain a quoted script path ending in `.js` / `.cjs` / `.mjs`.
  const matches: string[] = [];
  const re = /"([^"]+\.(?:m?js|cjs))"/gi;
  for (;;) {
    const m = re.exec(contents);
    if (!m) break;
    matches.push(m[1]);
  }
  if (matches.length === 0) return undefined;

  // Escape the command name for use in regex matching
  const escapedCommand = codexCommand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const baseNameRe = new RegExp(escapedCommand, "i");
  const pathRe = new RegExp(
    `@openai\\\\${escapedCommand}|\\\\${escapedCommand}\\\\|\\/${escapedCommand}\\/`,
    "i"
  );

  const preferred =
    matches.find((m) => baseNameRe.test(pathApi.basename(m))) ??
    matches.find((m) => pathRe.test(m)) ??
    matches[matches.length - 1];

  const shimDir = pathApi.dirname(shimPath);
  const dp0 = shimDir.endsWith(pathApi.sep) ? shimDir : shimDir + pathApi.sep;
  let resolved = preferred.replace(/%~dp0/gi, dp0).replace(/%dp0%/gi, dp0);
  resolved = resolved.replace(/\//g, "\\");

  const abs = pathApi.isAbsolute(resolved)
    ? pathApi.normalize(resolved)
    : pathApi.resolve(shimDir, resolved);
  if (!exists(abs)) return undefined;
  return abs;
}
