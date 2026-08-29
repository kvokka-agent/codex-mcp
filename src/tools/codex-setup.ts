import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { AppServerClient } from "../app-server/client.js";
import type {
  Account,
  GetAccountResult,
  PermissionProfileSummary,
  WindowsSandboxReadiness,
} from "../app-server/protocol.js";
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

/**
 * What the app server answered about authentication.
 *
 * `not_required` is an install whose model provider carries its own
 * credentials: `account/read` answers `requiresOpenaiAuth: false` there, and a
 * null account is not a missing login. `unknown` is the state nothing answered.
 */
type AuthState = "authenticated" | "unauthenticated" | "not_required" | "unknown";

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
    /** The credential the account signs with, as `account/read` named it. */
    accountType?: Account["type"];
    detail: string;
  };
  backend: {
    ok: boolean;
    cliVersion: string | null;
    minimumCliVersion: string;
    detail: string;
  };
  /** Present for a caller on Windows whose app server answered the readiness call. */
  windowsSandbox?: {
    status: WindowsSandboxReadiness;
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

function resolveCodexStateDir(): string {
  const configured = process.env.CODEX_MCP_STATE_DIR?.trim();
  return configured && configured !== "" ? configured : path.join(homedir(), ".codex-mcp", "state");
}

/** What the app server answered, or what went wrong asking it. */
interface AppServerProbe {
  auth: CodexSetupResult["auth"];
  windowsSandbox?: CodexSetupResult["windowsSandbox"];
  /** A call that failed, in the words of the failure. */
  warnings: string[];
}

function accountDetail(account: Account): string {
  switch (account.type) {
    case "apiKey":
      return "`account/read` answered an API key account.";
    case "chatgpt":
      return `\`account/read\` answered a ChatGPT account on the ${account.planType} plan.`;
    case "amazonBedrock":
      return "`account/read` answered an Amazon Bedrock account.";
  }
}

/** The three branches of `account/read`, each read off the answer rather than guessed. */
function readAuth(answer: GetAccountResult): CodexSetupResult["auth"] {
  if (answer.account) {
    return {
      ok: true,
      state: "authenticated",
      accountType: answer.account.type,
      detail: accountDetail(answer.account),
    };
  }
  if (!answer.requiresOpenaiAuth) {
    return {
      ok: true,
      state: "not_required",
      detail:
        "`account/read` answered `requiresOpenaiAuth: false`: the configured model provider carries its own credentials, so this install needs no Codex login.",
    };
  }
  return {
    ok: false,
    state: "unauthenticated",
    detail:
      "`account/read` answered `requiresOpenaiAuth: true` with no account: this install has no Codex login.",
  };
}

/** An auth state nothing answered, carrying the failure that stopped the question. */
function unreadAuth(detail: string): CodexSetupResult["auth"] {
  return { ok: false, state: "unknown", detail };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Ask the running app server what the login scrape used to guess at.
 *
 * The connection costs one spawn plus `initialize` plus one request — measured
 * at 52, 37 and 41 ms on Codex CLI 0.150.1 — and needs no thread.
 */
async function probeAppServer(): Promise<AppServerProbe> {
  const client = new AppServerClient();
  // An `error` event with no listener is thrown, and the spawn of a missing
  // executable emits one, so the listener goes on before `start`.
  client.on("error", () => {});
  try {
    try {
      await client.start({});
    } catch (err: unknown) {
      return {
        auth: unreadAuth(
          `\`codex app-server\` did not start, so the auth state was not read: ${messageOf(err)}`
        ),
        warnings: [],
      };
    }

    let answer: GetAccountResult;
    try {
      answer = await client.accountRead();
    } catch (err: unknown) {
      return {
        auth: unreadAuth(
          `\`account/read\` failed, so the auth state was not read: ${messageOf(err)}`
        ),
        warnings: [],
      };
    }

    return { auth: readAuth(answer), ...(await probeWindowsSandbox(client)) };
  } finally {
    await client.destroy();
  }
}

/**
 * The Windows sandbox state, asked for on Windows only.
 *
 * The backend gates the method on no platform: a Linux 0.150.1 answers
 * `{"status":"notConfigured"}`, which is what a Windows machine with no sandbox
 * answers too, so reading it anywhere else would report a sandbox that install
 * never needed as missing.
 */
async function probeWindowsSandbox(
  client: AppServerClient
): Promise<Pick<AppServerProbe, "windowsSandbox" | "warnings">> {
  if (process.platform !== "win32") return { warnings: [] };
  try {
    const readiness = await client.windowsSandboxReadiness();
    return { windowsSandbox: { status: readiness.status }, warnings: [] };
  } catch (err: unknown) {
    return {
      warnings: [
        `\`windowsSandbox/readiness\` failed, so the Windows sandbox state was not read: ${messageOf(err)}`,
      ],
    };
  }
}

/** What the local machine answered about Codex, or what went wrong asking. */
interface CodexProbe {
  executable: CodexSetupResult["executable"];
  auth: CodexSetupResult["auth"];
  backend: CodexSetupResult["backend"];
  windowsSandbox?: CodexSetupResult["windowsSandbox"];
  warnings: string[];
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

function unprobedBackend(reason: string): CodexSetupResult["backend"] {
  return {
    ok: false,
    cliVersion: null,
    minimumCliVersion: MIN_CODEX_CLI_VERSION,
    detail: `Codex CLI version not checked because ${reason}.`,
  };
}

async function probeCodexEnvironment(): Promise<CodexProbe> {
  let info: CodexExecutableInfo;
  try {
    info = resolveDefaultCodexExecutable();
  } catch (err: unknown) {
    return {
      executable: { ok: false, source: "error", detail: messageOf(err) },
      auth: unreadAuth("Auth state not read because executable resolution failed."),
      backend: unprobedBackend("executable resolution failed"),
      warnings: [],
    };
  }

  const available = info.source !== "default";
  const executable: CodexSetupResult["executable"] = {
    ok: available,
    source: info.source,
    command: info.command,
    isPath: info.isPath,
    detail: available
      ? `Codex resolves via ${info.source}.`
      : "No codex executable was auto-detected; the server would fall back to `codex` and let process spawn fail later.",
  };

  if (!available) {
    return {
      executable,
      auth: unreadAuth("Auth state not read because no codex executable was detected."),
      backend: unprobedBackend("no codex executable was detected"),
      warnings: [],
    };
  }

  return { executable, backend: probeCodexBackend(), ...(await probeAppServer()) };
}

/** Whether the Windows sandbox stands between this caller and a `workspace-write` turn. */
function windowsSandboxBlocks(probe: CodexProbe): boolean {
  if (process.platform !== "win32") return false;
  const status = probe.windowsSandbox?.status;
  return status === "notConfigured" || status === "updateRequired";
}

function collectSetupAdvice(
  probe: CodexProbe,
  projectContext: CodexSetupResult["projectContext"],
  permissionProfiles: CodexSetupResult["permissionProfiles"]
): Pick<CodexSetupResult, "warnings" | "nextSteps"> {
  const warnings: string[] = [...probe.warnings];
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
  } else if (probe.auth.state === "unknown" && probe.executable.ok) {
    warnings.push(probe.auth.detail);
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
  if (windowsSandboxBlocks(probe)) {
    warnings.push(
      probe.windowsSandbox?.status === "updateRequired"
        ? 'The Windows sandbox needs an update; a turn started with `sandbox: "workspace-write"` fails until it has one.'
        : 'The Windows sandbox is not configured; a turn started with `sandbox: "workspace-write"` fails.'
    );
    nextSteps.push(
      'Complete the Windows sandbox setup in the Codex CLI, or start sessions with `sandbox: "read-only"`.'
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
  const probe = await probeCodexEnvironment();
  const permissionProfiles = await probePermissionProfiles(probe, cwd, listProfiles);

  const projectContext = {
    hasUserConfig: existsSync(path.join(homedir(), ".codex", "config.toml")),
    hasProjectConfig: existsSync(path.join(cwd, ".codex", "config.toml")),
  };

  const { warnings, nextSteps } = collectSetupAdvice(probe, projectContext, permissionProfiles);

  return {
    ready: probe.executable.ok && probe.auth.ok && probe.backend.ok && !windowsSandboxBlocks(probe),
    cwd,
    executable: probe.executable,
    auth: probe.auth,
    backend: probe.backend,
    ...(probe.windowsSandbox ? { windowsSandbox: probe.windowsSandbox } : {}),
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
