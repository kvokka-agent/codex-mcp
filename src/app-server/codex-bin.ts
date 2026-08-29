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
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { stripSurroundingQuotes } from "../utils/strip-quotes.js";

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

/** The deps of one resolution, with every default already filled in. */
type ResolverContext = {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  exists: (p: string) => boolean;
  readFile: (p: string) => string;
  pathApi: typeof path.posix | typeof path.win32;
  delimiter: string;
  codexCommand: string;
};

function resolverContext(deps: ResolverDeps): ResolverContext {
  const platform = deps.platform ?? process.platform;
  return {
    platform,
    env: deps.env ?? process.env,
    exists: deps.exists ?? existsSync,
    readFile: deps.readFile ?? ((p: string) => readFileSync(p, "utf8")),
    pathApi: platform === "win32" ? path.win32 : path.posix,
    delimiter: platform === "win32" ? ";" : ":",
    codexCommand: deps.codexCommand ?? "codex",
  };
}

export function resolveCodexInvocation(
  codexArgs: string[],
  deps: ResolverDeps = {}
): CodexInvocation {
  const ctx = resolverContext(deps);
  const codexIsPath = deps.codexIsPath ?? false;

  // ── Direct path mode ────────────────────────────────────────────
  if (codexIsPath) {
    return resolveDirectPath(codexArgs, ctx);
  }

  // ── Non-Windows: bare command ───────────────────────────────────
  if (ctx.platform !== "win32") {
    return { cmd: ctx.codexCommand, args: codexArgs, spawnedViaCmd: false };
  }

  // ── Windows: try to resolve from PATH ───────────────────────────
  return resolveWindowsInvocation(codexArgs, ctx);
}

/**
 * Spawn an explicit filesystem path directly. On Windows, .cmd/.bat files
 * cannot be spawned directly — wrap via cmd.exe.
 */
function resolveDirectPath(codexArgs: string[], ctx: ResolverContext): CodexInvocation {
  if (ctx.platform === "win32" && isShimExtension(ctx.codexCommand)) {
    return spawnViaComSpec(codexArgs, ctx);
  }
  return { cmd: ctx.codexCommand, args: codexArgs, spawnedViaCmd: false };
}

/** Prefer a PATH `.exe`, then the node script an npm shim points at, then cmd.exe. */
function resolveWindowsInvocation(codexArgs: string[], ctx: ResolverContext): CodexInvocation {
  const shim = findOnPath(ctx.codexCommand, ctx.env, ctx.exists, ctx.pathApi, ctx.delimiter, [
    ".exe",
    ".cmd",
    ".bat",
  ]);
  if (shim?.toLowerCase().endsWith(".exe")) {
    return { cmd: shim, args: codexArgs, spawnedViaCmd: false };
  }

  if (shim && isShimExtension(shim)) {
    const script = tryResolveNodeScriptFromShim(
      shim,
      ctx.codexCommand,
      ctx.exists,
      ctx.readFile,
      ctx.pathApi
    );
    if (script) {
      return { cmd: process.execPath, args: [script, ...codexArgs], spawnedViaCmd: false };
    }
  }

  // Last resort: spawn via cmd.exe. Keep arguments as separate tokens to avoid nested-quote issues
  // when the runtime builds the final CreateProcess command line.
  return spawnViaComSpec(codexArgs, ctx);
}

function isShimExtension(command: string): boolean {
  const lower = command.toLowerCase();
  return lower.endsWith(".cmd") || lower.endsWith(".bat");
}

function spawnViaComSpec(codexArgs: string[], ctx: ResolverContext): CodexInvocation {
  const comspec = ctx.env.ComSpec || ctx.env.COMSPEC || "cmd.exe";
  return {
    cmd: comspec,
    args: ["/d", "/s", "/c", ctx.codexCommand, ...codexArgs],
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
