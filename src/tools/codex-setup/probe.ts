/** What the local machine answers about Codex, asked once per `codex_setup` call. */
import { AppServerClient } from "../../app-server/client/index.js";
import type { Account, GetAccountResult } from "../../app-server/wire/index.js";
import { listPermissionProfiles } from "../../session/permission-profiles.js";
import {
  type CodexExecutableInfo,
  resolveDefaultCodexExecutable,
} from "../../utils/codex-executable.js";
import {
  belowMinimumCodexCliMessage,
  detectCodexCliVersion,
  isCodexCliBelowMinimum,
  MIN_CODEX_CLI_VERSION,
} from "../../utils/codex-version.js";
import type { CodexSetupResult } from "./result.js";

/** What the machine answered about Codex, or what went wrong asking. */
export interface CodexProbe {
  executable: CodexSetupResult["executable"];
  auth: CodexSetupResult["auth"];
  backend: CodexSetupResult["backend"];
  windowsSandbox?: CodexSetupResult["windowsSandbox"];
  permissionProfiles: CodexSetupResult["permissionProfiles"];
  connectionFailed?: true;
  warnings: string[];
}

/** What the app server answered, or what went wrong asking it. */
interface AppServerProbe {
  auth: CodexSetupResult["auth"];
  windowsSandbox?: CodexSetupResult["windowsSandbox"];
  permissionProfiles: CodexSetupResult["permissionProfiles"];
  /** Set where the connection never came up, so every answer is unread for that one reason. */
  connectionFailed?: true;
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
 * Ask one app server everything `codex_setup` reports from the backend.
 *
 * The connection costs one spawn plus `initialize` plus one request — measured
 * at 52, 37 and 41 ms on Codex CLI 0.150.1 — and needs no thread, so the three
 * questions ride it in turn rather than each paying for a process of its own.
 * Each is asked and answered on its own: an `account/read` that failed leaves
 * the profile listing to answer, and a listing that failed leaves the auth
 * state as `account/read` reported it.
 */
async function probeAppServer(cwd: string): Promise<AppServerProbe> {
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
        permissionProfiles: unlistedProfiles("`codex app-server` did not start"),
        connectionFailed: true,
        warnings: [],
      };
    }

    const auth = await probeAuth(client);
    const sandbox = await probeWindowsSandbox(client);
    return {
      auth,
      ...sandbox,
      permissionProfiles: await probePermissionProfiles(client, cwd),
    };
  } finally {
    // `destroy` reports a signal it could not send itself and resolves, so the
    // gathered report is never lost to the shutdown of the probe's own client.
    await client.destroy();
  }
}

/** What `account/read` answered, or the failure that stopped the question. */
async function probeAuth(client: AppServerClient): Promise<CodexSetupResult["auth"]> {
  let answer: GetAccountResult;
  try {
    answer = await client.accountRead();
  } catch (err: unknown) {
    return unreadAuth(`\`account/read\` failed, so the auth state was not read: ${messageOf(err)}`);
  }
  return readAuth(answer);
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

/** A listing nothing ran, naming what stopped it. */
function unlistedProfiles(reason: string): CodexSetupResult["permissionProfiles"] {
  return { ok: false, detail: `Permission profiles not listed because ${reason}.` };
}

/**
 * What the machine answered about its permission profiles, or what went wrong asking.
 *
 * The ids come from the user's own `config.toml` and from the project layers
 * under `cwd`, so the listing is asked for the directory this report answers
 * for, and only the local Codex can name them.
 */
async function probePermissionProfiles(
  client: AppServerClient,
  cwd: string
): Promise<CodexSetupResult["permissionProfiles"]> {
  try {
    const profiles = await listPermissionProfiles(client, cwd);
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

export async function probeCodexEnvironment(cwd: string): Promise<CodexProbe> {
  let info: CodexExecutableInfo;
  try {
    info = resolveDefaultCodexExecutable();
  } catch (err: unknown) {
    return {
      executable: { ok: false, source: "error", detail: messageOf(err) },
      auth: unreadAuth("Auth state not read because executable resolution failed."),
      backend: unprobedBackend("executable resolution failed"),
      permissionProfiles: unlistedProfiles("executable resolution failed"),
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
      permissionProfiles: unlistedProfiles("no codex executable was detected"),
      warnings: [],
    };
  }

  return { executable, backend: probeCodexBackend(), ...(await probeAppServer(cwd)) };
}

/** Whether the Windows sandbox stands between this caller and a `workspace-write` turn. */
export function windowsSandboxBlocks(probe: CodexProbe): boolean {
  if (process.platform !== "win32") return false;
  const status = probe.windowsSandbox?.status;
  return status === "notConfigured" || status === "updateRequired";
}
