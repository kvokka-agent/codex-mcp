// The command line both launcher scripts take: `--help`, `--bunx`, `--cwd`, and
// a `--` tail that replaces the command they spawn.

import process from "node:process";

/**
 * Splits `argv` at the first bare `--`.
 *
 * @param {string[]} argv
 * @returns {{ main: string[], tail: string[] }}
 */
export function splitArgv(argv) {
  const dd = argv.indexOf("--");
  if (dd === -1) return { main: argv, tail: [] };
  return { main: argv.slice(0, dd), tail: argv.slice(dd + 1) };
}

/**
 * Parses the shared flags plus the ones the calling script declares.
 *
 * `switches` maps a flag to the key it sets to `true`. `values` maps a flag to
 * the key it sets and the `read` that turns the next argument into that value;
 * `read` returning `undefined` rejects the argument. The scripts pass an
 * `onHelp` and an `onInvalid` that exit the process, so parsing continues past
 * either only under a test.
 *
 * @param {string[]} argv
 * @param {{
 *   defaults?: Record<string, unknown>,
 *   switches?: Record<string, string>,
 *   values?: Record<string, { key: string, read: (raw: string) => unknown }>,
 *   onHelp: () => void,
 *   onInvalid: () => void,
 * }} spec
 */
export function parseLaunchArgs(argv, spec) {
  const { defaults = {}, switches = {}, values = {}, onHelp, onInvalid } = spec;
  const out = {
    useBunx: false,
    cwd: process.cwd(),
    overrideCommand: null,
    overrideArgs: [],
    ...defaults,
  };
  const knownSwitches = { "--bunx": "useBunx", ...switches };
  const knownValues = { "--cwd": { key: "cwd", read: (raw) => raw }, ...values };

  const { main, tail } = splitArgv(argv);
  for (let i = 0; i < main.length; i++) {
    const flag = main[i];
    if (flag === "--help" || flag === "-h") {
      onHelp();
      continue;
    }
    const switchKey = knownSwitches[flag];
    if (switchKey !== undefined) {
      out[switchKey] = true;
      continue;
    }
    const value = knownValues[flag];
    const raw = value === undefined ? undefined : main[i + 1];
    const read = raw ? value.read(raw) : undefined;
    if (read === undefined) {
      onInvalid();
      continue;
    }
    out[value.key] = read;
    i++;
  }

  if (tail.length > 0) {
    out.overrideCommand = tail[0] ?? null;
    out.overrideArgs = tail.slice(1);
  }

  return out;
}

/**
 * The command a launcher spawns: what the `--` tail named, else the published
 * package under `bunx`, else the local build.
 *
 * @param {{ overrideCommand: string | null, overrideArgs: string[], useBunx: boolean }} args
 * @returns {{ command: string, args: string[] }}
 */
export function resolveSpawnTarget(args) {
  if (args.overrideCommand) return { command: args.overrideCommand, args: args.overrideArgs };
  if (args.useBunx) return { command: "bunx", args: ["@kvokka/codex-mcp"] };
  return { command: "bun", args: ["dist/index.js"] };
}
