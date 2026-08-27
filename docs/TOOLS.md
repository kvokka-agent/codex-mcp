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
| `approvalPolicy` | `untrusted` \| `on-failure` \| `on-request` \| `never` | yes | — |
| `sandbox` | `read-only` \| `workspace-write` \| `danger-full-access` | yes | — |
| `effort` | `none` \| `minimal` \| `low` \| `medium` \| `high` \| `xhigh` | no | `low` |
| `cwd` | string | no | the server's cwd |
| `model` | string | no | `config.toml` |
| `profile` | string | no | the CLI's default profile |
| `advanced` | object | no | — |

`approvalPolicy` and `sandbox` carry no default on purpose: the caller states
its own permission level rather than inheriting one.

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
| `approvalTimeoutMs` | number | `60000` | How long an unanswered approval waits before the server declines it |
| `waitForResult` | number | — | Block up to this many ms for the result, at most `300000` |

Returns `{ sessionId, threadId, status, pollInterval, progress, execution,
interactionState, recommendedNextAction }`, plus `compatWarnings` when the
backend refused something and the server carried on. With `waitForResult` and a
turn that finished in time it also returns `result` and `completedAt`.

`execution` says what happened to a foreground wait: `requested` and `effective`
are `background` or `foreground`, and `fallbackReason` is
`wait_for_result_timeout`, `interactive_poll_required` — the turn asked for an
approval — or `wait_refused`.

Use `waitForResult` only with `approvalPolicy` `on-failure` or `never`. An
approval request ends the wait early and hands back a session to poll.

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
| `waitForResult` | number, at most `300000` | no |

Returns what `codex` returns.

An override sticks. `effort`, `summary` and `personality` travel on every turn
rather than living on the thread, so the session remembers the newest value and
later turns — including the first turn after a resume — run with it instead of
falling back to `config.toml`.

In `exec` mode a `sandbox`, `cwd` or `outputSchema` override after the first
turn cannot be applied — `codex exec resume` takes no such flag — and the
response says so in `compatWarnings`.

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
  "actions": []
}
```

`result` is absent until the check that first sees a terminal status.

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
  one.
- `actions[]` — what the caller must answer, each with its `requestId`, `kind`
  (`command`, `fileChange`, `user_input`), the backend's raw `params`, and the
  amendment context a command approval offers.
- `result` — the finished turn's answer, carried by the first check that sees a
  terminal status and never repeated.
- `interactionState` — `working`, `waiting_input` or `finished`.
- `recommendedNextAction` — `poll`, `respond_permission`, `respond_user_input`
  or `none`.
- `pollInterval` — `120000` while `running`, `1000` while `waiting_approval`,
  absent otherwise.

`waitMs` long-polls: the call returns when the status changes, an action
arrives, or the turn ends. Reasoning, command output, message deltas and token
counters do not end the wait. Nothing else returns either, so ask for more than
the task can take — `3600000` is this server's own maximum.

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
| `clean_background_terminals` | `sessionId` | `{ success, message }` |

`clean` takes `statuses` (default `idle`, `error`, `cancelled` — `abandoned`
only when asked for), `olderThanMs`, `dryRun`, and `includeDisk` (default
`true`).

Each listed session carries `status`, `createdAt`, `lastActiveAt`,
`pendingRequestCount`, the `model`, `approvalPolicy` and `sandbox` it runs with,
`activity`, and `owner` — `{ pid, state: "self" | "other" }` for a session a
running server holds, and nothing at all for a free one.

`resume` and `fork` need app-server mode. In `exec` mode both fail with
`THREAD_FORK_RESUME_FAILED` carrying `EXEC_NOT_SUPPORTED`.

## `codex_setup` — is this machine ready

Takes an optional `cwd` and answers `ready`, the resolved `executable`, the
`auth` state (`authenticated`, `unauthenticated` or `unknown`, from
`codex login status`), the `runtime` (backend mode and state directory),
`projectContext` (whether a user and a project `config.toml` exist), and
`warnings` with `nextSteps`.

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
| `EXEC_NOT_SUPPORTED` | The action needs app-server mode |
| `INTERNAL` | Anything else; filesystem paths in the message are replaced by `<path>` |

`TIMEOUT` and `APP_SERVER_START_FAILED` are declared and carried by the
`codex-mcp:///errors` resource, and nothing in the server throws them.

## Resources

A client that reads MCP resources gets seven, all read-only:

| URI | Type | What it holds |
| --- | --- | --- |
| `codex-mcp:///server-info` | JSON | Version, detected Codex CLI version, backend mode, platform, stdio mode, the supported enums, active session count |
| `codex-mcp:///compat-report` | JSON | Which features this build carries, for a client adapting to it |
| `codex-mcp:///config` | Markdown | Parameter guide and the `config.toml` mapping |
| `codex-mcp:///gotchas` | Markdown | The practical limits and the traps |
| `codex-mcp:///quickstart` | Markdown | The main loop, with payloads |
| `codex-mcp:///errors` | Markdown | The error codes with a recovery hint each |
| `codex-mcp:///delegation-guide` | Markdown | Approval and sandbox presets per kind of task |
