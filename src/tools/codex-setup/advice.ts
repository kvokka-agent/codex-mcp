/** The warnings `codex_setup` raises, and the next step each one asks for. */
import { MIN_CODEX_CLI_VERSION } from "../../utils/codex-version.js";
import { type CodexProbe, windowsSandboxBlocks } from "./probe.js";
import type { CodexSetupResult } from "./result.js";

/**
 * The warnings and next steps one condition of the report contributes.
 *
 * Read-only because every condition that holds answers the one `noAdvice`
 * instance, which the collector below reads and never appends to.
 */
interface SetupAdvice {
  readonly warnings: readonly string[];
  readonly nextSteps: readonly string[];
}

/** A condition that holds: nothing to warn about, nothing to ask for. */
const noAdvice: SetupAdvice = { warnings: [], nextSteps: [] };

/** What one condition that does not hold contributes. */
function advise(warning: string, ...nextSteps: string[]): SetupAdvice {
  return { warnings: [warning], nextSteps };
}

/** An executable nothing resolved, and the settings that would resolve one. */
function executableAdvice(probe: CodexProbe): SetupAdvice {
  if (probe.executable.ok) return noAdvice;
  return advise(
    probe.executable.detail,
    "Install Codex or fix CODEX_MCP_COMMAND / CODEX_MCP_PATH so the executable can be resolved."
  );
}

/**
 * The login, where `account/read` named none or answered nothing.
 *
 * An unread state warns only once an executable resolved: with none, the
 * executable line already carries that one failure.
 */
function authAdvice(probe: CodexProbe): SetupAdvice {
  if (probe.auth.state === "unauthenticated") {
    return advise(probe.auth.detail, "Run `codex login` and rerun `codex_setup`.");
  }
  if (probe.auth.state === "unknown" && probe.executable.ok) return advise(probe.auth.detail);
  return noAdvice;
}

/** A machine carrying no `config.toml` on either layer. */
function missingConfigAdvice(projectContext: CodexSetupResult["projectContext"]): SetupAdvice {
  if (projectContext.hasUserConfig || projectContext.hasProjectConfig) return noAdvice;
  return advise("No Codex config.toml was found in ~/.codex or this project.");
}

/** A CLI under the floor, or one whose version never printed. */
function backendAdvice(probe: CodexProbe): SetupAdvice {
  if (probe.backend.ok || !probe.executable.ok) return noAdvice;
  return advise(
    probe.backend.detail,
    `Upgrade the Codex CLI to ${MIN_CODEX_CLI_VERSION} or newer.`
  );
}

/**
 * A profile listing that failed, and what a session passes until it answers.
 *
 * A connection that never came up is one failure, and the auth line above
 * already carries it: the listing it also stopped adds no second warning.
 */
function permissionProfilesAdvice(probe: CodexProbe): SetupAdvice {
  if (probe.permissionProfiles.ok || !probe.executable.ok || probe.connectionFailed) {
    return noAdvice;
  }
  return advise(
    probe.permissionProfiles.detail,
    "Start a session with `sandbox` rather than `permissions` until the profile listing answers."
  );
}

/** A Windows sandbox standing between this caller and a `workspace-write` turn. */
function windowsSandboxAdvice(probe: CodexProbe): SetupAdvice {
  if (!windowsSandboxBlocks(probe)) return noAdvice;
  return advise(
    probe.windowsSandbox?.status === "updateRequired"
      ? 'The Windows sandbox needs an update; a turn started with `sandbox: "workspace-write"` fails until it has one.'
      : 'The Windows sandbox is not configured; a turn started with `sandbox: "workspace-write"` fails.',
    'Complete the Windows sandbox setup in the Codex CLI, or start sessions with `sandbox: "read-only"`.'
  );
}

/** Every condition the report advises on, in the order the answer lists them. */
export function collectSetupAdvice(
  probe: CodexProbe,
  projectContext: CodexSetupResult["projectContext"]
): Pick<CodexSetupResult, "warnings" | "nextSteps"> {
  const advice = [
    executableAdvice(probe),
    authAdvice(probe),
    missingConfigAdvice(projectContext),
    backendAdvice(probe),
    permissionProfilesAdvice(probe),
    windowsSandboxAdvice(probe),
  ];
  return {
    warnings: [...probe.warnings, ...advice.flatMap((one) => one.warnings)],
    nextSteps: advice.flatMap((one) => one.nextSteps),
  };
}
