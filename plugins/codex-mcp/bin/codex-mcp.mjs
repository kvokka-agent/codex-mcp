#!/usr/bin/env node
// Starts the codex-mcp server this plugin's version names.
//
// `npx @kvokka/codex-mcp@<version>` answers the request from the tree of the
// directory the client started the server in. A tree that already carries the
// package at that version — the server's own checkout, or a project depending
// on it — makes npm exec run the bin name `codex-mcp` from PATH instead of
// fetching anything, nothing on PATH answers to it, and the client reads
// `CONNECTION_CLOSED` from a process that exited 127 before writing a frame.
//
// So the version is installed into a directory keyed by that version and
// imported from there. The client's tree decides nothing, the install runs once
// per version rather than on every start, and `process.cwd()` stays what the
// client set: the server takes the default working directory of its sessions
// from it.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PACKAGE = "@kvokka/codex-mcp";

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The version this plugin ships, read from the manifest that carries it. */
export function pluginVersion(pluginRoot = PLUGIN_ROOT) {
  const manifest = join(pluginRoot, ".claude-plugin", "plugin.json");
  return JSON.parse(readFileSync(manifest, "utf8")).version;
}

/**
 * Where a version lives once it is installed.
 *
 * Keyed by the version, so a plugin update installs beside what it replaces
 * rather than over it, and a downgrade finds its own copy still there.
 */
export function installDir(version, env = process.env, home = homedir()) {
  const cache = env.XDG_CACHE_HOME || join(home, ".cache");
  return join(cache, "codex-mcp", "versions", version);
}

/** The server's entry point inside an install directory. */
export function entryPoint(dir) {
  return join(dir, "node_modules", PACKAGE, "dist", "index.js");
}

/**
 * The npm call that fills an install directory.
 *
 * `--prefix` names the tree to install into, so npm neither reads nor writes
 * the client's project. `--no-save` leaves the directory without a manifest of
 * its own, which is what makes it hold exactly this one package.
 */
export function installArgs(dir, version) {
  return [
    "install",
    "--prefix",
    dir,
    "--no-save",
    "--no-audit",
    "--no-fund",
    "--loglevel",
    "error",
    `${PACKAGE}@${version}`,
  ];
}

/**
 * Install the version unless it is already there, and answer its entry point.
 *
 * npm's own output goes to stderr: stdout carries the MCP frames of the server
 * this process becomes, and a line of npm's on it ends the session.
 */
export function ensureInstalled(version, run = spawnSync, env = process.env, home = homedir()) {
  const dir = installDir(version, env, home);
  const entry = entryPoint(dir);
  if (existsSync(entry)) return entry;

  mkdirSync(dir, { recursive: true });
  const npm = run("npm", installArgs(dir, version), {
    stdio: ["ignore", 2, 2],
    shell: process.platform === "win32",
  });
  if (npm.error) {
    throw new Error(`npm could not be started to install ${PACKAGE}@${version}: ${npm.error.message}`);
  }
  if (npm.status !== 0) {
    throw new Error(
      `npm install of ${PACKAGE}@${version} into ${dir} exited ${npm.status ?? `on ${npm.signal}`}`
    );
  }
  if (!existsSync(entry)) {
    throw new Error(`npm install of ${PACKAGE}@${version} left no ${entry}`);
  }
  return entry;
}

export async function main() {
  const entry = ensureInstalled(pluginVersion());
  await import(pathToFileURL(entry).href);
}

// Nothing runs on import, so the rules above are measured by the tests without
// starting a server.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((err) => {
    console.error(`[codex-mcp plugin] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
