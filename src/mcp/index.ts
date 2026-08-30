/**
 * MCP server definition — one server with its five tools, its resources and the
 * session manager they all drive.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerResources } from "../resources/index.js";
import { SessionManager, type SessionManagerOptions } from "../session/manager/session-manager.js";
import { PollWindow } from "../utils/poll-window.js";
import { resolveSessionDefaults } from "../utils/session-defaults.js";
import { registerTools } from "./register-tools.js";
import type { ToolContext } from "./tool-context.js";

declare const __PKG_VERSION__: string;
const SERVER_VERSION = typeof __PKG_VERSION__ !== "undefined" ? __PKG_VERSION__ : "0.0.0-dev";

export interface ServerContext {
  server: McpServer;
  sessionManager: SessionManager;
}

export function createServer(serverCwd: string, options?: SessionManagerOptions): ServerContext {
  // Read before anything is built: an unreadable value stops the server here
  // rather than at the first session it would have started differently.
  const sessionDefaults = resolveSessionDefaults();
  const sessionManager = new SessionManager(options);
  // One per connection: the tool-call ceiling belongs to the client on the
  // other end of the pipe, and every session of that client shares it.
  const pollWindow = new PollWindow();
  const budget = pollWindow.describe();
  console.error(
    `[codex-mcp] long poll: up to ${budget.budgetMs}ms per call (client ceiling: ${budget.ceilingMs ?? "none declared"}, source: ${budget.source})`
  );

  const server = new McpServer({
    name: "codex-mcp",
    version: SERVER_VERSION,
  });

  registerResources(server, {
    version: SERVER_VERSION,
    sessionManager,
    sessionDefaults,
    diskPersistence: options?.persistence !== undefined,
  });

  const ctx: ToolContext = { server, sessionManager, serverCwd, sessionDefaults, pollWindow };
  registerTools(ctx);

  // The sessions belong to this connection: closing the server takes down the
  // app-server children they hold rather than leaving them to the reaper.
  const originalClose = server.close.bind(server);
  server.close = async () => {
    sessionManager.destroy();
    await originalClose();
  };

  return { server, sessionManager };
}
