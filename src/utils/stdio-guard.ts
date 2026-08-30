/**
 * STDIO preflight guard.
 *
 * Purpose:
 * - Detect elevated risk of stdout contamination before MCP stdio handshake.
 * - Support caller-selected behavior via CODEX_MCP_STDIO_MODE.
 */

const STDIO_MODES = ["auto", "strict", "off"] as const;
export type StdioMode = (typeof STDIO_MODES)[number];

export interface StdioModeResolution {
  mode: StdioMode;
  source: "default" | "env" | "env_invalid";
  invalidRaw?: string;
}

export interface StdioPreflightOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
}

export interface StdioPreflightResult {
  mode: StdioMode;
  modeSource: StdioModeResolution["source"];
  invalidMode?: string;
  riskLevel: "low" | "elevated";
  riskReasons: string[];
  blockingReasons: string[];
  notes: string[];
  suggestions: string[];
  shouldBlock: boolean;
}

export function resolveStdioMode(env: NodeJS.ProcessEnv = process.env): StdioModeResolution {
  const raw = env.CODEX_MCP_STDIO_MODE;
  if (raw === undefined) {
    return { mode: "auto", source: "default" };
  }

  const normalized = raw.trim().toLowerCase();
  if (normalized === "") {
    return { mode: "auto", source: "default" };
  }

  if ((STDIO_MODES as readonly string[]).includes(normalized)) {
    return { mode: normalized as StdioMode, source: "env" };
  }

  return { mode: "auto", source: "env_invalid", invalidRaw: raw };
}

interface PreflightInputs {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
}

/** What the preflight measures: whatever the caller named, and this process for the rest. */
function resolvePreflightInputs(opts: StdioPreflightOptions): PreflightInputs {
  return {
    platform: opts.platform ?? process.platform,
    env: opts.env ?? process.env,
    stdinIsTTY: opts.stdinIsTTY ?? Boolean(process.stdin.isTTY),
    stdoutIsTTY: opts.stdoutIsTTY ?? Boolean(process.stdout.isTTY),
  };
}

interface StdoutRisks {
  /** Every reason stdout may already carry text; one of them makes the risk elevated. */
  reasons: string[];
  /** The subset strict mode refuses to start under. */
  blocking: string[];
  /** The reasons stated on their own line, whatever the risk level comes out as. */
  notes: string[];
}

/**
 * What raises the risk of text on stdout before the MCP handshake.
 *
 * A PowerShell profile prints its banner before this process starts, so it is reported
 * and nothing more. A TTY on either end says the client launched the server without
 * piping stdio, which is the condition strict mode refuses to start under.
 */
function surveyStdoutRisks(inputs: PreflightInputs): StdoutRisks {
  const risks: StdoutRisks = { reasons: [], blocking: [], notes: [] };

  if (inputs.platform === "win32" && looksLikePowerShell(inputs.env)) {
    risks.reasons.push(
      "PowerShell environment detected on Windows; shell profiles can print banner text to stdout."
    );
  }

  if (inputs.stdinIsTTY || inputs.stdoutIsTTY) {
    const ttyRisk =
      "STDIO appears attached to a terminal (TTY). MCP clients should launch codex-mcp with piped stdio.";
    risks.notes.push(ttyRisk);
    risks.reasons.push(ttyRisk);
    risks.blocking.push(ttyRisk);
  }

  return risks;
}

export function runStdioPreflight(opts: StdioPreflightOptions = {}): StdioPreflightResult {
  const inputs = resolvePreflightInputs(opts);
  const modeResolution = resolveStdioMode(inputs.env);
  const notes: string[] = [];

  if (modeResolution.source === "env_invalid" && modeResolution.invalidRaw) {
    notes.push(
      `Invalid CODEX_MCP_STDIO_MODE='${modeResolution.invalidRaw}'. Falling back to 'auto'.`
    );
  }

  // In "off" mode, guard is intentionally disabled.
  if (modeResolution.mode === "off") {
    return guardDisabledResult(modeResolution, notes);
  }

  const risks = surveyStdoutRisks(inputs);
  const elevated = risks.reasons.length > 0;

  return {
    mode: modeResolution.mode,
    modeSource: modeResolution.source,
    invalidMode: modeResolution.invalidRaw,
    riskLevel: elevated ? "elevated" : "low",
    riskReasons: risks.reasons,
    blockingReasons: risks.blocking,
    notes: [...notes, ...risks.notes],
    suggestions: elevated ? buildFixSuggestions(inputs.platform) : [],
    shouldBlock: modeResolution.mode === "strict" && risks.blocking.length > 0,
  };
}

/** What the preflight reports when the caller switched the guard off: the mode it read, and nothing else. */
function guardDisabledResult(
  modeResolution: StdioModeResolution,
  notes: string[]
): StdioPreflightResult {
  return {
    mode: modeResolution.mode,
    modeSource: modeResolution.source,
    invalidMode: modeResolution.invalidRaw,
    riskLevel: "low",
    riskReasons: [],
    blockingReasons: [],
    notes,
    suggestions: [],
    shouldBlock: false,
  };
}

function looksLikePowerShell(env: NodeJS.ProcessEnv): boolean {
  return Boolean(
    env.POWERSHELL_DISTRIBUTION_CHANNEL ||
      env.PSModulePath ||
      env.PSExecutionPolicyPreference ||
      env.PSModuleAnalysisCachePath
  );
}

function buildFixSuggestions(platform: NodeJS.Platform): string[] {
  const generic = [
    "Prefer direct MCP config launch: command='npx', args=['-y', '@kvokka/codex-mcp']",
    "Keep server stdout strictly JSON-RPC; route diagnostics to stderr only.",
    "codex-mcp cannot sanitize shell/profile stdout once emitted before MCP handshake.",
  ];

  if (platform === "win32") {
    return [
      'If shell wrapping is required, use: pwsh -NoProfile -Command "npx -y @kvokka/codex-mcp"',
      "Disable noisy PowerShell profile output (oh-my-posh banners, startup prompts, etc.).",
      ...generic,
    ];
  }

  return generic;
}
