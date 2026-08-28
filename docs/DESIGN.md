# Design

How `codex-mcp` is built. The tools are described in [TOOLS.md](TOOLS.md), how
to drive them in [SESSIONS.md](SESSIONS.md), and the terms in
[GLOSSARY.md](GLOSSARY.md); this document holds what is behind them.

## Architecture

```text
MCP client
    │  MCP over stdio, same machine
    ▼
codex-mcp server (bun)
    │  JSON-RPC over stdio, one child process per session
    ▼
codex app-server        ── or ──  codex exec --json
    │
    ▼
Codex
```

The MCP client and the server run on one machine. Everything travels over
stdio, child processes share the local filesystem and `~/.codex/config.toml`,
and every `cwd` is a local path. There is no cross-machine deployment.

The server drives the `codex app-server` protocol rather than the TypeScript
SDK because the protocol carries what this server exists to expose: per-item
approval requests the caller answers, thread fork and resume, and native
`config.toml` handling — and because it ships a JSON Schema this repository
vendors under `codex-schema/` and tests against.

## Configuration resolution

A `codex` call becomes spawn arguments:

```text
codex app-server
  -c model=…                      ← model
  -c approval_policy=…            ← approvalPolicy
  -c sandbox_mode=…               ← sandbox
  -c <key>=<value>                ← advanced.config
  -p <profile>                    ← profile
```

`advanced.config` values serialize by type: a primitive through `String()`, an
object or array through `JSON.stringify()`. The CLI then loads
`~/.codex/config.toml`, applies the profile, and applies the `-c` overrides on
top.

## The subprocess

Each session owns one child process. `AppServerClient` speaks JSON-RPC over its
stdin and stdout: request ids map to a pending `{resolve, reject, timeout}`,
notifications dispatch by method, and server-initiated requests dispatch to a
handler that must answer. `ExecClient` presents the same interface over
`codex exec --json`, translating the JSONL stream into the same notification
methods and spawning one process per turn.

The stdin write queue holds at most 5 MB. On overflow every pending request
fails with `WRITE_QUEUE_DROPPED` and the child is terminated, because a backend
that stopped reading its stdin cannot be driven.

A child that exits while its session was running moves that session to `error`.

### Startup

1. The stdio preflight runs before the MCP handshake and reports
   stdout-contamination risk — a TTY on stdin or stdout, or a PowerShell
   environment on Windows. `CODEX_MCP_STDIO_MODE=strict` refuses to start on a
   blocking risk; `auto` reports and carries on; `off` skips the check.
2. The codex executable is resolved and the backend mode probed
   ([INSTALL.md](INSTALL.md#picking-the-codex-binary)). A misconfiguration
   fails here, before anything else runs.
3. The state directory is opened: prune first, then scan. Pruning first keeps a
   directory retention removed from coming back as a recovered session.
4. The recovered sessions are ingested, and the transport is connected.
5. **Then** the orphan reaper runs. Nothing holds the event loop before the
   transport is connected, so an await there could let the process exit before
   a client ever sees the server — and a confirmed orphan costs five seconds a
   client would otherwise spend waiting for a server already able to answer.

### Shutdown

The server shuts down on `SIGINT`, `SIGTERM`, `SIGBREAK`, `beforeExit`, an
uncaught exception, an unhandled rejection, or a stdin close that passes the
guard. It runs once:

1. Arm a force-exit timer — 5 seconds, 10 on Windows.
2. `finalizeForShutdown()`, synchronously and first: every session still
   `running` or `waiting_approval` is written as `abandoned`, every event log is
   flushed, and every `owner.json` this server wrote is removed. It comes first
   because a shutdown usually starts when the client went away, and every write
   to that client from here on can block until the force-exit timer fires.
3. The `server_stopping` notification and the transport close, each given one
   second. A client that died leaves a pipe nothing drains, so the SDK's write
   waits for a `drain` event that never arrives; the deadline reports the step
   and the shutdown carries on.
4. `SessionManager.destroy()` clears every pending timer and terminates every
   child.

**The stdin path.** On stdio there is one client, on the other end of that pipe,
so a stdin that has really ended is the end of the session.
`StdioServerTransport` subscribes to neither `end` nor `close`, so
`isConnected()` answers true for the life of the process and cannot gate the
decision. A stream that is readable again clears the shutdown attempt instead.
With no active session the server exits at once; with one it waits up to 10
seconds, 15 on Windows.

## Progress

`progress` summarizes a session without reading its events.

| Field | Source |
| --- | --- |
| `phase` | The status first — `waiting_approval`, `cancelled`, `error`, `idle` → `finished` — then `starting` when no turn is active, then `reasoning` or `acting` from the last observed method, else `running` |
| `lastEventAt` | The last notification or server request |
| `activeTurnId` | `turn/started`, seeded from the `turn/start` response |
| `pendingActionCount` | Unresolved pending requests |
| `tokens` | Merged from `thread/tokenUsage/updated`, the exec turn's `usage`, and a recovered result, accepting camelCase and snake_case alike |
| `activity` | The last activity marker of the turn, cleared when a turn starts |
| `activitySince`, `activityStandingMs` | When that marker arrived, and how long the session has been on it |

`reasoning` covers `item/reasoning/textDelta`,
`item/reasoning/summaryTextDelta`, `item/reasoning/summaryPartAdded` and
`item/plan/delta`. `acting` covers `item/commandExecution/outputDelta`,
`item/commandExecution/terminalInteraction`, `item/fileChange/outputDelta`,
`item/mcpToolCall/progress`, `turn/diff/updated` and `turn/plan/updated`.

### The activity marker

The contract is in [SESSIONS.md](SESSIONS.md#what-the-agent-is-doing). Three
things about it belong here.

**How it is delivered.** The instruction reaches Codex as the thread's
`developerInstructions` on `thread/start` — a field the schema types
`["string","null"]` and does not require. The server sets it, so a marker
reaches every client rather than the one that read the documentation.
`thread/fork` and `thread/resume` carry the same composed string, so a forked or
resumed session keeps the protocol. `codex exec` has no field to put it on,
which is why exec mode reports no activity.

**Why the scanner buffers.** `item/agentMessage/delta` carries model tokens,
measured at a median of three characters over 626 real deltas, and a live run
delivered the closing sentinel as `"%%"` then `"%\n"`. The scanner decides on
the concatenation of the deltas and holds at most eleven characters between
markers, or 480 inside one.

**Why it wakes a long poll.** `signalOf` carries the instant the line arrived, so
each new heading ends the wait and the poll answers with it. That is what the
person waiting reads: the caller writes the line out and polls again, and a turn
of an hour reads as a list of what the work was on rather than as an hour of
silence. A turn writes a handful of headings, so the round trips stay in the
handful too — the deltas, the reasoning and the token counters underneath them
move `signalOf` not at all.

## The event log

Every notification and server-initiated request the manager handles is appended
to the session's `events.jsonl` as one line `{ seq, type, data, timestamp }`.
The manager keeps no copy in memory: a session holds its status, its open
requests, its progress counters and the result of its last turn, and nothing
else.

`codex_check` returns none of it. A restart reads the file for two things: the
sequence number to continue from, and the last `activity` record so a listing of
an abandoned session says what it was cut off doing.

### Event type mapping

The left column is the `method` of the app-server JSON-RPC notification or
request, as `codex app-server generate-json-schema` writes it. It appears in the
log at `data.method`.

| app-server method | event type | Notes |
| --- | --- | --- |
| `item/agentMessage/delta` | output | Agent text increment; also the source of activity markers |
| activity marker (internal) | activity | One extracted `%%%ACTIVITY: …%%%` line, flushed at once |
| `item/completed` | output / progress | `agentMessage` and `userMessage` → output; every other item type → progress |
| `item/started` | progress | |
| `rawResponseItem/completed` | progress | ExecClient's `raw_response_item`; a ResponseItem, so no final answer to read |
| `item/commandExecution/outputDelta` | progress | After shell-noise filtering |
| `item/commandExecution/terminalInteraction` | progress | |
| `item/fileChange/outputDelta` | progress | |
| `item/reasoning/textDelta`, `…/summaryTextDelta`, `…/summaryPartAdded` | progress | |
| `item/plan/delta` | progress | Experimental |
| `item/mcpToolCall/progress` | progress | |
| `turn/started` | progress | The source of `activeTurnId` |
| `turn/completed` | result | |
| `turn/diff/updated`, `turn/plan/updated` | progress | |
| `thread/started` | progress | Refreshes `threadId` when it carries a new one |
| `thread/status/changed` | progress, or error | Drives the session to `idle` or `error`; the pending-request map, not the notification, decides `waiting_approval` |
| `thread/closed`, `thread/compacted` | progress | Neither is a failure |
| `thread/archived`, `thread/unarchived`, `thread/name/updated`, `thread/tokenUsage/updated` | progress | |
| `deprecationNotice`, `configWarning` | progress | |
| `model/rerouted` | progress | |
| `fuzzyFileSearch/sessionUpdated`, `fuzzyFileSearch/sessionCompleted` | progress | |
| `windows/worldWritableWarning` | progress | |
| `account/login/completed` | progress | |
| `error` with `willRetry: false` | error | Terminal |
| `error` with `willRetry: true` | progress | Rewritten to `codex-mcp/reconnect`, phase `retrying`; the session stays `running` |
| `item/commandExecution/requestApproval` | approval_request | Server-initiated request |
| `item/fileChange/requestApproval` | approval_request | Server-initiated request |
| `item/tool/requestUserInput` | approval_request | Server-initiated request |
| approval response (internal) | approval_result | The decision, timeouts included |
| `codex-mcp/ttl_warning` (internal) | progress | 60 seconds before TTL cleanup |

Any other notification is ignored.

### Shell noise filtering

On Windows a PowerShell profile leaks into command output: oh-my-posh banners,
PSReadLine, terminal-integration escape sequences. Those lines are stripped from
`item/commandExecution/outputDelta` before the delta reaches the log, and a
delta that was entirely noise produces no line at all.
`CODEX_MCP_DISABLE_NOISE_FILTER=1` turns the filter off.

## Long polling

A check with `waitMs` reads the session's signal — its status, the ids of its
open actions, and the completion instant of its last result — and returns at
once when the session already waits on the caller. Otherwise it waits on
`waitForChange` and reads the signal again, until it differs from the one it
started with, the request aborts, or the budget runs out.

`notifyWaiters` wakes waiters on that signal and on nothing else, so a stream of
deltas or token-counter updates leaves a waiter asleep. A measured run of ten
parallel sessions delivered 20.2% agent-message deltas and 25.7% token-counter
updates; waking on those turned a 120-second long poll into a 4.8-second median
round trip.

Four waiters per session. A fifth is refused, and the caller answers from a
single immediate read rather than queueing.

### The window the client allows

`waitMs` names what the caller wants; `PollWindow` names what the client on the
other end of the stdio pipe will sit through, and the wait is the smaller of the
two. A tool call the client cuts is worse than one that returned: the caller
gets an error rather than a status, the round trip is spent either way, and the
finished turn's answer would ride out on a response the client already dropped.

The window comes from a cut the server watched, else from `MCP_TOOL_TIMEOUT` in
its environment, else from the client's default; 5 seconds come off the top so
the answer is on the wire first. `notifications/cancelled` carries the client's
reason, and `AbortSignal.reason` carries it into the handler, so a timeout is
told apart from a person pressing Escape and only a timeout moves the window.
An aborted poll reads the status without consuming the turn result, which stays
undelivered for the next call.

Measured against Claude Code 2.1.247: it puts a `progressToken` in `_meta` of
every `tools/call`, `MCP_TOOL_TIMEOUT` reaches the spawned server's environment
and bounds the call to the millisecond, `notifications/progress` does not push
that bound out, and with nothing configured a call held 1500 s and was not cut.

### What the held call says while it waits

A poll carrying a `progressToken` gets `notifications/progress`: the line the
session stands on when the poll starts, each new line as it arrives, and that
same line again every `PROGRESS_HEARTBEAT_MS` (30,000, overridden by
`CODEX_MCP_PROGRESS_HEARTBEAT_MS`) with how long it has stood — `compiling — 5m`.

The heartbeat is not decoration. Claude Code 2.1.250 arms a watchdog per call and
ends one that has neither answered nor sent progress: 1,800,000 ms for a stdio
server, bounded by that call's own timeout, `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`.
Every notification resets it.

Where those notifications are rendered is the client's business, and they reach
the caller that made the call — never a person watching a subagent make it. The
answer carries the same line, and writing it out is the caller's job.

## Starting a turn

`codex` returns when the thread is up; `codex_reply` returns when the turn is
under way. Neither waits for the result, and there is no parameter that makes
them: a call that blocks for an hour reports nothing while it blocks, which is
the failure the poll loop exists to fix.

## Approval arbitration

1. app-server sends a server-initiated request:
   `item/commandExecution/requestApproval`,
   `item/fileChange/requestApproval` or `item/tool/requestUserInput`.
2. The manager mints a `requestId`, stores the request with the closure that
   answers it, moves the session to `waiting_approval`, records an
   `approval_request` event, starts the timeout timer, and wakes the waiters.
3. The caller answers through `codex_check`.
4. The manager sends the decision as the response to that request, records an
   `approval_result` event, and returns the session to `running` once no
   unresolved request remains. A send that fails puts the request back and
   leaves the session `waiting_approval`.
5. A request that times out is declined — a question is answered with an empty
   map — and the `approval_result` event carries `timeout: true`. The agent is
   not interrupted.

A request arriving on a `cancelled` or `error` session is answered immediately
and creates no pending request, so a terminal session never jumps back.

## Disk persistence

State lives under `CODEX_MCP_STATE_DIR`, default `~/.codex-mcp/state`.

```text
STATE_DIR/
└── sessions/
    └── <sessionId>/
        ├── meta.json      what the session was started with, and its status
        ├── owner.json     the codex-mcp process driving it, while one does
        ├── pid.json       the child process and its spawn time
        ├── result.json    the terminal result of the last turn
        └── events.jsonl   the append-only event log
```

Several codex-mcp servers share one state directory. Each writes its own
sessions and reads the others'; what a server may act on is decided per session
by `owner.json`.

### Write path

- `meta.json` carries everything a resumed session needs, which is two sets:
  what `thread/resume` takes, so another server starts the thread with the
  parameters it was created with, and what `turn/start` takes on every turn —
  reasoning effort, summary mode and personality are not thread state, so a turn
  that omits them falls back to `~/.codex/config.toml` rather than to what the
  session was started with. `PersistedSessionMeta` in
  `src/session/persistence.ts` is the field list; read it there rather than from
  a copy. The file is rewritten when any of those fields changes — the thread id
  reaches it the moment Codex hands it over, and a turn's parameters when the
  turn starts, because the turn runs for minutes and the server can die inside
  it. `lastActiveAt` alone never triggers a write, so a hot turn does not write a
  file per notification.

  The directory format carries a `schemaVersion`. A directory written by a newer
  server is skipped rather than misread, so a version bump costs an older server
  the sessions it cannot understand and nothing else.
- `owner.json` carries `{ pid, startedAt }` of the process driving the session.
  It is written on create, on fork and on resume, and removed when the session
  ends, is evicted, is adopted from a dead owner, or the server shuts down.
- `pid.json` carries `{ pid, spawnedAt, command?, model? }`, written right after
  the child starts. `spawnedAt` comes from the spawn event, not from the clock
  at write time, because it is what the reaper matches against the OS.
- `result.json` carries the last `TurnResult`, written when a turn completes or
  ends in error. **A cancel does not overwrite it.** A turn that already ended
  left its answer there and a turn that starts clears it, so a result present at
  cancellation belongs to a finished turn and the cancel keeps it; only a
  cancellation that interrupts a turn with no answer of its own writes a
  `cancelled` result. The cancellation itself is recorded as `cancelledAt` and
  `cancelledReason` in `meta.json` and as an event in the log.
- `events.jsonl` batches with a 100 ms timer and flushes `approval_request`,
  `approval_result`, `result`, `activity` and `error` at once. Shutdown forces a
  final flush.

Every JSON file is written by writing a sibling temp file and renaming it. A
crash between the two steps leaves the temp file and nothing half-written.

Every persistence call is best-effort: a failure prints one stderr line per
operation and session, and the session keeps running from memory. A state
directory that cannot be opened at all drops persistence entirely and the server
says so on stderr.

### Recovery

The scan runs over `STATE_DIR/sessions/`, after retention has pruned:

- A directory with no `meta.json` is skipped; one with a `schemaVersion` above
  the supported version is skipped with a stderr line.
- A `meta.json` that is present but unreadable is recovered from the directory
  itself — status `unknown`, timestamps from the mtime — so its `pid.json` still
  reaches the reaper.
- `events.jsonl` is read whole. Corrupt lines in the middle are counted and
  passed over; only a corrupt final line is dropped as the tail a crash tore.
  The scan keeps the highest `seq` and the last `activity` record, and no events.
- `result.json` and `pid.json` are read when present.

Ingest then loads them into memory:

- A session another running server holds stays on disk and never enters memory.
- A session whose owner is gone is adopted and its stale `owner.json` removed.
  One that was `running` or `waiting_approval` becomes `abandoned`.
- A session whose `meta.json` records no `createdAt` or `lastActiveAt` is
  skipped entirely, so restart-dated timestamps cannot defeat cleanup and
  retention.
- An unrecognized status becomes `error`.
- `result.json` becomes `lastResult`, so the outcome of a finished session is
  still readable.
- The event-log sequence resumes at `lastSeq + 1`.

The scan is not startup-only: `codex_session(action="list")` and
`action="resume"` re-read the directory, because the picture changes underneath
a server that shares it.

### Ownership

`owner.json` carries the owner's pid and the instant that process started,
because a pid is handed on as soon as its process exits:

- alive, and its OS start time matches within 5 seconds → **held**. The session
  is listed, and resume, prune and reap leave it alone.
- gone, or alive with another start time → **free**. The successor removes the
  claim and adopts it.
- liveness or start time no source could read → **held, unproven**. Nothing
  takes a session on a guess; the reason reaches the caller in the error.

An unproven owner keeps the session held for as long as `owner.json` names it,
and no argument overrides that. Deleting the file is the only way out.

`src/persistence/process-identity.ts` reads the start time:
`Get-CimInstance Win32_Process` on Windows, falling back to `wmic` — which is
off by default from Windows 11 24H2 and absent from Server 2025;
`ps -p <pid> -o pgid=,lstart=` elsewhere, falling back to `/proc/<pid>/stat` on
Linux. `process.kill(pid, 0)` decides liveness, and `EPERM` means alive under
another user.

### Retention

The prune runs once per server start and removes session directories oldest
first, dating each by `meta.lastActiveAt`, then `meta.createdAt`, then the
directory mtime:

1. A directory a live owner holds is skipped, whatever its age.
2. Age: older than 7 days.
3. Count: beyond 200 retained sessions.
4. Size: beyond 500 MB across all session directories.

### Orphan reaper

The reaper runs over the sessions this server adopted, so a session another
server holds is never signalled. For each adopted session that has a `pid.json`:

1. `process.kill(pid, 0)`. Dead → already gone. Unreadable → skipped, no signal.
2. Compare the recorded `spawnedAt` against the OS start time, 5-second
   tolerance. Anything but a match → skipped, no signal: a live pid that fails
   the check is a reused number.
3. Re-probe immediately before signalling, which closes the window in which the
   pid could be recycled, then terminate gracefully — `SIGTERM` to the process
   group when the child leads one, `taskkill /PID <pid> /T` on Windows.
4. Poll every 250 ms for up to 5 seconds.
5. Still alive and still the same process → force kill. Still alive and now a
   different process → the pid was handed on, counted as reaped, no force kill.
   Still alive and unreadable → left alone and reported unconfirmed.

## Session TTL

A pass runs every 60 seconds over `lastActiveAt`. The thresholds are in
[SESSIONS.md](SESSIONS.md#cleanup). Two details belong here:

- A session within 60 seconds of its deadline gets one `ttl_warning` progress
  event in its log. The flag is cleared only when the session is cancelled or
  evicted, so a session that goes idle again after a reply gets no second
  warning.
- A cleanup-driven cancel records a `progress` event and a `result` with
  `status=cancelled`, never an extra `error`.

`abandoned` sessions are outside this pass entirely. They are removed by
`codex_session(action="clean", statuses: ["abandoned"])` or by the disk
retention at a later start.

## Errors

A thrown error carries `Error [CODE]: message`. Before it reaches the client:

1. A turn-compatibility failure — `effort=minimal` against the Codex
   `web_search` tool — is replaced by the message naming the fix.
2. A message already in `Error [CODE]: …` form passes through, except
   `INTERNAL`, whose tail is run through path redaction.
3. Anything else becomes `Error [INTERNAL]: …`, redacted.

Redaction replaces UNC paths, `C:\…` paths and multi-segment POSIX paths with
`<path>`.

The codes are listed in [TOOLS.md](TOOLS.md#errors). Two of them —
`TIMEOUT` and `APP_SERVER_START_FAILED` — are declared and served in the
`codex-mcp:///errors` resource but are not thrown anywhere in `src/`.

### Turn compatibility fallback

A `turn/start` that fails with a message naming `minimal`, `web_search` and
reasoning effort together, on a turn sent with `effort=minimal`, is retried once
at `effort=low`. The response then carries a `compatWarnings` line saying so. A
retry that fails again surfaces the message telling the caller to raise the
effort itself.

## Protocol notes

`codex-schema/` vendors the JSON Schema bundle of `codex app-server` as a
committed baseline. [CODEX-UPGRADE.md](CODEX-UPGRADE.md) is how it is
regenerated and followed.

### Approval responses must match the schema exactly

Command approval (`CommandExecutionRequestApprovalResponse`):

- `accept`, `acceptForSession`, `decline`, `cancel` → `{ decision: "<name>" }`
- `acceptWithExecpolicyAmendment` →
  `{ decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: string[] } } }`
- `applyNetworkPolicyAmendment` →
  `{ decision: { applyNetworkPolicyAmendment: { network_policy_amendment: { action: "allow"|"deny", host: string } } } }`

File-change approval (`FileChangeRequestApprovalResponse`): `accept`,
`acceptForSession`, `decline`, `cancel` → `{ decision: "<name>" }`.

`denyMessage` is not a protocol field. It decorates the `approval_result` event
and goes no further.

### Approval request params

`CommandExecutionRequestApprovalParams` requires `itemId`, `threadId` and
`turnId`, and optionally carries `approvalId`, `command`, `cwd`, `reason`,
`commandActions`, `proposedExecpolicyAmendment`, `availableDecisions`,
`additionalPermissions`, `networkApprovalContext` and
`proposedNetworkPolicyAmendments`. When the request advertises
`availableDecisions`, an answer outside that set is refused.

`FileChangeRequestApprovalParams` requires the same three ids and optionally
carries `grantRoot` and `reason`. It carries no `changes[]`: file-change detail
comes from `item/fileChange/outputDelta` aggregated by `itemId`.

### Every server-initiated request is answered

app-server hangs the turn when one goes unanswered.

| Request | What the server does |
| --- | --- |
| `item/tool/requestUserInput` | Buffered as an action of kind `user_input`, answered by the caller through `codex_check` |
| `item/tool/call` | Declined with `{ success: false, contentItems: [{ type: "inputText", text: "Not supported by codex-mcp" }] }` |
| `account/chatgptAuthTokens/refresh` | JSON-RPC error `-32000` — this server manages no external auth |
| `applyPatchApproval`, `execCommandApproval` | Answered `{ decision: "denied" }` with a stderr line; deprecated, still sent by some CLI builds |
| anything else | JSON-RPC error `-32601` |

### turn/start input

`prompt` becomes `input: [{ type: "text", text: prompt }]`, and each entry of
`advanced.images` appends `{ type: "localImage", path }`.

### Reading ids out of responses

`thread/start`, `thread/fork` and `thread/resume` answer `{ thread: Thread }`,
and the server reads the id at `thread.id` and nowhere else: a session needs a
real thread id, so a differently shaped answer raises `INTERNAL` rather than
carrying on with an invented one. `turn/start` answers `{ turn: Turn }` and the
id there is only a seed — the `turn/started` notification settles `activeTurnId`.

## Security

**Input.** Zod validates every tool parameter, including the cross-field rules
of `codex_check`. `cwd` is resolved and validated before use, and app-server
validates it again. `advanced.images` paths are resolved against `cwd`.

**Isolation.** Sessions run in separate child processes and do not affect each
other. A child inherits the parent's environment, and no public session output
exposes it. A child that dies does not take the server with it.

**Sensitive data.** `codex_session(action="get")` redacts by default;
`includeSensitive: true` adds `cwd`, `profile`, `config` and `threadId`. An
answer to a question marked `isSecret` reaches Codex as given and enters
`events.jsonl` as `<secret>`. `INTERNAL` messages are path-redacted.

**Approval timeout.** The default 60 seconds auto-declines rather than letting a
session hang forever, and declining does not interrupt the agent.
