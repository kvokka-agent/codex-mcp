/** codex_setup tool — what this machine answers about running Codex here. */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { collectSetupAdvice } from "./advice.js";
import { probeCodexEnvironment, windowsSandboxBlocks } from "./probe.js";
import type { CodexSetupInput, CodexSetupResult } from "./result.js";

function resolveCodexStateDir(): string {
  const configured = process.env.CODEX_MCP_STATE_DIR?.trim();
  return configured && configured !== "" ? configured : path.join(homedir(), ".codex-mcp", "state");
}

export async function executeCodexSetup(
  input: CodexSetupInput | undefined,
  serverCwd: string
): Promise<CodexSetupResult> {
  const cwd = input?.cwd && input.cwd.trim() !== "" ? input.cwd : serverCwd;
  const probe = await probeCodexEnvironment(cwd);

  const projectContext = {
    hasUserConfig: existsSync(path.join(homedir(), ".codex", "config.toml")),
    hasProjectConfig: existsSync(path.join(cwd, ".codex", "config.toml")),
  };

  const { warnings, nextSteps } = collectSetupAdvice(probe, projectContext);

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
    permissionProfiles: probe.permissionProfiles,
    warnings,
    nextSteps,
  };
}
