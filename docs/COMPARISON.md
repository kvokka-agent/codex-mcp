# codex-mcp against the alternatives

Every way of driving Codex from a coding agent, what it reaches, and where it
stops. Terms are defined in [GLOSSARY.md](GLOSSARY.md).

Two kinds of statement appear below and are marked apart. A **property** is
readable in the source named beside it. A **measurement** is a number from a run
on one machine, and carries the conditions it was taken under.

## `openai/codex-plugin-cc`

OpenAI's own Claude Code plugin, version 1.0.6. Not an MCP server: seven slash
commands, a subagent, three skills, three hooks and a Node script that speaks
JSON-RPC to `codex app-server`, optionally through a per-workspace broker.

### Where codex-mcp reaches further

**Any MCP client, not one.** `codex-mcp` is an MCP stdio server, so Claude Code,
Claude Desktop, Cursor and anything else speaking the protocol drive it.
`codex-plugin-cc` is a Claude Code plugin and runs nowhere else.

**Sessions run at once.** `codex-mcp` holds one child process per session
(`src/session/manager.ts`) and no lock above them; ten sessions run ten Codex
processes. `codex-plugin-cc`'s broker is single-flight — it holds one request
slot and one stream slot, and a second client gets JSON-RPC error `-32001`,
`"Shared Codex broker is busy."`
(`plugins/codex/scripts/app-server-broker.mjs`). The broker is keyed by
workspace, so two Claude Code windows open on one repository contend for it.

*Measurement: ten `codex` sessions started from one client against one server
ran to their results concurrently on a live stand, one Codex process each.*

**A turn outlives any tool-call budget.** `codex` returns a `sessionId` at once
and `codex_check(action="poll", waitMs=…)` waits for the next thing the caller
must act on; one wait is capped at 120,000 ms
(`MAX_LONG_POLL_WAIT_MS`, `src/types.ts`) and the caller repeats it for as long
as the turn runs. Nothing in the path is bounded by the client's Bash tool.
`codex-plugin-cc`'s foreground path runs Codex inside one Bash call, and Claude
Code's Bash tool caps a call at 600,000 ms — a harness limit, not the plugin's.
The plugin does have a real escape: `codex-companion.mjs task --background`
spawns a detached worker process that outlives the call
(`plugins/codex/scripts/codex-companion.mjs`). Its own `codex-rescue` subagent
cannot use it — the `codex-cli-runtime` skill instructs the subagent to strip
`--background` before calling `task`
(`plugins/codex/skills/codex-cli-runtime/SKILL.md`).

*Measurement: a twelve-minute Codex turn was carried to its result by repeated
`waitMs=120000` polls, on a live stand.*

**The session survives the client.** When the codex-mcp process holding a
session goes away mid-turn, the session comes back as `abandoned`, its
`owner.json` is gone, and `codex_session(action="resume")` starts a new Codex
process and restores the thread from Codex's rollout log, the cut-off turn
included (`src/session/manager.ts`, proven by
`tests/server-lifecycle.e2e.test.ts`). `codex-plugin-cc` reaps on the way out:
its `SessionEnd` hook kills every queued or running job of the ending session
and tears the broker down
(`plugins/codex/scripts/session-lifecycle-hook.mjs`), so a background job does
not survive Claude closing.

**Two servers share one state directory.** Ownership is per session, not per
directory: each server writes `owner.json` into the sessions it drives, lists
everybody's, and refuses to act on another's with
`SESSION_HELD_BY_OTHER_SERVER`. `tests/server-lifecycle.e2e.test.ts` runs two
servers over one state directory and checks each sees the other's sessions and
leaves them alone.

**A status protocol instead of an event stream.** `codex_check` answers with
where the session stands and what it waits for — status, `progress`, `actions[]`
and the finished turn's result — and never with the turn's events. The
transcript stays in Codex's rollout log under `~/.codex/sessions/`. A long poll
wakes only on a status change, a new action or the end of the turn, so the
delta and token-counter traffic in between costs the caller nothing.

*Measurement: on one run of ten parallel agents, 20.2% of the traffic from
app-server was agent-message deltas and 25.7% token-counter updates; waking a
long poll on those cut the median round trip to 4.8 s and put the whole
transcript through the caller's context (recorded in `src/session/manager.ts`).
Across a before-and-after pair of ten-agent runs the caller's token bill went
from 44.6M to 2.35M — 19×. The two runs were not on the same project; adjusting
for that difference leaves a lower bound of 13.2×.*

**One line saying what the agent is doing.** `progress.activity` carries the
last `%%%ACTIVITY: …%%%` line Codex wrote, in Codex's own words and in the
language of the request. It is overwritten, never accumulated, and the server
cuts every marker out of the answer the caller reads
(`src/session/activity-marker.ts`).

**Edits are asked for, not announced.** With `approvalPolicy` set to anything
but `never`, Codex's approval requests arrive in `actions[]` and the turn waits
until the caller answers each by `requestId`. `codex-plugin-cc` starts every
thread with `approvalPolicy: "never"` — nothing passes another value
(`plugins/codex/scripts/lib/codex.mjs`) — and its client answers every
server-initiated request with `-32601`
(`plugins/codex/scripts/lib/app-server.mjs`). `--write` flips the sandbox to
`workspace-write` and is the documented default for `/codex:rescue`. The list of
touched files is computed and reaches the job JSON, but the rendered answer is
Codex's raw output, so a Claude Code caller learns about the edits from the
answer text.

**A failed turn reports as a failed turn.** `codex-mcp` sets `isError: true` and
returns `Error [CODE]: message` in the tool result. `codex-plugin-cc` sets
`process.exitCode = 1` when a turn does not end `completed`
(`plugins/codex/scripts/codex-companion.mjs`), and its `codex-rescue` subagent
is instructed "If the Bash call fails or Codex cannot be invoked, return
nothing" (`plugins/codex/agents/codex-rescue.md`), so a failed Codex run can
reach the main thread as an empty answer.

**Turn completion is not inferred.** `codex-mcp` ends a turn on the backend's
`turn/completed`. `codex-plugin-cc` also arms a 250 ms timer after the final
message and, when the timer wins, records the turn as `status: "completed"`
without having seen one (`plugins/codex/scripts/lib/codex.mjs`).

**Session history is kept until it is pruned by age, count and size.**
`codex-plugin-cc` keeps at most 50 jobs and deletes the rest along with their
logs on every state write (`plugins/codex/scripts/lib/state.mjs`).

### Where `codex-plugin-cc` reaches further

**Nothing to install or keep running.** Three slash commands and a setup check,
no `mcpServers` entry to hand-edit, and `/codex:setup` will install the Codex
CLI when it is missing. `codex-mcp` needs a server entry in the client's
configuration — the plugin in this repository is what closes that gap for Claude
Code, and does nothing for other clients.

**Hooks.** An MCP server is call-and-response and is never told the session
started or ended. `codex-plugin-cc` registers `SessionStart`, `SessionEnd` and a
`Stop` gate; the `Stop` gate runs a full Codex review of Claude's last turn and
can block the stop. Nothing in MCP expresses that.

**Slash commands and mid-flow questions.** Its commands carry argument hints,
per-command tool allowlists and pre-executed bash whose output is expanded into
the prompt with no tool round trip, and they use `AskUserQuestion` to ask the
person wait-or-background before a long review. MCP has no user-invocable
command surface, and a server can prompt the person only through elicitation,
which few clients implement.

**Prompting ships as skills.** Three skills with reference files load only when
relevant. An MCP server's only lever on the caller's behaviour is its tool
descriptions, which sit in context on every call.

**Session transfer.** `/codex:transfer` reads the Claude transcript and turns it
into a resumable Codex thread. It depends on the transcript path the
`SessionStart` hook exported; an MCP server is never told where that file is.

**One warm Codex process per workspace.** The broker's single-flight behaviour
is the cost of a design that also spares every caller the spawn and `initialize`
cost. `codex-mcp` pays a cold start per session, deliberately.

## The other routes

**`codex mcp-server`.** OpenAI deprecated it in favour of the app server: an MCP
tool's request/response shape carries no streaming diffs, no approval workflow,
no thread persistence and no server-initiated requests. MCP remains the way to
connect tools *to* Codex; the app server is how a client connects *to* Codex.
`codex-mcp` is on the app server for that reason.

**`codex exec` from a subagent's Bash call.** The plainest route, bounded by the
client's Bash ceiling, and `codex exec` has no way to ask its caller a question
mid-run. `codex-mcp` uses `codex exec --json` itself, but only as the fallback
for a codex binary carrying no `app-server` subcommand.

**Agent bridges.** `raysonmeng/agent-bridge` attaches exactly one Claude Code
session to its daemon and refuses the second, and inside a session it addresses
nothing: every message carries a `source` of `claude` or `codex`, so two
subagents delegating at once read each other's answers. `EthanSK/agent-bridge`
solves the addressing with personas and thread binding, and rests on Claude Code
Channels, which needs a claude.ai login and loads custom channels only behind
`--dangerously-load-development-channels`; channels push into the session rather
than into the subagent, which is the opposite of keeping a delegation out of the
main context.

**Orchestrators standing above both CLIs.** Conductor, Emdash, Vibe Kanban and
the rest put the orchestration protocol into every prompt and take the
delegation decision away from the agent making it.

## What codex-mcp does not do

- **`exec` mode cannot resume or fork.** On a codex binary with no `app-server`,
  `codex_session(action="resume")` and `action="fork"` fail with
  `THREAD_FORK_RESUME_FAILED` carrying `EXEC_NOT_SUPPORTED`, because `codex exec`
  implements no thread resume. An abandoned session keeps its status and the work
  has to be handed to a new session. Exec mode also carries no approvals, no user
  input and no activity line.
- **A session whose owner cannot be checked stays held.** When the recorded pid
  answers neither a liveness probe nor a start-time read, `codex-mcp` treats the
  session as held and refuses to resume it. No flag overrides that. Deleting
  `owner.json` from the session's directory is the only way out, and it is on the
  person who knows the process is gone.
- **The resume path has not been driven by a real Codex.** Ownership handover,
  resume, and the turn parameters a resumed session runs with are covered by the
  unit tests, by the end-to-end suite against a stand-in codex binary, and by
  `codex-schema/`. What a live `codex app-server` does with a reasoning effort on
  a resumed thread is stated from the schema, not observed.
- **The end-to-end suite skips itself on Windows.** `tests/server-lifecycle.e2e.test.ts`
  hands the server a `.mjs` stand-in as the codex binary, and Windows spawns an
  executable by its extension. The lifetimes it measures — startup, stdin EOF,
  shutdown, ownership handover, resume — carry evidence from Linux and macOS
  only. The pieces underneath them are covered per platform by the unit tests.
- **It has no hooks, no slash commands and cannot ask the person a question.**
  Those belong to the client. For Claude Code, the plugin in this repository
  supplies the subagent and the hook.
- **The client and the server run on one machine.** Everything travels over
  stdio, child processes share the local filesystem and `~/.codex/config.toml`,
  and every `cwd` is a local path.

## Relationship to the upstream project

`codex-mcp` is the work of @leo000001, published at
<https://github.com/xihuai18/codex-mcp/>. The design, the app-server protocol
mapping and the exec fallback are theirs.

The fork exists because that repository stands at 2.1.0 while releases through
2.1.7 went out on npm alone, so the published source and the published package
describe different servers. This fork reconstructs 2.1.1 through 2.1.7 from the
sourcemaps of the published packages, puts them under test, and releases from
the tree it publishes.
