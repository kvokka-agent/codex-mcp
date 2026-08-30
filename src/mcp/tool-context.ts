import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SessionManager } from "../session/manager/session-manager.js";
import type { PollWindow } from "../utils/poll-window.js";
import type { SessionDefaults } from "../utils/session-defaults.js";

/** Everything the five tool registrations read out of one server. */
export interface ToolContext {
  server: McpServer;
  sessionManager: SessionManager;
  serverCwd: string;
  sessionDefaults: SessionDefaults;
  pollWindow: PollWindow;
}
