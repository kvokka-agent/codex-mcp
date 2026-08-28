# Glossary

Every term this project's documents use, defined once. A document that needs one
of these words links here instead of explaining it again.

## The parts

**MCP client** — the program that speaks the Model Context Protocol to
`codex-mcp`: Claude Code, Claude Desktop, Cursor, or anything else that launches
an MCP server. It launches the server as a child process and talks to it over
stdio.

**codex-mcp server** — this project. One process per MCP client, launched by
that client, holding every session that client starts.

**Codex CLI** — OpenAI's `codex` executable, installed and logged in separately.
`codex-mcp` spawns it and never replaces it: the model, the profile and the
sandbox defaults all come from the user's own `~/.codex/config.toml`.

**app-server mode** — the backend where `codex-mcp` spawns `codex app-server`
and speaks JSON-RPC to it over stdio. Full capability: approvals, user input,
fork, resume.

**exec mode** — the fallback backend for a codex binary that carries no
`app-server` subcommand. `codex-mcp` spawns `codex exec --json` and continues a
thread with `codex exec resume`. No approvals, no user input, no fork, no
resume, and no activity marker. [DESIGN.md](DESIGN.md) states what each
mode reaches.

**the plugin** — the Claude Code plugin published from this repository:
the MCP server, a `codex` subagent that drives one Codex turn to its result, and
a `PreToolUse` hook that keeps the Codex tools inside that subagent.
[plugins/codex-mcp/README.md](../plugins/codex-mcp/README.md) describes it.

## The work

**session** — one unit of work `codex-mcp` tracks, addressed by a `sessionId`.
One session owns one child process and one Codex thread, and lives across many
turns. `codex` starts one; `codex_reply` continues it.

**thread** — Codex's own conversation, addressed by a `threadId`. The session is
this server's handle on it; the thread is what Codex keeps, and what survives
this server entirely.

**turn** — one prompt and everything Codex does to answer it. A turn ends with a
result, an error, a cancellation, or the death of the process driving it. Only
one turn of a session runs at a time; different sessions run at once.

**result** — what a finished turn answers with: the final assistant text,
structured output when the caller asked for a schema, the turn's status and its
outcome. Every `codex_check` of a terminal session carries it, so a caller that
lost it reads it back.

**rollout log** — Codex's own transcript of a thread, written by the Codex CLI
under `~/.codex/sessions/`. Every reasoning step, command and message of a turn
is there. `codex_check` never repeats it, and a resume reads the thread back
from it.

## Watching a session

**status** — where a session stands: `running`, `waiting_approval`, `idle`,
`error`, `cancelled` or `abandoned`. `idle`, `error` and `cancelled` are
terminal for the turn — stop checking there.

**terminal status** — `idle`, `error` or `cancelled`: the turn is over and every
check of the session carries its result.

**outcome** — how a turn ended, as the server saw it end: `completed`, `error`
or `cancelled`. It is carried by `result.outcome` and by `lastTurn.outcome` of
`codex_session(action="get")`, and closing a session that answered does not
rewrite it — `status` says what the session is now, `outcome` says what the work
came to.

**abandoned** — the status of a session whose server went away mid-turn. Nothing
failed and nobody asked it to stop: the work was cut off, no process holds the
session, and `codex_session(action="resume")` picks the thread up.

**progress** — the derived view of a running turn: the phase, the count of open
actions, the time of the last event, the active turn id, the token counters the
backend reported, and the activity.

**activity** — one line in Codex's own words saying what it is doing right now,
carried as `progress.activity`. It is a heading, not a percentage: the newest
line overwrites the one before it, and nothing accumulates.

**progress notification** — `notifications/progress`, sent to a client that put
`_meta.progressToken` on its call, while that call is still being held. It
carries one activity line as its `message`, which is what the client shows under
the running tool call. A call with no token is sent none.

**activity marker** — the `%%%ACTIVITY: …%%%` line Codex writes because the
server puts a standing developer instruction on the thread. The server lifts
each marker out of the agent-message stream and cuts every one of them out of
the result text. [SESSIONS.md](SESSIONS.md) states the bounds.

**long poll** — `codex_check(action="poll", waitMs=…)`: the call blocks until
the status changes, an action arrives or the turn ends. One wait is capped;
a turn longer than the cap is carried by repeating the call.

**foreground wait** — `waitForResult` on `codex` or `codex_reply`: the call
blocks for the turn's result instead of returning a session to poll. It falls
back to polling when the turn outruns the budget or needs an answer.

**poll interval** — the minimum delay the server recommends before the next
check, in `pollInterval`. It is a floor, not a schedule.

## Answering a session

**action** — something the caller must answer, carried in `actions[]`: an
approval request, or a question. A turn stays parked until every action of it is
answered or times out.

**approval** — the request Codex sends before running a command or writing a
file, when the approval policy asks for one. The caller answers it with
`codex_check(action="respond_permission")` and a decision.

**approval policy** — how much Codex asks before acting: `untrusted`,
`on-failure`, `on-request` or `never`. Required on every `codex` call — the
caller states its own permission level rather than inheriting a default.

**sandbox** — what Codex may touch: `read-only`, `workspace-write` or
`danger-full-access`. Required on every `codex` call.

**approval timeout** — how long an unanswered approval waits before the server
declines it for the caller, set per session with `advanced.approvalTimeoutMs`.

## The state on disk

**state directory** — where the server records what it is running, so a session
outlives the process that started it. `CODEX_MCP_STATE_DIR` names it; the
default is `~/.codex-mcp/state`. It holds one directory per session under
`sessions/`.

**session directory** — one session's directory under the state directory. It
carries what the session was started with, who holds it, the events of its
turns, the child process's identity, and the terminal result.

**owner** — the codex-mcp process driving a session, recorded in the session's
directory as `owner.json` with its pid and its start time. A session listing
reports `owner: { pid, state: "self" | "other" }` for a held session and no
`owner` at all for a free one.

**held / free** — a session a running process owns is held, and only that
process acts on it; a session no running process owns is free, and can be
resumed. An owner whose fate no source can establish counts as held.

**resume** — `codex_session(action="resume")`: take a free session, start a
codex process for it and restore the thread from the rollout log, including the
turn that was cut off. app-server mode only.

**fork** — `codex_session(action="fork")`: copy the current thread into a new
session and leave the source untouched. app-server mode only.

**orphan reaper** — the startup pass that kills the codex child processes left
behind by a dead server, after proving each pid's recorded spawn time still
matches the process wearing it.

**retention** — the startup pass that prunes old session directories by age,
count and total size.

## The checks

**stdio guard** — the startup preflight that reports whether anything but
JSON-RPC risks reaching stdout, since stdout is the MCP channel.
`CODEX_MCP_STDIO_MODE` selects `auto`, `strict` or `off`.

**the gate** — `bun run check`: everything CI runs, in one command.
[DEVELOPMENT.md](DEVELOPMENT.md) states what it covers.

**release label** — `release:major`, `release:minor` or `release:patch` on a
pull request. The merge of a labelled pull request cuts the release.
[RELEASING.md](RELEASING.md) states the path from the label to npm.
