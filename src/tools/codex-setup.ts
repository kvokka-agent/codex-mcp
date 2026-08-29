import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { homedir } from "os";
import path from "path";
import { detectClientMode, type ClientMode } from "../app-server/detect.js";
import { resolveCodexInvocation } from "../app-server/codex-bin.js";
import {
  resolveDefaultCodexExecutable,
  type CodexExecutableInfo,
} from "../utils/codex-executable.js";

export interface CodexSetupInput {
  cwd?: string;
}

type AuthState = "authenticated" | "unauthenticated" | "unknown";

function isCodexInternalExecutable(info: CodexExecutableInfo): boolean {
  const ext = path.extname(info.command);
  return path.basename(info.command, ext).toLowerCase() === "codex-internal";
}

export interface CodexSetupResult {
  ready: boolean;
  cwd: string;
  executable: {
    ok: boolean;
    source: CodexExecutableInfo["source"] | "error";
    command?: string;
    isPath?: boolean;
    detail: string;
  };
  auth: {
    ok: boolean;
    state: AuthState;
    detail: string;
  };
  runtime: {
    sameMachineRequired: true;
    clientMode?: ClientMode;
    stateDir: string;
  };
  projectContext: {
    hasUserConfig: boolean;
    hasProjectConfig: boolean;
  };
  warnings: string[];
  nextSteps: string[];
}

function classifyAuthResult(status: number | null, combined: string): AuthState {
  if (status === 0) return "authenticated";
  if (/(not (logged|authenticated)|login required|run\s+codex\s+login)/i.test(combined)) {
    return "unauthenticated";
  }
  return "unknown";
}

function resolveCodexStateDir(): string {
  const configured = process.env.CODEX_MCP_STATE_DIR?.trim();
  return configured && configured !== "" ? configured : path.join(homedir(), ".codex-mcp", "state");
}

function probeCodexAuth(info: CodexExecutableInfo): CodexSetupResult["auth"] {
  if (isCodexInternalExecutable(info)) {
    return {
      ok: true,
      state: "unknown",
      detail:
        "Using a codex-internal executable; auth/login readiness is not probed and does not block setup readiness.",
    };
  }

  const invocation = resolveCodexInvocation(["login", "status"], {
    codexCommand: info.command,
    codexIsPath: info.isPath,
  });
  const run = spawnSync(invocation.cmd, invocation.args, {
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
  });
  const combined = `${run.stdout ?? ""}\n${run.stderr ?? ""}`.trim();
  if (run.error) {
    return {
      ok: false,
      state: "unknown",
      detail: `Failed to probe auth status: ${run.error.message}`,
    };
  }
  const state = classifyAuthResult(run.status, combined);
  return {
    // Only an answer the probe classified as authenticated clears this gate: an output no
    // pattern matched says nothing about login state, and reporting it as ok would let a
    // caller start a session that fails on authentication.
    ok: state === "authenticated",
    state,
    detail: combined || (state === "authenticated" ? "Authenticated." : "Auth status unknown."),
  };
}

/** What the local machine answered about Codex, or what went wrong asking. */
interface CodexProbe {
  executable: CodexSetupResult["executable"];
  auth: CodexSetupResult["auth"];
  clientMode?: ClientMode;
  internalExecutable: boolean;
}

async function probeCodexEnvironment(): Promise<CodexProbe> {
  let internalExecutable = false;
  try {
    const info = resolveDefaultCodexExecutable();
    const available = info.source !== "default";
    internalExecutable = isCodexInternalExecutable(info);
    const executable: CodexSetupResult["executable"] = {
      ok: available,
      source: info.source,
      command: info.command,
      isPath: info.isPath,
      detail:
        info.source === "default"
          ? "No codex executable was auto-detected; the server would fall back to `codex` and let process spawn fail later."
          : `Codex resolves via ${info.source}.`,
    };

    if (!available) {
      return {
        executable,
        auth: {
          ok: false,
          state: "unknown",
          detail: "Auth status not checked because no codex executable was detected.",
        },
        internalExecutable,
      };
    }

    const auth = probeCodexAuth(info);
    const clientMode = await detectClientMode(info.command, info.isPath);
    return { executable, auth, clientMode, internalExecutable };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      executable: {
        ok: false,
        source: "error",
        detail: message,
      },
      auth: {
        ok: false,
        state: "unknown",
        detail: "Auth status not checked because executable resolution failed.",
      },
      internalExecutable,
    };
  }
}

function collectSetupAdvice(
  probe: CodexProbe,
  projectContext: CodexSetupResult["projectContext"]
): Pick<CodexSetupResult, "warnings" | "nextSteps"> {
  const warnings: string[] = [];
  const nextSteps: string[] = [];

  if (!probe.executable.ok) {
    warnings.push(probe.executable.detail);
    nextSteps.push(
      "Install Codex or fix CODEX_MCP_COMMAND / CODEX_MCP_PATH so the executable can be resolved."
    );
  }
  if (probe.auth.state === "unauthenticated") {
    warnings.push(probe.auth.detail);
    nextSteps.push("Run `codex login` and rerun `codex_setup`.");
  } else if (probe.auth.state === "unknown" && !probe.internalExecutable) {
    warnings.push(probe.auth.detail);
    nextSteps.push(
      "Verify Codex authentication explicitly (for example with `codex login status`) before relying on this environment."
    );
  }
  if (!projectContext.hasUserConfig && !projectContext.hasProjectConfig) {
    warnings.push("No Codex config.toml was found in ~/.codex or this project.");
  }
  if (probe.clientMode === "exec") {
    warnings.push(
      "Codex app-server support was not detected; codex-mcp would run in exec fallback mode with fewer capabilities."
    );
  }

  return { warnings, nextSteps };
}

export async function executeCodexSetup(
  input: CodexSetupInput | undefined,
  serverCwd: string
): Promise<CodexSetupResult> {
  const cwd = input?.cwd && input.cwd.trim() !== "" ? input.cwd : serverCwd;
  const probe = await probeCodexEnvironment();

  const projectContext = {
    hasUserConfig: existsSync(path.join(homedir(), ".codex", "config.toml")),
    hasProjectConfig: existsSync(path.join(cwd, ".codex", "config.toml")),
  };

  const { warnings, nextSteps } = collectSetupAdvice(probe, projectContext);

  return {
    ready: probe.executable.ok && probe.auth.ok,
    cwd,
    executable: probe.executable,
    auth: probe.auth,
    runtime: {
      sameMachineRequired: true,
      clientMode: probe.clientMode,
      stateDir: resolveCodexStateDir(),
    },
    projectContext,
    warnings,
    nextSteps,
  };
}
