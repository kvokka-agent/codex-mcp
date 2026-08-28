# codex-mcp — Claude Code plugin

Runs OpenAI Codex from Claude Code. One connection installs two parts:

- the **`codex-mcp` MCP server**, pinned to `@kvokka/codex-mcp@2.5.0`;
- the **`codex` skill**, which starts a Codex turn, follows it in rounds of five
  minutes, writes out what Codex is working on between them, and hands back what
  Codex answered.

## Install

```text
/plugin marketplace add kvokka/codex-mcp
/plugin install codex-mcp@codex-mcp
```

To enable it for a whole project without typing the commands, put this in
`.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "codex-mcp": {
      "source": { "source": "github", "repo": "kvokka/codex-mcp" }
    }
  },
  "enabledPlugins": ["codex-mcp@codex-mcp"]
}
```

The server needs `bun`, which starts it, the Codex CLI on `PATH`, and an OpenAI
login. Where a session will not start, the skill runs `codex_setup` and reports
what it said.

## Use

Ask for the work. "Have Codex do X" loads the skill, and `/codex` loads it
outright. It starts one session per task — three tasks are three Codex agents
running at once — and follows them all in the same rounds.

## What the person watching sees

A start returns at once. The turn is followed with
`codex_check(action="poll", waitMs=300000)`, which comes back the moment Codex
says it is working on something new, an action arrives, the status changes or the
turn ends — and at the end of the five minutes otherwise. After each round the
skill writes one line:

```text
codex: reading src/session/manager.ts
codex: running the test suite — 5 min
codex: running the test suite — 10 min
```

`progress.activityStandingMs` is where the number comes from: the server measures
it from when the line arrived, so the count is right however the rounds fell.

The server also sends each line to the MCP client as `notifications/progress`
while a poll is held, with a heartbeat every 30 seconds
(`CODEX_MCP_PROGRESS_HEARTBEAT_MS`), and a client renders those under the call
that asked for them. That path ends at the caller: a notification sent under a
subagent's tool call reaches nobody watching the subagent. So the loop runs in
the thread the person is reading, and the line the skill writes is what puts the
work in front of them.

## Picking work back up after the server went away

A Codex session is driven by one codex-mcp process. When that process goes — the
client quit, `/mcp` reconnected it, the machine rebooted — the turn it was running
is left as `abandoned`: nothing failed, nobody holds the session, and Codex still
carries the thread in its rollout log.

`codex_session(action="list")` answers with every session of the state directory.
The entries carrying no `owner` are the free ones:

```text
1. sess_abc123 — Counting the TypeScript files in src — 2026-08-26T11:04:18Z
2. sess_def456 — Running the test suite — 2026-08-26T09:51:02Z
```

`codex_session(action="resume", sessionId)` starts a codex process and restores
the thread, the cut-off turn included; `codex_reply` then carries it on.

Two things this cannot do:

- `codex_reply` to an abandoned session that was not resumed answers
  `SESSION_NOT_RUNNING` and names `resume`.
- On a codex CLI with no `app-server` the server runs in `exec` mode, where
  `resume` fails with `THREAD_FORK_RESUME_FAILED` carrying `EXEC_NOT_SUPPORTED`:
  `codex exec` implements no thread resume. The session stays `abandoned`, and
  the work has to be handed to a new session.

## What the pieces are

```text
plugins/codex-mcp/
├── .claude-plugin/plugin.json          the manifest
├── .mcp.json                           the codex-mcp server, at its pinned version
└── skills/codex/SKILL.md               start, follow, report
```

The MCP server is pinned to the exact published version rather than `latest`, so
a given plugin release always runs the server it was written against.
`.mcp.json` starts it with `bunx @kvokka/codex-mcp@<version>`.

`npx` in that place starts nothing where the package is already in the tree. npm
exec answers the request from the tree of the directory the client started the
server in, so a project that carries the package at that version — the server's
own checkout, or anything depending on it — makes npm exec skip the fetch and
run the bare name `codex-mcp`, which no `PATH` answers to: the process exits 127
before writing a frame and the client reads `CONNECTION_CLOSED`. bunx fetches
the version it was asked for whatever the surrounding tree holds.

A release moves `package.json`, `plugins/codex-mcp/.claude-plugin/plugin.json`,
the marketplace entry in `.claude-plugin/marketplace.json`, the pin in
`.mcp.json` and the version this README names to the same number.
