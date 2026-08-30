import {
  ADVERTISED_EFFORT_LEVELS,
  APPROVAL_POLICIES,
  MAX_LONG_POLL_WAIT_MS,
  SANDBOX_MODES,
} from "../types.js";
import {
  belowMinimumCodexCliMessage,
  isCodexCliBelowMinimum,
  MIN_CODEX_CLI_VERSION,
} from "../utils/codex-version.js";
import { resolveStdioMode } from "../utils/stdio-guard.js";
import { RESOURCE_CATALOG, RESOURCE_URIS } from "./catalog.js";
import type { ResourceDeps } from "./deps.js";

/**
 * The runtime this process is, as a name and a version.
 *
 * bun sets `process.versions.bun` and answers `process.version` with the Node
 * release it emulates, so reading `process.version` alone names the wrong
 * runtime.
 */
function describeRuntime(): string {
  const bun = process.versions.bun;
  return bun ? `bun v${bun}` : `node ${process.version}`;
}

export function buildCompatReport(deps: ResourceDeps, codexCliVersion: string | null): string {
  const runtimeWarnings: string[] = [];
  if (!codexCliVersion) {
    runtimeWarnings.push("Unable to detect local codex CLI version from PATH.");
  } else if (isCodexCliBelowMinimum(codexCliVersion)) {
    runtimeWarnings.push(belowMinimumCodexCliMessage(codexCliVersion));
  }
  if (!deps.diskPersistence) {
    runtimeWarnings.push(
      "Disk persistence is off: sessions are held in memory only and are lost when the server restarts."
    );
  }
  return JSON.stringify(
    {
      schemaVersion: "1.0.0",
      features: {
        respondPermission: true,
        respondApprovalAlias: false,
        respondUserInput: true,
        sessionInterrupt: true,
        statusOnlyCheck: true,
        checkLongPoll: true,
        compatWarnings: true,
        diskPersistence: deps.diskPersistence,
        diskResume: deps.diskPersistence,
        dynamicTools: false,
        toolPermissionControl: false,
      },
      featureNotes: {
        diskPersistence: deps.diskPersistence
          ? "Session metadata, events and results are written under the state directory and read back on every listing, so every server sharing the directory sees the same sessions."
          : "The state directory could not be written, so sessions are held in memory only and a restart drops their history.",
        diskResume: deps.diskPersistence
          ? 'A session whose server went away mid-turn comes back as status `abandoned` and carries the last line it said it was doing. `codex_session(action="resume")` starts a codex process for it and restores the thread from Codex\'s rollout log; `codex_reply` then carries it on. Replying to a session that has not been resumed fails with SESSION_NOT_RUNNING.'
          : "Without a state directory nothing survives a restart, so there is nothing to resume.",
      },
      recommendedSettings: {
        codexCheck: {
          waitMs: MAX_LONG_POLL_WAIT_MS,
        },
      },
      toolCounts: {
        core: 5,
      },
      runtimeWarnings,
      detectedMismatches: [],
      runtime: {
        codexMcpVersion: deps.version,
        codexCliVersion,
        minCodexCliVersion: MIN_CODEX_CLI_VERSION,
        activeSessions: deps.sessionManager.getActiveSessionCount(),
      },
    },
    null,
    2
  );
}

export function buildServerInfoJson(
  deps: ResourceDeps,
  getCodexCliVersion: () => string | null
): string {
  return JSON.stringify(
    {
      name: "codex-mcp",
      version: deps.version,
      codexCliVersion: getCodexCliVersion(),
      minCodexCliVersion: MIN_CODEX_CLI_VERSION,
      runtime: describeRuntime(),
      platform: process.platform,
      arch: process.arch,
      stdioMode: resolveStdioMode().mode,
      supportedApprovalPolicies: APPROVAL_POLICIES,
      supportedSandboxModes: SANDBOX_MODES,
      advertisedEffortLevels: ADVERTISED_EFFORT_LEVELS,
      activeSessions: deps.sessionManager.getActiveSessionCount(),
      // The model Codex answered a `thread/start` that named none with, and
      // null while no start has measured it. It carries no source field: this
      // is the one place it comes from, and null already says unknown.
      defaultModel: deps.sessionManager.getCodexDefaultModel(),
      resources: RESOURCE_CATALOG.map((entry) => ({
        uri: RESOURCE_URIS[entry.key],
        title: entry.title,
        mimeType: entry.mimeType,
        description: entry.description,
      })),
    },
    null,
    2
  );
}
