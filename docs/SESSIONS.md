# Running a session

How the five tools are used together. Each tool's inputs are in
[TOOLS.md](TOOLS.md); the terms are in [GLOSSARY.md](GLOSSARY.md).

## The loop

```text
1. codex(prompt=…, approvalPolicy=…, sandbox=…)   → { sessionId, status: "running" }
2. codex_check(action="poll", waitMs=300000)      → status, progress, actions[]
3. write progress.activity out where the person waiting reads it
4. answer every entry of actions[]                → respond_permission / respond_user_input
5. repeat 2 until status is idle, error or cancelled
6. read result from the check that first saw the terminal status
7. codex_reply(prompt=…) to carry the same thread on
```

A start never blocks for the result, so step 2 is the only place the caller
waits. `codex_session(action="interrupt")` stops the current turn without ending
the session.

## Checking

`codex_check(action="poll")` answers at once. With `waitMs` it holds the call
until the status changes, an action arrives, the turn ends, or Codex says it is
working on something new — one call covering a stretch that would otherwise be
dozens of round trips. Message deltas, reasoning, command output and token
counters move nothing the caller reports and do not end the wait.

`waitedMs` says how long the call was held, and `progress.activityStandingMs` how
long the session has been on the line it answers with. A caller that polls in
rounds of 300000 writes one line per round — the new heading, or the standing one
with the minutes it has stood — and needs to remember nothing between them.

One wait is capped at 3,600,000 ms, and cut further to what the MCP client will
hold a tool call open for. A turn that runs longer is carried by calling again:
the cap bounds a single call, not a turn. A wait that reaches the cap
answers with the current status and no error, so a caller cannot tell a timeout
from a quiet turn and does not need to.

Without `waitMs`, `pollInterval` is the floor: 120,000 ms while `running`, 1,000
ms while `waiting_approval`. It is a minimum, not a schedule — a large task can
be left alone far longer.

Four long polls at once per session is the limit. A fifth logs a line on the
server's stderr and answers with a single immediate read rather than waiting.

**The turn's events never reach the caller.** `codex_check` reports where the
session stands and what it waits for. Codex writes the whole run — every
reasoning step, command and message — to its own rollout log under
`~/.codex/sessions/`, and the server writes its own view to `events.jsonl` in
the session directory. Read either from disk when a turn needs taking apart;
putting it through an MCP client would run the whole transcript through the
model a second time.

## What the agent is doing

`progress.activity` carries one line in Codex's own words: *"Fixing the failing
session-manager test"*. It comes from a standing instruction the server puts on
every thread it starts, asking Codex to write

```text
%%%ACTIVITY: <what you are doing right now>%%%
```

whenever it starts something new, in the language of the request.

- **It is a heading, not a percentage.** How much of the task is done is unknown
  to the agent and is not reported. The newest line overwrites the one before
  it: ten sessions cost ten strings.
- **The server cuts every marker out of the answer.** What the caller reads is
  Codex's answer without the lines the server asked for.
- **The stream cuts markers apart.** Deltas are model tokens, so `%%%` arrives
  as `"%%"` then `"%"` as readily as whole; the scanner decides on the
  concatenation across deltas, not on one delta.
- **A bare `%%%` run never matches.** The `ACTIVITY:` tag is required, which
  keeps `printf '%%%d'` in quoted output from registering. A whole marker Codex
  quotes back from a file does register, and costs one wrong heading until the
  next real one.
- **Bounded.** The line is cut to 120 characters, and an opener with no closing
  sentinel within 480 characters or before the line ends is given up as ordinary
  text.
- `advanced.developerInstructions` is appended after this instruction, not
  instead of it. `CODEX_MCP_DISABLE_ACTIVITY_MARKER=1` stops the server sending
  it, and `progress.activity` then stays empty.
- **`exec` mode has no activity line.** `codex exec` takes no developer
  instructions, so no marker is ever written.

Every extracted line is also appended to the session's `events.jsonl` as an
`activity` record, so a reader of the state directory gets the sequence of what
a session was doing without reading the raw stream around it.

### While the call is still held

A caller that put `_meta.progressToken` on its `tools/call` is sent, for as long
as a `codex_check` long poll is held: the line the session stands on when the
poll starts, each new line as it arrives, and that same line again every 30 s
(`CODEX_MCP_PROGRESS_HEARTBEAT_MS`) with how long it has stood. An MCP client
renders those under the running tool call.

The heartbeat also keeps a client watchdog from ending a call that has said
nothing — Claude Code 2.1.250 ends a silent stdio call at 1,800,000 ms.

A call that carried no progress token is sent nothing: the client did not ask,
and the protocol has no other place to put the line. Whichever way, the
notification reaches the caller that made the call and nobody else, so the line
the caller writes out itself is what a person watching reads.

## Approvals and questions

What Codex asks for arrives in `actions[]` and the turn waits there. Answer each
entry by its `requestId` — `respond_permission` for an approval,
`respond_user_input` for a question — and the session goes back to `running`
when the last one is answered.

An unanswered approval is declined by the server after `approvalTimeoutMs`,
60,000 ms by default, and an unanswered question is answered with an empty set.
**That default is shorter than the 120,000 ms poll interval a running session
suggests**, so an approval can expire between two checks. Three ways out, in
order of preference: pass `waitMs`, which returns the moment the action arrives;
raise `advanced.approvalTimeoutMs`; or take approvals out of the run with
`approvalPolicy: "never"`.

Not every command raises an approval. The approval policy goes to the Codex CLI,
which classifies each command itself and sends a request only for the ones its
policy holds back; `codex-mcp` sees a request or it does not. An expected
approval that never appears was auto-approved upstream, not lost here — and
under `never` none appears at all.

Answering several open actions at once is allowed, and a response that arrives
after the request was already resolved answers `REQUEST_NOT_FOUND`. Answering
them one at a time avoids that entirely.

`denyMessage` is recorded in the event log for the person reading it later; it
is not sent to Codex.

## Permission model

Three layers, and the first two are the caller's to set on every `codex` call.

| Layer | What it is | Values |
| --- | --- | --- |
| Approval policy | How often Codex asks before acting | `untrusted`, `on-failure`, `on-request`, `never` |
| Sandbox | What Codex may touch | `read-only`, `workspace-write`, `danger-full-access` |
| Arbitration | Who answers each request | the caller, through `codex_check`, within `approvalTimeoutMs` |

## Who holds a session

A session is driven by one codex-mcp process, which writes itself into the
session's directory as `owner.json` — its pid and its start time, so a pid
handed on to another process cannot be mistaken for it. Two clients can run two
servers over one state directory: each writes its own sessions, lists
everybody's, and refuses to act on a session another running server holds
(`SESSION_HELD_BY_OTHER_SERVER`).

`codex_session(action="list")` shows both halves of that: `owner` for a held
session, absent for a free one, and `activity` saying what each was last doing.

## Picking up a session whose server went away

When a server dies or its client disconnects, the sessions it was driving are
left with no owner. A turn that was running at that moment comes back as
`abandoned`: the work was cut off, nothing failed, nobody asked it to stop, and
Codex still carries the thread in its rollout log.

```json
{ "action": "list" }
```

Pick an entry with no `owner`, read its `activity` and `lastActiveAt`, then:

```json
{ "action": "resume", "sessionId": "sess_abc123" }
```

Resume starts a codex process for the session, restores the thread from the
rollout log with the parameters the session runs with — the ones it was created
with, and the newest reasoning effort, summary mode and personality any turn of
it set — and lands the session `idle`. It does not replay the interrupted turn — `codex_reply` carries the work
on, and the caller says what to do about the part that was cut off.

Three places resume does not go:

- **`exec` mode.** `codex exec` implements no thread resume, so the call fails
  with `THREAD_FORK_RESUME_FAILED` carrying `EXEC_NOT_SUPPORTED`. The session
  keeps its `abandoned` status and the work goes to a new session.
- **A session with no recorded `threadId`.** Nothing was started that could be
  resumed.
- **A session whose owner cannot be checked.** When the recorded pid answers
  neither a liveness probe nor a start-time read, the session counts as held and
  resume refuses it. No flag overrides that. Where you know the process is gone,
  delete `owner.json` from the session's directory; that is the only way out.

`codex_session(action="clean", statuses: ["abandoned"])` drops cut-off sessions
instead of resuming them.

## Cleanup

Two clocks run, and they measure different things.

**In memory, once a minute**, against `lastActiveAt`:

| Status | After | What happens |
| --- | --- | --- |
| `idle` | 30 minutes | cancelled |
| `running`, `waiting_approval` | 4 hours | cancelled |
| `cancelled`, `error` | 5 minutes | dropped from memory and from disk |
| `abandoned` | — | left alone |

A session within 60 seconds of its deadline gets one `ttl_warning` record in its
`events.jsonl`. `lastActiveAt` moves when the session does — a reply, a cancel,
a resume, a notification from the backend — and not when a caller polls it, so
checking a session does not keep it alive.

**On disk, once per server start**, the state directory is pruned by age (7
days), by count (200 sessions) and by total size (500 MB), oldest first. A
directory a live server owns is skipped whatever its age.

`codex_session(action="clean")` does the same on demand, filtered by `statuses`
and `olderThanMs`, previewable with `dryRun`, and leaving the disk alone with
`includeDisk: false`.

## When a session ends badly

- **A retryable interruption keeps the session `running`.** Only a failure the
  backend will not retry moves it to `error`.
- **An `error` status does not always carry a `result`.** A failure the backend
  reported as a protocol error is recorded in `events.jsonl`; a failure that
  killed the child process is carried in `result.error`.
- **A cancelled session cannot be continued.** `codex_reply` answers
  `CANCELLED`. Fork the thread before cancelling if the work should go on.
- **Cancelling does not throw the answer away.** A turn that had already
  finished keeps its result; the cancellation is recorded beside it. Only a
  cancel that interrupts a turn with no answer of its own leaves a `cancelled`
  result.
