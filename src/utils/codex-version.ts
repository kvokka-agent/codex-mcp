/**
 * The Codex CLI version this server needs, and how to read the local one.
 */
import { spawnSync } from "node:child_process";
import { getDefaultCodexExecutable } from "./codex-executable.js";

/**
 * The oldest Codex CLI this server drives.
 *
 * Every session runs on `codex app-server`, and a CLI below this floor carries
 * no such subcommand.
 */
export const MIN_CODEX_CLI_VERSION = "0.101.0";

/**
 * The version the local codex CLI printed, or null when it printed no version.
 *
 * `spawnSync` reports a failed launch in `run.error` and a non-zero exit in `run.status`, and a
 * codex build that does not know `--version` writes its usage error to stderr with exit 1. Only a
 * successful run whose output carries a version number answers this question; anything else is
 * "not detected", never the first word of an error message.
 */
export function detectCodexCliVersion(timeoutMs = 1500): string | null {
  try {
    const executable = getDefaultCodexExecutable();
    const run = spawnSync(executable.command, ["--version"], {
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
    });
    if (run.error || run.status !== 0) return null;
    const combined = `${run.stdout ?? ""}\n${run.stderr ?? ""}`.trim();
    const versionToken = combined.match(/v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/);
    if (!versionToken) return null;
    return versionToken[0].replace(/^v/, "");
  } catch {
    return null;
  }
}

/** The release numbers of a version string, prerelease and build suffix dropped. */
function releaseNumbers(version: string): [number, number, number] {
  const [major, minor, patch] = version
    .replace(/^v/, "")
    .split(/[-+]/, 1)[0]
    .split(".")
    .map((part) => Number.parseInt(part, 10));
  return [major, minor, patch];
}

/** What a person is told when their CLI is below the floor. */
export function belowMinimumCodexCliMessage(version: string): string {
  return (
    `Codex CLI ${version} is below the ${MIN_CODEX_CLI_VERSION} this server needs: it carries no ` +
    "`codex app-server`, so no session starts. Upgrade the CLI."
  );
}

/**
 * Whether `version` is older than {@link MIN_CODEX_CLI_VERSION}.
 *
 * Compares the release numbers only: a prerelease of the floor release counts
 * as the floor, because its app-server surface is the one this server drives.
 * A string carrying no three release numbers is not a version this can rank,
 * and it answers `false` — an unreadable version is reported as unread, never
 * as too old.
 */
export function isCodexCliBelowMinimum(version: string): boolean {
  const found = releaseNumbers(version);
  if (found.some(Number.isNaN)) return false;
  const floor = releaseNumbers(MIN_CODEX_CLI_VERSION);
  for (let i = 0; i < 3; i++) {
    if (found[i] !== floor[i]) return found[i] < floor[i];
  }
  return false;
}
