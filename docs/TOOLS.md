# The tools

Five tools and seven read-only resources. This document is the input-by-input
reference; [SESSIONS.md](SESSIONS.md) says how they are used together, and
[GLOSSARY.md](GLOSSARY.md) defines the terms.

Every tool answers with the MCP `CallToolResult` contract: `content` carrying
the payload as JSON text, `structuredContent` carrying the same payload as an
object, and `isError`. A payload that is not an object is wrapped as
`{ "value": … }`. A failure sets `isError: true` and puts
`Error [CODE]: message` in both places rather than raising a transport error, so
the stdio channel stays healthy.

## `codex` — start a session

Starts a session and returns as soon as the thread does. Poll it with
`codex_check`.

| Parameter | Type | Required | Default |
| --- | --- | --- | --- |
| `prompt` | string | yes | — |
| `approvalPolicy` | `untrusted` \| `on-request` \| `never` | unless `CODEX_MCP_DEFAULT_APPROVAL_POLICY` is set | that variable |
| `sandbox` | `read-only` \| `workspace-write` \| `danger-full-access` | unless `CODEX_MCP_DEFAULT_SANDBOX` is set | that variable |
| `effort` | any non-empty string; Codex 0.150.1 advertises `low`, `medium`, `high`, `xhigh`, `max`, `ultra` | no | `CODEX_MCP_DEFAULT_EFFORT`, else `low` |
| `cwd` | string | no | the server's cwd |
| `model` | string | no | `CODEX_MCP_DEFAULT_MODEL`, else config.toml |
| `profile` | string | no | the CLI's default profile |
| `advanced` | object | no | — |

Five parameters come from the environment the client started the server in,
where the call names none of them: `model`, `effort`, `advanced.approvalTimeoutMs`,
`approvalPolicy` and `sandbox`, from the `CODEX_MCP_DEFAULT_*` variables listed in
`docs/INSTALL.md`. A call that names one gets what it named.

`approvalPolicy` and `sandbox` are the permission level of the turn, so the
server never picks one on its own: where its variable is unset the parameter
stays required, and where it is set the schema publishes it as optional with
that value as its default. The tool description a client reads carries the
values in force, so `tools/list` says what a session will actually start on.

`advanced`:

| Parameter | Type | Default | What it does |
| --- | --- | --- | --- |
| `baseInstructions` | string | — | Replaces the system instructions of the thread |
| `developerInstructions` | string | — | Appended after the activity-marker instruction |
| `personality` | `none` \| `friendly` \| `pragmatic` | `config.toml` | |
| `summary` | `auto` \| `concise` \| `detailed` \| `none` | `config.toml` | Reasoning summary |
| `config` | object | — | Passed to the CLI as `-c key=value` |
| `ephemeral` | boolean | `false` | Do not persist the thread |
| `outputSchema` | object | — | JSON Schema for structured output |
| `images` | string[] | — | Local image paths added to the first message |
| `approvalTimeoutMs` | number | `CODEX_MCP_DEFAULT_APPROVAL_TIMEOUT_MS`, else `60000` | How long an unanswered approval waits before the server declines it |

Returns `{ sessionId, threadId, status, pollInterval, progress,
interactionState, recommendedNextAction }`, plus `compatWarnings` when the
backend refused something and the server carried on.

It returns as soon as the thread is up, and the turn runs on. Follow it with
`codex_check(action="poll", waitMs=300000)`.

## `codex_reply` — continue a session

Allowed while the session is `idle` or `error`. Anything else answers
`SESSION_BUSY`, an abandoned session answers `SESSION_NOT_RUNNING` and names
`resume`, and a cancelled one answers `CANCELLED`.

| Parameter | Type | Required |
| --- | --- | --- |
| `sessionId` | string | yes |
| `prompt` | string | yes |
| `model`, `approvalPolicy`, `effort`, `summary`, `personality`, `sandbox`, `cwd` | as in `codex` | no |
| `outputSchema` | object | no |

Returns what `codex` returns.

An override sticks. `effort`, `summary` and `personality` travel on every turn
rather than living on the thread, so the session remembers the newest value and
later turns — including the first turn after a resume — run with it instead of
falling back to `config.toml`.

## `codex_check` — where it stands, and answering it

Every action answers with the same payload:

```json
{
  "sessionId": "sess_abc123",
  "status": "running",
  "pollInterval": 120000,
  "progress": { "phase": "acting", "lastEventAt": "…", "activeTurnId": "…", "pendingActionCount": 0, "tokens": {}, "activity": "Fixing the failing session-manager test" },
  "interactionState": "working",
  "recommendedNextAction": "poll",
  "actions": [],
  "warnings": []
}
```

`result` is absent until the status is terminal, and then every check carries it.

| Parameter | Type | Used with |
| --- | --- | --- |
| `action` | `poll` \| `respond_permission` \| `respond_user_input` | always |
| `sessionId` | string | always |
| `waitMs` | number, clamped to `3600000` and to what the client tolerates | `poll` |
| `requestId` | string | both `respond_*`, required |
| `decision` | see below | `respond_permission`, required |
| `execpolicy_amendment` | string[] | `decision="acceptWithExecpolicyAmendment"`, required there |
| `network_policy_amendment` | `{ action: "allow" \| "deny", host }` | `decision="applyNetworkPolicyAmendment"`, required there |
| `denyMessage` | string | `respond_permission`; recorded in the event log, never sent to Codex |
| `answers` | `{ questionId: { answers: string[] } }` | `respond_user_input`, required |

A field used with the wrong action is refused by name, and so are the five
inputs the tool no longer takes — `maxEvents`, `cursor`, `nextCursor`,
`responseMode`, `pollOptions` — each with a message naming what replaced it.

`decision` for a command approval: `accept`, `acceptForSession`,
`acceptWithExecpolicyAmendment`, `applyNetworkPolicyAmendment`, `decline`,
`cancel`. For a file change: `accept`, `acceptForSession`, `decline`, `cancel`.
When the request advertised `availableDecisions`, the answer must be one of
those.

The payload's parts:

- `status` — `running`, `waiting_approval`, `idle`, `error`, `cancelled` or
  `abandoned`.
- `progress.phase` — `starting`, `running`, `reasoning`, `acting`,
  `waiting_approval`, `finished`, `error` or `cancelled`.
- `progress.activity` — the last activity line, absent until the turn writes
  one. `progress.activitySince` is when it arrived and
  `progress.activityStandingMs` how long the session has been on it, so a caller
  reports "compiling — 15 min" without counting its own polls.
- `waitedMs` — how long a `poll` with `waitMs` held the call. A round that
  answers with nothing new held it for the whole window.
- `actions[]` — what the caller must answer, each with its `requestId`, `kind`
  (`command`, `fileChange`, `user_input`), the backend's raw `params`, and the
  amendment context a command approval offers.
- `warnings[]` — why the turn is producing no output, oldest first, each
  `{ method, message, at }`. `method` is the app-server notification that carried
  it: `warning` and `guardianWarning` for free text the backend wrote,
  `model/safetyBuffering/updated` for a model whose output is being held back and
  the reasons named for it, and `hook/completed` for a hook of the user's own
  codex config that blocked, failed or was stopped. Report these beside
  `progress.activity`: the activity line is what the turn is doing, a warning is
  what stands in its way. The five newest are kept, each cut to 400 characters,
  and a backend repeating the standing one refreshes its `at` rather than adding
  an entry.
- `result` — the finished turn's answer, carried by every check that sees a
  terminal status. `result.outcome` says how the turn ended — `completed`,
  `error` or `cancelled` — as the server saw it end. A caller that lost the
  answer reads it back here instead of writing one of its own.
- `interactionState` — `working`, `waiting_input` or `finished`.
- `recommendedNextAction` — `poll`, `respond_permission`, `respond_user_input`
  or `none`.
- `pollInterval` — `120000` while `running`, `1000` while `waiting_approval`,
  absent otherwise.

`waitMs` long-polls: the call returns when the status changes, an action
arrives, the turn ends, a new warning arrives, or Codex says it is working on
something new. Reasoning, command output, message deltas, token counters and a
warning the backend has already sent do not end the wait.

A round of `300000` is what the driver is written for: the caller writes
`progress.activity` out after each round and calls again, so the person waiting
reads the work as it happens. `3600000` is this server's own maximum, and a
round that long says nothing for an hour when the turn stays on one line.

A poll that carries `_meta.progressToken` also gets `notifications/progress`
while it is held — the standing line, each new line, each new warning, and the
standing line again every 30 s (`CODEX_MCP_PROGRESS_HEARTBEAT_MS`) with how long
it has stood. Those reach the client that made the call and nobody else.

What ends an otherwise silent wait is the MCP client, which cuts a tool call
that runs too long. The server returns 5 seconds inside that ceiling with the
current status and no error, which costs the caller one round trip per ceiling
rather than one per two minutes. Three things tell the server where the ceiling
is, in falling order of authority: a cut it watched, `MCP_TOOL_TIMEOUT` in its
environment, and the client's own default — 60 s for a client on the MCP
TypeScript SDK, and none for Claude Code, which held a call open for 1500 s and
cut nothing. Raise `MCP_TOOL_TIMEOUT` for the client and the window follows it.

A cut costs the caller an error instead of a status, so the server learns from
the first one and returns inside it from then on; the turn's answer is held back
across a cut rather than handed to a response the client already threw away.

A session serves four concurrent long polls; a fifth answers at once with a
single read.

## `codex_session` — the sessions on this machine

| Action | Needs | Answers |
| --- | --- | --- |
| `list` | — | `{ sessions[] }` — every session of the state directory, this server's and every other server's |
| `get` | `sessionId` | one session; `includeSensitive: true` adds `threadId`, `cwd`, `profile`, `config` |
| `resume` | `sessionId` | `{ sessionId, threadId, status: "idle", pollInterval, progress }` |
| `cancel` | `sessionId` | `{ success, message }` — terminal |
| `interrupt` | `sessionId` | `{ success, message }` — stops the current turn, session stays usable |
| `fork` | `sessionId` | `{ sessionId, threadId, status: "idle", pollInterval }` for the copy; the source is untouched |
| `clean` | — | `{ matchedSessionIds, removedSessionIds, removedCount, diskSessionsRemoved, dryRun }` |
| `clean_background_terminals` | `sessionId` | `{ sessionId, backgroundTerminals }` |
| `terminate_background_terminal` | `sessionId`, `processId` | `{ sessionId, backgroundTerminals }` |

`clean` takes `statuses` (default `idle`, `error`, `cancelled` — `abandoned`
only when asked for), `olderThanMs`, `dryRun`, and `includeDisk` (default
`true`).

Each listed session carries `status`, `createdAt`, `lastActiveAt`,
`pendingRequestCount`, the `model`, `approvalPolicy` and `sandbox` it runs with,
`activity`, `lastTurn`, and `owner` — `{ pid, state: "self" | "other" }` for a
session a running server holds, and nothing at all for a free one.

`lastTurn` is `{ turnId, outcome, status, completedAt, error }` for the last turn
that ended, absent until one does. `status` says what the session is now and
`cancel` rewrites it; `lastTurn` says what the work came to and `cancel` leaves
it alone, so a session closed after it answered reads `status: "cancelled"` with
`lastTurn.outcome: "completed"`.

### The background terminals of a thread

`clean_background_terminals` and `terminate_background_terminal` both answer
`backgroundTerminals`:

| Field | What it carries |
| --- | --- |
| `threadId` | The thread the call worked on |
| `terminals[]` | Every terminal the call acted on: `processId`, the `itemId`, `command`, `cwd`, `osPid`, `cpuPercent` and `rssKb` the listing gave it, `terminated` — what Codex answered for that process — `error` when the terminate call itself failed, and `gone` |
| `survivors[]` | The listing taken after the pass: what is still running, including a terminal that started during it |
| `truncated` | The listing stopped at 20 pages with a cursor still to follow |
| `cleanCalled` | `thread/backgroundTerminals/clean` swept the thread because the listing failed |
| `listError` | `{ stage: "before" \| "after", message }` — the listing failed there, so what stands now is unknown |

`terminated: false` is an answer, not a failure: the call reached Codex and the
process stayed up. `gone` is measured against the second listing, so a terminal
whose terminate answered `true` and which is still listed reads
`terminated: true, gone: false`.

`terminate_background_terminal` takes the `processId` from a
`clean_background_terminals` answer, calls `thread/backgroundTerminals/terminate`
once, and lists nothing: its `terminals` entry carries `processId` and
`terminated` and no other field.

A Codex CLI below 0.150.1 serves neither `thread/backgroundTerminals/list` nor
`…/terminate`. `clean_background_terminals` there falls back to
`thread/backgroundTerminals/clean` and answers `cleanCalled: true` with
`listError.stage: "before"` — the sweep ran and what it left is unknown.
`terminate_background_terminal` has nothing to fall back to and raises the error
the CLI answered.

## `codex_setup` — is this machine ready

Takes an optional `cwd` and answers `ready`, the resolved `executable`, the
`auth` state (`authenticated`, `unauthenticated` or `unknown`, from
`codex login status`), the `backend` (the Codex CLI version `codex --version`
printed, the minimum this server drives, and whether the one found clears it),
the `runtime` (state directory), `projectContext` (whether a user and a project
`config.toml` exist), and `warnings` with `nextSteps`.

`ready` is true only when all three clear: the executable resolves, the login
probe answered `authenticated`, and the CLI is at or above `minimumCliVersion`.

A binary named `codex-internal` skips the login probe and reports
`auth.state: "unknown"`.

## Errors

`Error [CODE]: message`, with `isError: true`.

| Code | What it means |
| --- | --- |
| `INVALID_ARGUMENT` | The input does not fit the schema or the action |
| `SESSION_NOT_FOUND` | No such `sessionId` here or on disk |
| `SESSION_HELD_BY_OTHER_SERVER` | Another running codex-mcp holds it; only its own client drives it |
| `SESSION_BUSY` | The session is running or waiting on an answer |
| `SESSION_NOT_RUNNING` | The action needs a live session; on an abandoned one, resume first |
| `REQUEST_NOT_FOUND` | The `requestId` was already answered, timed out, or never existed |
| `CANCELLED` | The session was cancelled and cannot be continued |
| `THREAD_FORK_RESUME_FAILED` | Fork or resume did not take; the message carries the backend's reason |
| `PROTOCOL_PARSE_ERROR` | A non-JSON line arrived from the backend — usually shell noise on its stdout |
| `WRITE_QUEUE_DROPPED` | The backend stopped reading stdin and the queued writes were dropped |
| `INTERNAL` | Anything else; filesystem paths in the message are replaced by `<path>` |

`TIMEOUT` and `APP_SERVER_START_FAILED` are declared and carried by the
`codex-mcp:///errors` resource, and nothing in the server throws them.

## Resources

A client that reads MCP resources gets seven, all read-only:

| URI | Type | What it holds |
| --- | --- | --- |
| `codex-mcp:///server-info` | JSON | Version, detected Codex CLI version and the minimum this server drives, platform, stdio mode, the supported enums, active session count |
| `codex-mcp:///compat-report` | JSON | Which features this build carries, for a client adapting to it |
| `codex-mcp:///config` | Markdown | Parameter guide and the `config.toml` mapping |
| `codex-mcp:///gotchas` | Markdown | The practical limits and the traps |
| `codex-mcp:///quickstart` | Markdown | The main loop, with payloads |
| `codex-mcp:///errors` | Markdown | The error codes with a recovery hint each |
| `codex-mcp:///delegation-guide` | Markdown | Approval and sandbox presets per kind of task |
