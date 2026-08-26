/**
 * Resolve which `codex` executable to use.
 *
 * Resolution priority (mirrors claude-code-mcp's claude-executable.ts):
 *   1. CODEX_MCP_PATH  — absolute/relative filesystem path
 *   2. CODEX_MCP_COMMAND — bare command name resolved from PATH
 *   3. Auto-detect: try "codex", then "codex-internal" on PATH
 *   4. Fall back to "codex" (let spawn fail with a clear error later)
 *
 * CODEX_MCP_PATH and CODEX_MCP_COMMAND are mutually exclusive.
 */
import { accessSync, constants, existsSync, statSync } from "fs";
import path from "path";

// ── Env var names ─────────────────────────────────────────────────
export const CODEX_MCP_COMMAND = "CODEX_MCP_COMMAND";
export const CODEX_MCP_PATH = "CODEX_MCP_PATH";

// ── Auto-detection candidates (tried in order) ───────────────────
export const AUTO_CODEX_COMMANDS = ["codex", "codex-internal"] as const;

// ── Types ─────────────────────────────────────────────────────────
export type CodexExecutableSource = "env_path" | "env_command" | "auto_detect" | "default";

export interface CodexExecutableInfo {
  /** The concrete executable path or fallback bare command to use */
  command: string;
  /** True when `command` is a filesystem path (not a bare name) */
  isPath: boolean;
  /** How the value was determined */
  source: CodexExecutableSource;
}

// ── Module state ──────────────────────────────────────────────────
let _resolved: CodexExecutableInfo | undefined;

// ── PATH helpers ──────────────────────────────────────────────────

const WINDOWS_SUPPORTED_EXTENSIONS = [".com", ".exe", ".bat", ".cmd"] as const;

function stripSurroundingQuotes(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  return value;
}

function normalizeMaybeQuotedToken(raw: string): string {
  return stripSurroundingQuotes(raw.trim());
}

function normalizeWindowsExtension(value: string): string | undefined {
  const trimmed = stripSurroundingQuotes(value.trim());
  if (!trimmed) return undefined;
  return trimmed.startsWith(".") ? trimmed.toLowerCase() : `.${trimmed.toLowerCase()}`;
}

function isExecutableFile(candidate: string): boolean {
  try {
    const stat = statSync(candidate);
    if (!stat.isFile()) return false;
    if (process.platform === "win32") return true;
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function getPathEntries(env: NodeJS.ProcessEnv): string[] {
  const pathEnv = env.PATH || env.Path || env.path || "";
  return pathEnv
    .split(process.platform === "win32" ? ";" : ":")
    .map((entry) => stripSurroundingQuotes(entry.trim()))
    .filter(Boolean);
}

function getPathExtensions(env: NodeJS.ProcessEnv): string[] {
  if (process.platform !== "win32") return [""];
  const configured =
    env.PATHEXT ?? env.Pathext ?? env.pathext ?? process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD";
  const configuredExts = configured
    .split(";")
    .map((entry) => normalizeWindowsExtension(entry))
    .filter((entry): entry is string => Boolean(entry));
  const merged = configuredExts.filter((ext) =>
    WINDOWS_SUPPORTED_EXTENSIONS.includes(ext as never)
  );
  for (const ext of WINDOWS_SUPPORTED_EXTENSIONS) {
    if (!merged.includes(ext)) merged.push(ext);
  }
  return Array.from(new Set(merged));
}

function resolveCommandFromPath(command: string, env: NodeJS.ProcessEnv): string | undefined {
  const dirs = getPathEntries(env);
  const ext = process.platform === "win32" ? path.extname(command) : "";
  // Windows takes executability from the name's extension, not from a mode bit: a PATH hit
  // without a PATHEXT suffix cannot be handed to CreateProcess, so it is not a candidate there.
  const names =
    process.platform === "win32"
      ? ext
        ? [command]
        : Array.from(new Set(getPathExtensions(env).map((suffix) => `${command}${suffix}`)))
      : [command];

  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (isExecutableFile(candidate)) return path.normalize(candidate);
    }
  }
  return undefined;
}

function looksLikePath(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

// ── Core resolution ───────────────────────────────────────────────

export function resolveDefaultCodexExecutable(
  env: NodeJS.ProcessEnv = process.env
): CodexExecutableInfo {
  const envPathRaw = env[CODEX_MCP_PATH]?.trim();
  const envCommandRaw = env[CODEX_MCP_COMMAND]?.trim();
  const envPath = envPathRaw ? normalizeMaybeQuotedToken(envPathRaw) : undefined;
  const envCommand = envCommandRaw ? normalizeMaybeQuotedToken(envCommandRaw) : undefined;

  // Mutually exclusive
  if (envPath && envCommand) {
    throw new Error(
      `Cannot set both ${CODEX_MCP_PATH} and ${CODEX_MCP_COMMAND}. Use one or the other.`
    );
  }

  // 1. Explicit filesystem path
  if (envPath) {
    const resolvedPath = path.resolve(envPath);
    if (!existsSync(resolvedPath)) {
      throw new Error(`${CODEX_MCP_PATH}="${envPath}" — file does not exist.`);
    }
    if (!isExecutableFile(resolvedPath)) {
      throw new Error(`${CODEX_MCP_PATH}="${envPath}" — not an executable file.`);
    }
    return { command: resolvedPath, isPath: true, source: "env_path" };
  }

  // 2. Explicit bare command name
  if (envCommand) {
    if (looksLikePath(envCommand)) {
      throw new Error(
        `${CODEX_MCP_COMMAND}="${envCommand}" looks like a path. Use ${CODEX_MCP_PATH} for filesystem paths.`
      );
    }
    const resolved = resolveCommandFromPath(envCommand, env);
    if (!resolved) {
      throw new Error(`${CODEX_MCP_COMMAND}="${envCommand}" was not found in PATH.`);
    }
    return { command: resolved, isPath: true, source: "env_command" };
  }

  // 3. Auto-detect from PATH
  for (const candidate of AUTO_CODEX_COMMANDS) {
    const resolved = resolveCommandFromPath(candidate, env);
    if (resolved) {
      return { command: resolved, isPath: true, source: "auto_detect" };
    }
  }

  // 4. Fall back to "codex" — let spawn surface a clear "not found" error later
  return { command: "codex", isPath: false, source: "default" };
}

// ── Public API ────────────────────────────────────────────────────

/**
 * Resolve and cache the default codex executable info.
 * Safe to call multiple times — resolution runs only once.
 */
export function getDefaultCodexExecutable(): CodexExecutableInfo {
  if (!_resolved) {
    _resolved = resolveDefaultCodexExecutable();
  }
  return _resolved;
}

/**
 * Startup check — resolves the executable and logs the result.
 * Throws on misconfiguration (mutually exclusive env vars, missing path).
 */
export function checkDefaultCodexExecutableAvailability(): void {
  const info = getDefaultCodexExecutable();
  switch (info.source) {
    case "env_path":
      console.error(`[codex-executable] Using ${CODEX_MCP_PATH}: ${info.command}`);
      break;
    case "env_command":
      console.error(`[codex-executable] Using ${CODEX_MCP_COMMAND}: resolved to ${info.command}`);
      break;
    case "auto_detect":
      console.error(`[codex-executable] Auto-detected executable: ${info.command}`);
      break;
    case "default":
      console.error(
        `[codex-executable] No codex found on PATH; falling back to "${info.command}". ` +
          `Set ${CODEX_MCP_COMMAND} or ${CODEX_MCP_PATH} to configure.`
      );
      break;
  }
}

/** Reset cached state (for testing). */
export function _resetForTesting(): void {
  _resolved = undefined;
}
