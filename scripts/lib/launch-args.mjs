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
 * @typedef {{ key: string, read: (raw: string) => unknown }} ValueFlag
 * @typedef {{ kind: "help" }
 *   | { kind: "reject" }
 *   | { kind: "switch", key: string }
 *   | { kind: "value", key: string, value: unknown }} FlagAction
 */

/**
 * What one token of the command line asks for: the help, a switch to set, the next
 * argument to take as a value, or a command line the script refuses.
 *
 * An unknown flag is refused the same way a declared value flag with nothing usable
 * behind it is: neither names a value the script can act on.
 *
 * @param {string} flag
 * @param {string | undefined} next - the token behind `flag`, which a value flag reads
 * @param {Record<string, string>} switches
 * @param {Record<string, ValueFlag>} values
 * @returns {FlagAction}
 */
function readFlagAction(flag, next, switches, values) {
  if (flag === "--help" || flag === "-h") return { kind: "help" };

  const switchKey = switches[flag];
  if (switchKey !== undefined) return { kind: "switch", key: switchKey };

  const value = values[flag];
  const read = value !== undefined && next ? value.read(next) : undefined;
  if (read === undefined) return { kind: "reject" };
  return { kind: "value", key: value.key, value: read };
}

/**
 * Parses the shared flags plus the ones the calling script declares.
 *
 * `switches` maps a flag to the key it sets to `true`. `values` maps a flag to
 * the key it sets and the `read` that turns the next argument into that value;
 * `read` returning `undefined` rejects the argument. `usage` prints the script's
 * help and exits with the code it is given, so parsing continues past a help or
 * a bad flag only under a test.
 *
 * @param {string[]} argv
 * @param {{
 *   defaults?: Record<string, unknown>,
 *   switches?: Record<string, string>,
 *   values?: Record<string, ValueFlag>,
 *   usage: (exitCode: number) => void,
 * }} spec
 */
export function parseLaunchArgs(argv, spec) {
  const { defaults = {}, switches = {}, values = {}, usage } = spec;
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
    const action = readFlagAction(main[i], main[i + 1], knownSwitches, knownValues);
    if (action.kind === "help") usage(0);
    else if (action.kind === "reject") usage(2);
    else if (action.kind === "switch") out[action.key] = true;
    else {
      out[action.key] = action.value;
      i++;
    }
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
