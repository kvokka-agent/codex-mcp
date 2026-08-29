#!/usr/bin/env bun
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";

import { parseLaunchArgs, resolveSpawnTarget } from "./lib/launch-args.mjs";
import {
  assertResourcesPresent,
  assertToolsPresent,
  codexMcpEnv,
} from "./lib/mcp-client.mjs";

function usage(exitCode = 0) {
  const msg = [
    "Usage:",
    "  bun scripts/mcp-smoke.mjs [--bunx] [--cwd <path>] [--verbose] [-- <command> <...args>]",
    "",
    "Defaults:",
    "  (no args) -> spawns: bun dist/index.js",
    "  --bunx    -> spawns: bunx @kvokka/codex-mcp",
    "  --        -> overrides command/args explicitly",
    "",
  ].join("\n");
  // eslint-disable-next-line no-console
  console.error(msg);
  process.exit(exitCode);
}

function parseArgs(argv) {
  return parseLaunchArgs(argv, {
    usage,
    defaults: { verbose: false },
    switches: { "--verbose": "verbose" },
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { command, args: cmdArgs } = resolveSpawnTarget(args);

  const codexEnv = codexMcpEnv(process.env);
  codexEnv.CODEX_MCP_STATE_DIR =
    codexEnv.CODEX_MCP_STATE_DIR ??
    path.join(fs.mkdtempSync(path.join(os.tmpdir(), "codex-mcp-smoke-")), "state");

  const transport = new StdioClientTransport({
    command,
    args: cmdArgs,
    cwd: args.cwd,
    env: { ...getDefaultEnvironment(), ...codexEnv },
    stderr: "pipe",
  });

  if (transport.stderr) {
    transport.stderr.on("data", (chunk) => process.stderr.write(chunk));
  }

  const client = new Client({ name: "codex-mcp-smoke", version: "0.0.0" }, { capabilities: {} });

  await client.connect(transport);

  const tools = await client.listTools();
  assertToolsPresent(tools.tools);

  if (args.verbose) {
    // eslint-disable-next-line no-console
    console.error("tools/list:", JSON.stringify(tools.tools.map((t) => t.name), null, 2));
  }

  const resources = await client.listResources();
  assertResourcesPresent(resources.resources);

  await client.readResource({ uri: "codex-mcp:///server-info" });
  await client.readResource({ uri: "codex-mcp:///gotchas" });

  await client.close();
  // eslint-disable-next-line no-console
  console.error("OK: MCP handshake, tools, and resources look good.");
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("FAILED:", err?.stack || String(err));
  process.exitCode = 1;
});
