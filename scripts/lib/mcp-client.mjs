// The contract `smoke:mcp` holds the server to: the tools and the resources a
// client finds after the handshake.

export const REQUIRED_TOOLS = ["codex", "codex_reply", "codex_session", "codex_check", "codex_setup"];

export const REQUIRED_RESOURCES = [
  "codex-mcp:///server-info",
  "codex-mcp:///config",
  "codex-mcp:///gotchas",
  "codex-mcp:///delegation-guide",
];

/** @param {{ name: string }[]} tools */
export function assertToolsPresent(tools) {
  const names = new Set(tools.map((t) => t.name));
  for (const required of REQUIRED_TOOLS) {
    if (!names.has(required)) throw new Error(`missing tool from tools/list: ${required}`);
  }
}

/** @param {{ uri: string }[]} resources */
export function assertResourcesPresent(resources) {
  const uris = new Set(resources.map((r) => r.uri));
  for (const uri of REQUIRED_RESOURCES) {
    if (!uris.has(uri)) throw new Error(`missing resource uri: ${uri}`);
  }
}

/**
 * The `CODEX_MCP_*` variables of `env`. `StdioClientTransport` hands the child
 * only its own allowlist, so anything set for this run is otherwise dropped and
 * the server takes the lock on the caller's real state directory and recovers
 * its sessions.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {Record<string, string>}
 */
export function codexMcpEnv(env) {
  return Object.fromEntries(
    Object.entries(env).filter(([key, value]) => key.startsWith("CODEX_MCP_") && value !== undefined)
  );
}
