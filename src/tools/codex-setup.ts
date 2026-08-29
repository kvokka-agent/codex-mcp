import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { resolveCodexInvocation } from "../app-server/codex-bin.js";
import type { PermissionProfileSummary } from "../app-server/protocol.js";
import {
  type CodexExecutableInfo,
  resolveDefaultCodexExecutable,
} from "../utils/codex-executable.js";
import {
  belowMinimumCodexCliMessage,
  detectCodexCliVersion,
  isCodexCliBelowMinimum,
  MIN_CODEX_CLI_VERSION,
} from "../utils/codex-version.js";

export interface CodexSetupInput {
  cwd?: string;
}

/**
 * Reads the permission profiles of a working directory.
 *
 * The ids come from the user's own `config.toml` and from the project layers
 * under that directory, so only the local Codex can name them; every caller
 * hands one in, and the one that ships stands up a `codex app-server` for it.
 */
export type PermissionProfileLister = (cwd: string) => Promise<PermissionProfileSummary[]>;

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
  backend: {
    ok: boolean;
    cliVersion: string | null;
    minimumCliVersion: string;
    detail: string;
  };
  runtime: {
    sameMachineRequired: true;
    stateDir: string;
  };
  projectContext: {
    hasUserConfig: boolean;
    hasProjectConfig: boolean;
  };
  /**
   * The ids a `codex` or `codex_reply` call may pass as `permissions`.
   *
   * `profiles` is absent unless the listing answered: a listing that failed, or
   * one that was never run because no executable resolved, says nothing about
   * which profiles exist, and an empty array there would read as a machine that
   * offers none.
   */
  permissionProfiles: {
    ok: boolean;
    profiles?: PermissionProfileSummary[];
    detail: string;
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
  backend: CodexSetupResult["backend"];
  internalExecutable: boolean;
}

/** What the CLI answered about its own version, and whether that clears the floor. */
function probeCodexBackend(): CodexSetupResult["backend"] {
  const cliVersion = detectCodexCliVersion();
  if (cliVersion === null) {
    return {
      ok: false,
      cliVersion,
      minimumCliVersion: MIN_CODEX_CLI_VERSION,
      // An unread version is not an old CLI: the probe answered nothing, and calling that
      // ready would send the caller into a session that fails on the spawn.
      detail: `\`codex --version\` printed no version, so this build cannot be held against the ${MIN_CODEX_CLI_VERSION} floor.`,
    };
  }
  if (isCodexCliBelowMinimum(cliVersion)) {
    return {
      ok: false,
      cliVersion,
      minimumCliVersion: MIN_CODEX_CLI_VERSION,
      detail: belowMinimumCodexCliMessage(cliVersion),
    };
  }
  return {
    ok: true,
    cliVersion,
    minimumCliVersion: MIN_CODEX_CLI_VERSION,
    detail: `Codex CLI ${cliVersion} carries \`codex app-server\`, which every session runs on.`,
  };
}

function probeCodexEnvironment(): CodexProbe {
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
        backend: {
          ok: false,
          cliVersion: null,
          minimumCliVersion: MIN_CODEX_CLI_VERSION,
          detail: "Codex CLI version not checked because no codex executable was detected.",
        },
        internalExecutable,
      };
    }

    return {
      executable,
      auth: probeCodexAuth(info),
      backend: probeCodexBackend(),
      internalExecutable,
    };
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
      backend: {
        ok: false,
        cliVersion: null,
        minimumCliVersion: MIN_CODEX_CLI_VERSION,
        detail: "Codex CLI version not checked because executable resolution failed.",
      },
      internalExecutable,
    };
  }
}

function collectSetupAdvice(
  probe: CodexProbe,
  projectContext: CodexSetupResult["projectContext"],
  permissionProfiles: CodexSetupResult["permissionProfiles"]
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
  if (!probe.backend.ok && probe.executable.ok) {
    warnings.push(probe.backend.detail);
    nextSteps.push(`Upgrade the Codex CLI to ${MIN_CODEX_CLI_VERSION} or newer.`);
  }
  if (!permissionProfiles.ok && probe.executable.ok) {
    warnings.push(permissionProfiles.detail);
    nextSteps.push(
      "Start a session with `sandbox` rather than `permissions` until the profile listing answers."
    );
  }

  return { warnings, nextSteps };
}

/** What the machine answered about its permission profiles, or what went wrong asking. */
async function probePermissionProfiles(
  probe: CodexProbe,
  cwd: string,
  listProfiles: PermissionProfileLister
): Promise<CodexSetupResult["permissionProfiles"]> {
  if (!probe.executable.ok) {
    return {
      ok: false,
      detail: "Permission profiles not listed because no codex executable was detected.",
    };
  }
  try {
    const profiles = await listProfiles(cwd);
    return {
      ok: true,
      profiles,
      detail:
        profiles.length === 0
          ? "This machine offers no permission profile; `permissions` has no id to name here."
          : `Pass one of these ids as \`permissions\`: ${profiles
              .filter((profile) => profile.allowed)
              .map((profile) => profile.id)
              .join(", ")}.`,
    };
  } catch (err) {
    // Carried through rather than answered as an empty list: a listing that
    // failed is not a machine with no profiles.
    return {
      ok: false,
      detail: `Failed to list permission profiles: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function executeCodexSetup(
  input: CodexSetupInput | undefined,
  serverCwd: string,
  listProfiles: PermissionProfileLister
): Promise<CodexSetupResult> {
  const cwd = input?.cwd && input.cwd.trim() !== "" ? input.cwd : serverCwd;
  const probe = probeCodexEnvironment();
  const permissionProfiles = await probePermissionProfiles(probe, cwd, listProfiles);

  const projectContext = {
    hasUserConfig: existsSync(path.join(homedir(), ".codex", "config.toml")),
    hasProjectConfig: existsSync(path.join(cwd, ".codex", "config.toml")),
  };

  const { warnings, nextSteps } = collectSetupAdvice(probe, projectContext, permissionProfiles);

  return {
    ready: probe.executable.ok && probe.auth.ok && probe.backend.ok,
    cwd,
    executable: probe.executable,
    auth: probe.auth,
    backend: probe.backend,
    runtime: {
      sameMachineRequired: true,
      stateDir: resolveCodexStateDir(),
    },
    projectContext,
    permissionProfiles,
    warnings,
    nextSteps,
  };
}
