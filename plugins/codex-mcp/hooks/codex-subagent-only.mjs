#!/usr/bin/env bun
// Denies the codex-mcp tools to every caller but the codex subagent.
//
// Claude Code sends `agent_type` only when the hook fires inside a subagent, or
// on the main thread of a session started with `--agent`, so its absence
// identifies the main conversation.
//
// A plugin prefixes its agents with its own name, so the agent shipped here
// answers to `codex-mcp:codex`, while a copy placed in a project's
// `.claude/agents/` answers to the bare `codex`. Both are the codex driver.

const ALLOWED = new Set(["codex", "codex-mcp:codex"]);

const DENIAL = JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason:
      "codex-mcp is reachable only through the codex subagent; spawn it with the Agent tool.",
  },
});

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  raw += chunk;
});
process.stdin.on("end", () => {
  let agentType;
  try {
    agentType = JSON.parse(raw).agent_type;
  } catch {
    // Unreadable input names no caller, so it is not the codex subagent.
  }
  if (ALLOWED.has(agentType)) {
    process.exit(0);
  }
  process.stdout.write(DENIAL);
});
