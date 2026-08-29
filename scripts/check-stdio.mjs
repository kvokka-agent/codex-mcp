#!/usr/bin/env bun
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseLaunchArgs, resolveSpawnTarget } from "./lib/launch-args.mjs";
import {
  buildStdioReport,
  captureChildOutput,
  describeStdioReport,
  readPositiveMs,
  readStdioMode,
  stdioCheckEnv,
} from "./lib/stdio-check.mjs";

function usage(exitCode = 0) {
  // eslint-disable-next-line no-console
  console.error(
    [
      "Usage:",
      "  bun scripts/check-stdio.mjs [--bunx] [--mode <auto|strict|off>] [--cwd <path>] [--timeout-ms <n>] [--report-json <path>] [-- <command> <...args>]",
      "",
      "Checks that the MCP server does NOT write anything to stdout before a client connects.",
      "Any non-empty stdout output is treated as a failure (stdio transport requires stdout to be JSON-RPC only).",
      "",
      "Defaults:",
      "  (no args) -> spawns: bun dist/index.js",
      "  --bunx    -> spawns: bunx @kvokka/codex-mcp",
      "  --mode    -> sets CODEX_MCP_STDIO_MODE for child process (default: auto)",
      "",
    ].join("\n")
  );
  process.exit(exitCode);
}

function parseArgs(argv) {
  return parseLaunchArgs(argv, {
    usage,
    defaults: { timeoutMs: 2000, stdioMode: "auto", reportJson: null },
    values: {
      "--timeout-ms": { key: "timeoutMs", read: readPositiveMs },
      "--mode": { key: "stdioMode", read: readStdioMode },
      "--report-json": { key: "reportJson", read: (raw) => raw },
    },
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { command, args: cmdArgs } = resolveSpawnTarget(args);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mcp-stdio-"));
  const run = await captureChildOutput({
    command,
    args: cmdArgs,
    cwd: args.cwd,
    env: stdioCheckEnv(process.env, args.stdioMode, tmpDir),
    timeoutMs: args.timeoutMs,
    dir: tmpDir,
  });

  const report = buildStdioReport({
    ...run,
    stdioMode: args.stdioMode,
    command,
    args: cmdArgs,
    cwd: args.cwd,
    timeoutMs: args.timeoutMs,
    platform: process.platform,
  });

  if (args.reportJson) {
    fs.writeFileSync(args.reportJson, JSON.stringify(report, null, 2), "utf8");
  }

  for (const line of describeStdioReport(report, run)) {
    // eslint-disable-next-line no-console
    console.error(line);
  }

  if (!report.ok) process.exitCode = 1;
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("FAILED:", err?.stack || String(err));
  process.exitCode = 1;
});
