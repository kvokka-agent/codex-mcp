# Local development

Run the server you just built inside a real Claude Code session, without
publishing anything to npm. Claude Code launches an MCP server as a child
process from a command line you control, so pointing that command at this
working tree's `dist/index.js` is the whole trick.

## Prepare

```bash
git clone https://github.com/kvokka/codex-mcp.git
cd codex-mcp
bun install --frozen-lockfile
bun run build
```

`dist/` is not committed. `bun run build` bundles the whole server into the
single file `dist/index.js`, and that file is what every step below launches.

`bun` builds it, runs it and runs the tests; nothing in the repository calls
node.

The server drives the Codex CLI, so `codex --version` must answer and
`codex login` must have run. Without a login the server still starts and
`codex_setup` reports `auth.state: unauthenticated` — enough to check the
protocol, not enough to run a turn.

## Connect the build to Claude Code

Pick the project you want to test from — this repository, or a scratch
directory — and put a `.mcp.json` in its root:

```json
{
  "mcpServers": {
    "codex-mcp": {
      "command": "bun",
      "args": ["/absolute/path/to/codex-mcp/dist/index.js"],
      "env": {
        "CODEX_MCP_STATE_DIR": "/absolute/path/to/codex-mcp/.codex-mcp-state"
      }
    }
  }
}
```

Three things about that file:

- The path is absolute. Claude Code spawns the server with the project
  directory as its cwd, not the repository's.
- The server name is `codex-mcp`. The plugin's hook matches tools named
  `mcp__codex-mcp__*` or `mcp__plugin_codex-mcp_codex-mcp__*`, so a server under
  a different name is outside the hook's reach — the head agent can call it
  directly and the `codex` subagent's instructions no longer name the tools it
  gets.
- `CODEX_MCP_STATE_DIR` keeps the run out of `~/.codex-mcp/state`, where an
  installed `@kvokka/codex-mcp` keeps its sessions. A development server pointed
  at that directory would leave the installed server's live sessions alone, but
  it would list them, prune the finished ones and adopt whatever the installed
  server left behind. `.codex-mcp-state/` at the repository root is git-ignored.

Claude Code picks the file up on the next start in that directory. To reach the
build from every project instead, register it once at user scope:

```bash
claude mcp add --scope user codex-mcp-dev \
  -e CODEX_MCP_STATE_DIR=/absolute/path/to/codex-mcp/.codex-mcp-state \
  -- bun /absolute/path/to/codex-mcp/dist/index.js
```

A user-scope server under a different name lives beside the published one, and
both answer in the same session — which is why the tools carry the server name.
Only the plugin needs the exact name `codex-mcp`. `claude mcp remove
codex-mcp-dev -s user` takes it back out.

`claude mcp list` reports whether the server connected. That it is *your* build
takes a session in the project:

```text
> Call codex_setup and show runtime.stateDir
```

The answer names the state directory from the `env` block. If it names
`~/.codex-mcp/state`, the client is running some other copy of the server.

## Edit, rebuild, restart

The client starts the server once and holds that process for the life of the
session, so a rebuilt `dist/index.js` changes nothing until the process is
replaced.

1. Edit `src/`.
2. `bun run build`.
3. In the Claude Code session, `/mcp` → `codex-mcp` → **Reconnect**.

Reconnect kills the child and spawns the command again, which reads the new
bundle. The session, its history and every other server stay up.

A turn that was in flight ends with the process that drove it, and its session
comes back as `abandoned` — `codex_session(action="resume")` picks the thread up
where Codex left it, as [SESSIONS.md](SESSIONS.md) describes. The fresh process
reads the state directory back — its stderr reports how many sessions it
recovered and how many belong to another running server — and reaps the child
processes the old one left behind.

## Run the checks

```bash
bun run check
```

That is the CI gate in one command: `lint`, `format:check`, `typecheck`, `test`,
`build`, then `check:stdio`, `smoke:mcp` and `lint:md`. `check:stdio` proves
stdout carries nothing but JSON-RPC before the handshake, and `smoke:mcp` drives
a real MCP client against the built server and asserts the five tools and the
resources are there. Both accept `--bunx` to run the published package instead of
`dist/`, and take a command after `--`.

Both start a real server, and both put its state directory in a fresh temporary
one unless `CODEX_MCP_STATE_DIR` says otherwise, so a check run never disturbs
the sessions of an installed server.

The end-to-end suite inside `bun test` — `tests/server-lifecycle.e2e.test.ts` —
spawns the built server and hands it `tests/helpers/fake-codex.mjs` as the codex
binary. It skips itself on Windows, which spawns an executable by its extension
and does not run a `.mjs`. What it measures — a startup that serves MCP while an
orphan is still being reaped, a stdin EOF that ends the process mid-turn, a
cut-off session handed back as `abandoned` with its ownership given up, a
`threadId` written to `meta.json` while the first turn runs, two servers sharing
one state directory, a server adopting a dead owner's sessions and leaving a
live owner's alone, and a resume that carries the thread on — therefore carries
evidence from Linux and macOS only. On Windows the run is green without having
measured them. The pieces underneath are covered per platform by the unit tests.

## Static analysis

```bash
bun run lint:fallow
```

Runs the tests with coverage, converts the lcov bun writes into the Istanbul
report fallow reads, then runs fallow against it. Handed no report fallow
estimates coverage instead, and every CRAP score comes out inflated. The CI
`check` job runs this command in place of a bare `bun test`, so the suite runs
once.

## The plugin from the working tree

`plugins/codex-mcp/` ships the `codex` subagent and the `PreToolUse` hook
alongside the server. Load them from the working tree for one session:

```bash
claude --plugin-dir /absolute/path/to/codex-mcp/plugins/codex-mcp \
       --strict-mcp-config --mcp-config .mcp.json
```

`--strict-mcp-config` is what makes this a test of the local build. The
plugin's own `.mcp.json` pins the published `bunx @kvokka/codex-mcp@X.Y.Z`;
strict mode drops every server the flags did not name, leaving the agent and
the hook from the working tree wired to the `codex-mcp` of your `.mcp.json`.

What that session should show: `codex-mcp:codex` among the agent types, the
five `mcp__codex-mcp__*` tools, a direct call to any of them from the main
thread refused with "codex-mcp is reachable only through the codex subagent",
and a subagent writing a `**Progress summary**` line per round while the turn
runs.

Two more commands, neither of which needs a release:

- `claude plugin validate plugins/codex-mcp` and `claude plugin validate .`
  check the plugin manifest and the marketplace entry that names it.
- `claude plugin marketplace add /absolute/path/to/codex-mcp` followed by
  `claude plugin install codex-mcp@codex-mcp` installs the plugin the way a
  user gets it, and `claude plugin details codex-mcp@codex-mcp` lists what it
  contributes. The install copies the plugin into
  `~/.claude/plugins/cache/codex-mcp/codex-mcp/<version>/`, so it does not
  follow later edits and it runs the published server — use it to check the
  install and the version wiring, not to iterate. `claude plugin uninstall`
  and `claude plugin marketplace remove codex-mcp` undo it.

## Debugging

**Where the server's stderr goes.** The server logs with `console.error`, and
Claude Code files every line under the project it was launched from:

```text
~/.cache/claude-cli-nodejs/<cwd with / replaced by ->/mcp-logs-<server name>/<timestamp>.jsonl
```

Each line is JSON; the server's output arrives as `{"error": "Server stderr: …"}`
and the client's own connection trace as `{"debug": …}`. Startup answers the
first questions there — which codex binary was resolved, whether the app-server
probe passed or the run fell back to `exec`, how many sessions the state
directory held, and how many of them another running server owns.

Outside a client, `bun dist/index.js` writes the same lines to the terminal.

**What the state directory holds.** One directory per session, laid out in
[DESIGN.md](DESIGN.md#disk-persistence). `events.jsonl` is the server's own
record of a turn; `codex_check` never returns those events, so that file and
Codex's rollout log under `~/.codex/sessions/` are where a turn that went wrong
is read.

**Environment variables.** [INSTALL.md](INSTALL.md#environment-variables) lists
them; the `codex-mcp:///config` resource lists them from the running server.

## What stays local

The repository-root `.mcp.json` and `.codex-mcp-state/` are git-ignored. Nothing
here reaches the published package either: `package.json` carries a `files`
whitelist, so the tarball holds `dist/` and the top-level documents and nothing
else. `npm pack --dry-run` prints the list.
