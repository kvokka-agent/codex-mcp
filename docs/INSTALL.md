# Installing codex-mcp

The server runs on the same machine as the MCP client and talks to it over
stdio. Terms are defined in [GLOSSARY.md](GLOSSARY.md).

Before anything else: `bun` >= 1.4, which starts and runs the server, and a
Codex CLI that answers `codex --version` and has had `codex login` run. The
package ships behind a `#!/usr/bin/env bun` line and asks for no Node.js.
Without a login the server
still starts and `codex_setup` reports `auth.state: unauthenticated` — enough to
check the protocol, not enough to run a turn.

## Claude Code, through the plugin

```text
/plugin marketplace add kvokka/codex-mcp
/plugin install codex-mcp@codex-mcp
```

This is the shortest path and the one that brings the `codex` subagent and the
hook with it. [../plugins/codex-mcp/README.md](../plugins/codex-mcp/README.md)
describes the three pieces and how to enable them for a whole project from
`.claude/settings.json`.

## Any MCP client, through bunx

```json
{
  "mcpServers": {
    "codex-mcp": {
      "command": "bunx",
      "args": ["@kvokka/codex-mcp"]
    }
  }
}
```

Claude Code registers the same thing from the command line:

```bash
claude mcp add codex-mcp -- bunx @kvokka/codex-mcp
```

`npx` in place of `bunx` starts nothing in a directory whose tree already
carries `@kvokka/codex-mcp` — the server's own checkout, or a project depending
on it. npm exec answers the request from that tree, finds the package there,
skips the fetch and runs the bare name `codex-mcp`, which `PATH` answers to only
after a global install: the server exits 127 before writing a frame and the
client reports `CONNECTION_CLOSED`. bunx fetches the package it was asked for,
and it is bun that the `#!/usr/bin/env bun` line of the bundle asks for anyway.

## A global install

```bash
bun install -g @kvokka/codex-mcp
```

The package installs the `codex-mcp` binary, so a client's `command` becomes
`codex-mcp` with no arguments.

## Windows

Anything a shell prints on stdout before the server starts breaks the MCP
handshake, and a PowerShell profile banner is the usual culprit. Launch the
server with the profile off:

```powershell
pwsh -NoProfile -Command "bunx @kvokka/codex-mcp"
```

If command output inside a turn comes back as mojibake, set the shell to UTF-8:
`chcp 65001` and
`$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()`.

## Picking the codex binary

The server resolves the executable once at startup, in this order:

1. `CODEX_MCP_PATH` — a filesystem path. It must exist and be executable, or the
   server refuses to start.
2. `CODEX_MCP_COMMAND` — a bare command name looked up on `PATH`. A value
   containing a path separator is refused, and so is a name `PATH` does not
   carry.
3. `codex`, then `codex-internal`, on `PATH`.

Setting both variables is refused. Point one of them at the binary from the
client's own configuration when the default is not the one you want:

```json
{
  "mcpServers": {
    "codex-mcp": {
      "command": "bunx",
      "args": ["@kvokka/codex-mcp"],
      "env": { "CODEX_MCP_COMMAND": "codex-internal" }
    }
  }
}
```

## Picking the backend

At startup the server runs `codex app-server --help` with a five-second budget —
retried once at ten seconds if it times out — and takes `app-server` mode when
that answers. Anything else falls back to `exec` mode, and the server says so on
stderr. `CODEX_MCP_MODE` set to `app-server` or `exec` skips the probe.

`exec` mode drives `codex exec --json`, continues a thread with
`codex exec resume`, and reaches less than app-server mode does:
[COMPARISON.md](COMPARISON.md#what-codex-mcp-does-not-do) lists what it gives
up. `codex_setup` and the `codex-mcp:///server-info` resource both report which
mode is live.

## Environment variables

A value the server cannot read for one of the five `CODEX_MCP_DEFAULT_*` variables
stops it at startup, naming the variable: a session started on the built-in
default instead of the configured one is shaped exactly like the configured one.

| Variable | Default | Effect |
| --- | --- | --- |
| `CODEX_MCP_STATE_DIR` | `~/.codex-mcp/state` | Where the state directory lives. A directory the server cannot open drops disk persistence and the server runs from memory. |
| `CODEX_MCP_PATH` | unset | Filesystem path to the codex executable. |
| `CODEX_MCP_COMMAND` | unset | Command name resolved on `PATH`. Mutually exclusive with `CODEX_MCP_PATH`. |
| `CODEX_MCP_MODE` | probe | `app-server` or `exec`, forcing the backend. Any other value is ignored. |
| `CODEX_MCP_STDIO_MODE` | `auto` | `auto` reports stdout-contamination risk on stderr, `strict` refuses to start when stdin or stdout is a TTY, `off` skips the check. |
| `CODEX_MCP_DISABLE_NOISE_FILTER` | unset | `1` keeps shell-profile noise — oh-my-posh, PSReadLine, `WARNING:` lines, conda prefixes — in command output instead of stripping it. |
| `CODEX_MCP_DISABLE_ACTIVITY_MARKER` | unset | `1` stops the server putting the activity-marker instruction on new threads, so `progress.activity` stays empty. |
| `CODEX_MCP_DEFAULT_MODEL` | unset | Model a `codex` call that names none starts on. Unset leaves the model to the Codex CLI's own config.toml. |
| `CODEX_MCP_DEFAULT_EFFORT` | `low` | Reasoning effort a `codex` call that names none starts on: `none`, `minimal`, `low`, `medium`, `high` or `xhigh`. |
| `CODEX_MCP_DEFAULT_APPROVAL_TIMEOUT_MS` | `60000` | Milliseconds a pending approval waits before it auto-declines, where the call names no `advanced.approvalTimeoutMs`. |
| `CODEX_MCP_DEFAULT_APPROVAL_POLICY` | unset | Approval policy a `codex` call that names none starts on: `untrusted`, `on-failure`, `on-request` or `never`. Unset keeps `approvalPolicy` a required parameter. |
| `CODEX_MCP_DEFAULT_SANDBOX` | unset | Sandbox a `codex` call that names none starts on: `read-only`, `workspace-write` or `danger-full-access`. Unset keeps `sandbox` a required parameter. |
| `MCP_TOOL_TIMEOUT` | unset | The MCP client's own ceiling on one tool call, in ms. Set it for the client; a client hands its environment to the servers it spawns, so the server reads it and returns a `codex_check` long poll just inside it. |

## Checking the install

Call `codex_setup` from the client. It reports the resolved executable, whether
`codex login status` answered, the backend mode, the state directory, and
whether a user or project `config.toml` is visible from the target directory —
with a `nextSteps` line for anything that is not ready.
