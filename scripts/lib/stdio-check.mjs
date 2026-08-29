// What `check:stdio` measures: a server that writes nothing to stdout before a
// client connects, because the stdio transport carries JSON-RPC there and
// nothing else.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const STDIO_MODES = ["auto", "strict", "off"];

/** @param {string} raw @returns {string | undefined} */
export function readStdioMode(raw) {
  const normalized = raw.trim().toLowerCase();
  return STDIO_MODES.includes(normalized) ? normalized : undefined;
}

/** @param {string} raw @returns {number | undefined} */
export function readPositiveMs(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/**
 * The environment the checked server starts in. It takes a single-writer lock
 * on its state directory and recovers whatever sessions it finds there, so left
 * at the default the check would do that to the caller's real
 * `~/.codex-mcp/state`.
 *
 * @param {Record<string, string | undefined>} env
 * @param {string} stdioMode
 * @param {string} tmpDir
 */
export function stdioCheckEnv(env, stdioMode, tmpDir) {
  return {
    ...env,
    CODEX_MCP_STDIO_MODE: stdioMode,
    CODEX_MCP_STATE_DIR: env.CODEX_MCP_STATE_DIR ?? path.join(tmpDir, "state"),
  };
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Runs the child for `timeoutMs`, terminates it, and returns what it wrote.
 *
 * @param {{ command: string, args: string[], cwd: string, env: object, timeoutMs: number, dir: string }} spawnSpec
 */
export async function captureChildOutput(spawnSpec) {
  const { command, args, cwd, env, timeoutMs, dir } = spawnSpec;
  const stdoutPath = path.join(dir, "stdout.log");
  const stderrPath = path.join(dir, "stderr.log");

  const stdoutFd = fs.openSync(stdoutPath, "w");
  const stderrFd = fs.openSync(stderrPath, "w");

  const child = spawn(command, args, {
    cwd,
    stdio: ["ignore", stdoutFd, stderrFd],
    windowsHide: true,
    shell: false,
    env,
  });
  let exitCode = null;
  let exitSignal = null;
  child.on("exit", (code, signal) => {
    exitCode = code;
    exitSignal = signal;
  });

  await wait(timeoutMs);

  // Best-effort terminate; if it already died, ignore.
  try {
    child.kill();
  } catch {
    // ignore
  }

  // Give the process a moment to flush output.
  await wait(200);

  fs.closeSync(stdoutFd);
  fs.closeSync(stderrFd);

  return {
    stdout: fs.readFileSync(stdoutPath, "utf8"),
    stderr: fs.readFileSync(stderrPath, "utf8"),
    exitCode,
    exitSignal,
    stdoutPath,
    stderrPath,
  };
}

/** @param {string} platform */
export function getFixHints(platform) {
  const generic = [
    "Prefer MCP config launch: command='bunx', args=['@kvokka/codex-mcp']",
    "Ensure stdout remains JSON-RPC only; route diagnostics to stderr.",
  ];
  if (platform === "win32") {
    return [
      'If shell wrapping is required, use: pwsh -NoProfile -Command "bunx @kvokka/codex-mcp"',
      ...generic,
    ];
  }
  return generic;
}

/**
 * A child that died on its own, or on a signal this check did not send, never
 * reached a healthy startup.
 *
 * @param {{ childExitCode: number | null, childExitSignal: string | null }} report
 */
export function isRuntimeFailure(report) {
  return (
    (typeof report.childExitCode === "number" && report.childExitCode !== 0) ||
    (typeof report.childExitSignal === "string" &&
      report.childExitSignal !== "SIGTERM" &&
      report.childExitSignal !== "SIGKILL")
  );
}

/**
 * @param {{
 *   stdioMode: string, command: string, args: string[], cwd: string, timeoutMs: number,
 *   stdout: string, stderr: string, exitCode: number | null, exitSignal: string | null,
 *   stdoutPath: string, stderrPath: string, platform: string,
 * }} run
 */
export function buildStdioReport(run) {
  const report = {
    ok: false,
    mode: run.stdioMode,
    command: run.command,
    args: run.args,
    cwd: run.cwd,
    timeoutMs: run.timeoutMs,
    childExitCode: run.exitCode,
    childExitSignal: run.exitSignal,
    stdoutBytes: Buffer.byteLength(run.stdout, "utf8"),
    stderrBytes: Buffer.byteLength(run.stderr, "utf8"),
    stdoutPreview: run.stdout.slice(0, 400),
    stderrPreview: run.stderr.slice(0, 400),
    logs: {
      stdoutPath: run.stdoutPath,
      stderrPath: run.stderrPath,
    },
    hints: getFixHints(run.platform),
  };
  report.ok = run.stdout.trim().length === 0 && !isRuntimeFailure(report);
  return report;
}

/**
 * The stderr lines the check prints, one per line.
 *
 * @param {ReturnType<typeof buildStdioReport>} report
 * @param {{ stdout: string, stderr: string }} output
 * @returns {string[]}
 */
export function describeStdioReport(report, output) {
  const hints = report.hints.map((hint) => `Hint: ${hint}`);
  const captured = `Captured logs: ${report.logs.stdoutPath} (stdout), ${report.logs.stderrPath} (stderr)`;
  const head = [`Mode: ${report.mode}`, `Spawned: ${report.command} ${report.args.join(" ")}`];

  if (isRuntimeFailure(report)) {
    return [
      ...head,
      `FAIL: child exited before healthy startup (exitCode=${report.childExitCode}, signal=${report.childExitSignal}).`,
      ...hints,
      captured,
    ];
  }

  if (output.stdout.trim().length > 0) {
    return [
      ...head,
      "FAIL: stdout is not clean. First 400 chars:\n",
      report.stdoutPreview,
      "\n---\nHint: anything printed to stdout will break MCP stdio handshake.",
      ...hints,
      captured,
    ];
  }

  const note = output.stderr.trim().length > 0 ? ["(Note) server wrote to stderr (this is fine)."] : [];
  return [...head, "OK: stdout is clean.", ...note, captured];
}
