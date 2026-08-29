/**
 * Detect whether the codex binary supports app-server mode.
 *
 * Falls back to exec mode when app-server is unavailable.
 * Can be overridden via CODEX_MCP_MODE env var.
 */
import { spawn, type ChildProcess } from "child_process";
import { resolveCodexInvocation } from "./codex-bin.js";

export type ClientMode = "app-server" | "exec";

const DETECTION_TIMEOUT_MS = 5_000;
/**
 * Budget for the second attempt. The first probe pays the cold cost — page
 * cache miss on a slow filesystem, on-access virus scan — that a retry does
 * not, so an answer that missed the first budget usually fits this one.
 */
const DETECTION_RETRY_TIMEOUT_MS = 10_000;
const KILL_GRACE_MS = 2_000;

/**
 * What the probe learned. `indeterminate` is not evidence about the binary:
 * the probe itself did not produce an answer.
 */
type ProbeOutcome =
  | { kind: "supported"; detail: string }
  | { kind: "unsupported"; detail: string }
  | { kind: "indeterminate"; detail: string; timedOut: boolean };

/**
 * Detect whether the codex binary supports app-server mode.
 *
 * 1. If CODEX_MCP_MODE is set, use it directly.
 * 2. Otherwise probe `<binary> app-server --help` with a timeout.
 *
 * A probe that produced no answer picks exec mode, the mode that works on the
 * widest set of CLIs, and says on stderr that the choice is a fallback rather
 * than a reading of this binary — the two are indistinguishable in the mode
 * itself, and every fork, resume and approval of the process depends on which
 * one happened.
 */
export async function detectClientMode(
  codexCommand: string,
  codexIsPath = false,
  env: NodeJS.ProcessEnv = process.env
): Promise<ClientMode> {
  const override = env.CODEX_MCP_MODE;
  if (override === "app-server" || override === "exec") {
    return override;
  }

  let outcome = await runProbe(codexCommand, codexIsPath, env, DETECTION_TIMEOUT_MS);
  if (outcome.kind === "indeterminate" && outcome.timedOut) {
    console.error(
      `[codex-mcp] app-server probe did not answer within ${DETECTION_TIMEOUT_MS}ms; retrying once with ${DETECTION_RETRY_TIMEOUT_MS}ms`
    );
    outcome = await runProbe(codexCommand, codexIsPath, env, DETECTION_RETRY_TIMEOUT_MS);
  }

  switch (outcome.kind) {
    case "supported":
      console.error(`[codex-mcp] app-server probe: supported (${outcome.detail})`);
      return "app-server";
    case "unsupported":
      console.error(`[codex-mcp] app-server probe: not supported (${outcome.detail})`);
      return "exec";
    default:
      console.error(
        `[codex-mcp] app-server probe: no answer (${outcome.detail}). ` +
          `Using exec mode as a fallback for the whole process lifetime — fork, resume and approvals stay unavailable. ` +
          `Set CODEX_MCP_MODE=app-server or CODEX_MCP_MODE=exec to skip the probe.`
      );
      return "exec";
  }
}

/** Run one probe, turning a spawn-time exception into an outcome. */
async function runProbe(
  codexCommand: string,
  codexIsPath: boolean,
  env: NodeJS.ProcessEnv,
  timeoutMs: number
): Promise<ProbeOutcome> {
  try {
    return await probeAppServer(codexCommand, codexIsPath, env, timeoutMs);
  } catch (err) {
    return {
      kind: "indeterminate",
      detail: `probe could not be started: ${err instanceof Error ? err.message : String(err)}`,
      timedOut: false,
    };
  }
}

/** What one probe exit says about the subcommand: its code first, then what it printed. */
function interpretProbeExit(code: number | null, stdout: string, stderr: string): ProbeOutcome {
  if (code === 0) {
    return { kind: "supported", detail: "probe exited 0" };
  }
  const combined = (stdout + stderr).toLowerCase();
  const isUnknown =
    combined.includes("unknown") ||
    combined.includes("unrecognized") ||
    combined.includes("not found") ||
    combined.includes("no such subcommand");
  if (isUnknown) {
    return {
      kind: "unsupported",
      detail: `probe exited ${code} calling the subcommand unknown`,
    };
  }
  if (combined.includes("app-server")) {
    return { kind: "supported", detail: `probe exited ${code} documenting the subcommand` };
  }
  return {
    kind: "indeterminate",
    detail: `probe exited ${code} without mentioning the subcommand: ${summarize(stdout + stderr)}`,
    timedOut: false,
  };
}

/**
 * ENOENT or another spawn failure: this says the binary could not be run, not
 * that it lacks the subcommand.
 */
function spawnFailureOutcome(err: unknown): ProbeOutcome {
  return {
    kind: "indeterminate",
    detail: `probe process failed to run: ${err instanceof Error ? err.message : String(err)}`,
    timedOut: false,
  };
}

/** Take down a probe that outlived its budget: terminate, then force kill after the grace period. */
function terminateProbe(proc: ChildProcess): void {
  try {
    proc.kill("SIGTERM");
  } catch {
    // ignore
  }
  // Force kill after grace period if still alive
  const forceKill = setTimeout(() => {
    try {
      if (!proc.killed && proc.exitCode === null) {
        proc.kill("SIGKILL");
      }
    } catch {
      /* ignore */
    }
  }, KILL_GRACE_MS);
  if (forceKill.unref) forceKill.unref();
}

/**
 * Probe whether `<binary> app-server --help` succeeds.
 */
function probeAppServer(
  codexCommand: string,
  codexIsPath: boolean,
  env: NodeJS.ProcessEnv,
  timeoutMs: number
): Promise<ProbeOutcome> {
  return new Promise((resolve) => {
    const invocation = resolveCodexInvocation(["app-server", "--help"], {
      env,
      codexCommand,
      codexIsPath,
    });

    let settled = false;
    const settle = (outcome: ProbeOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };

    let stdout = "";
    let stderr = "";

    const proc = spawn(invocation.cmd, invocation.args, {
      stdio: ["ignore", "pipe", "pipe"],
      env,
      windowsHide: true,
    });

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("error", (err) => settle(spawnFailureOutcome(err)));
    proc.on("exit", (code) => settle(interpretProbeExit(code, stdout, stderr)));

    const timer = setTimeout(() => {
      terminateProbe(proc);
      settle({
        kind: "indeterminate",
        detail: `probe still running after ${timeoutMs}ms`,
        timedOut: true,
      });
    }, timeoutMs);
    if (timer.unref) timer.unref();
  });
}

/** One line of probe output for the log, capped so a help page cannot fill it. */
function summarize(output: string): string {
  const trimmed = output.trim().replace(/\s+/g, " ");
  if (!trimmed) return "no output";
  return trimmed.length > 120 ? `${trimmed.slice(0, 120)}…` : trimmed;
}
