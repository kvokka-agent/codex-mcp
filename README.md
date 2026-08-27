# codex-mcp

[![npm version](https://img.shields.io/npm/v/@kvokka/codex-mcp.svg)](https://www.npmjs.com/package/@kvokka/codex-mcp)
[![license](https://img.shields.io/npm/l/@kvokka/codex-mcp.svg)](https://github.com/kvokka/codex-mcp/blob/master/LICENSE)
[![node](https://img.shields.io/node/v/@kvokka/codex-mcp.svg)](https://nodejs.org)

MCP server that wraps [OpenAI Codex](https://github.com/openai/codex) — start coding agents, poll their progress, and manage permissions from any MCP client. Supports both `app-server` (full capability) and `exec` (fallback for codex variants without app-server) modes.

## Features

- **5 tools, full capability** — `codex_setup`, `codex`, `codex_reply`, `codex_session`, `codex_check`
- **Async non-blocking** — sessions run in background, poll for results
- **Complete permission management** — three-layer model: approval policy, sandbox isolation, async approval arbitration
- **Zero config** — inherits your local `~/.codex/config.toml` automatically
- **Session management** — list, inspect, cancel, interrupt, fork sessions
- **Status protocol** — `codex_check` reports the state of a session and what it waits for, never the turn's transcript
- **Activity heading** — `progress.activity` carries one line in Codex's own words saying what it is doing right now
- **Disk persistence** — session state, event logs, and results survive server restarts (`~/.codex-mcp/state/`)
- **Long-polling** — `codex_check` takes `waitMs` and returns when the status changes, an action arrives or the turn ends
- **Graceful shutdown** — stdin drain logic waits for active sessions before exiting
- **Orphan reaping** — leaked child processes from crashed runs are automatically cleaned up on startup
- **Static read-only resources** — `codex-mcp:///server-info`, `codex-mcp:///compat-report`, `codex-mcp:///config`, `codex-mcp:///gotchas`, `codex-mcp:///quickstart`, `codex-mcp:///errors`, `codex-mcp:///delegation-guide`

## Prerequisites

- [Node.js](https://nodejs.org) >= 18
- [OpenAI Codex CLI](https://github.com/openai/codex) installed and configured (`codex` or `codex-internal` in PATH)

## Relationship to the upstream project

`codex-mcp` is the work of @leo000001, published at <https://github.com/xihuai18/codex-mcp/>. The
design, the app-server protocol mapping and the exec fallback are theirs, and this fork is grateful
for all of it.

The fork exists because the published source and the published package drifted apart: the upstream
repository stands at 2.1.0, while releases through 2.1.7 went out on npm alone. Whoever read the
repository was reading a different server from the one they had installed.

This fork reconstructs 2.1.1 through 2.1.7 from the sourcemaps of the published packages, puts them
under test, and releases from the same tree it publishes. It is maintained as a long-lived fork for
one plain reason: the server has to work today, on the machines it is already installed on.

Before that, the ready-made routes were tried and each broke on a specific point: OpenAI's
`codex-plugin-cc` forwards no profile and hits Claude Code's 600,000 ms Bash ceiling,
`codex mcp-server` is deprecated in favour of the app server, and the live agent bridges accept one
attached session or push into the main context instead of the subagent.
[docs/WHY-THIS-FORK.md](docs/WHY-THIS-FORK.md) tells that story in full.

### What 2.2.0 changes on top of 2.1.7

- A server that cannot take the `STATE_DIR` lock runs from memory instead of recovering, pruning and
  reaping inside the state directory another server owns.
- The orphan reaper confirms process identity by start time on every platform, and leaves a process
  alone when no source answers.
- Session events reach `events.jsonl`, and a recovered session carries them back.
- `codex_setup`, the persistence primitives, the exec client, backend detection and the MCP tool
  surface are covered by tests; `codex-schema/` is checked against `protocol.ts` on every run.

## Quick Start

### npx (no install)

```bash
npx @kvokka/codex-mcp
```

### Global install

```bash
npm install -g @kvokka/codex-mcp
codex-mcp
```

### Windows shell wrapper (if needed)

```powershell
pwsh -NoProfile -Command "npx -y @kvokka/codex-mcp"
```

### MCP Client Configuration

Add to your MCP client config (e.g. Claude Desktop, Cursor, etc.):

```json
{
  "mcpServers": {
    "codex": {
      "command": "npx",
      "args": ["-y", "@kvokka/codex-mcp"]
    }
  }
}
```

### Claude Code

```bash
claude mcp add codex-mcp -- npx -y @kvokka/codex-mcp
```

Or add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "codex-mcp": {
      "command": "npx",
      "args": ["-y", "@kvokka/codex-mcp"]
    }
  }
}
```

## Codex Executable Configuration

By default, codex-mcp auto-detects the Codex CLI by searching PATH for `codex`, then `codex-internal`. You can override this with environment variables.

Resolution priority:

- `CODEX_MCP_PATH`
- `CODEX_MCP_COMMAND`
- auto-detect from PATH: `codex`, then `codex-internal`

| Variable            | Description                                            | Example                         |
| ------------------- | ------------------------------------------------------ | ------------------------------- |
| `CODEX_MCP_COMMAND` | Bare command name (resolved from PATH)                 | `codex-internal`                |
| `CODEX_MCP_PATH`    | Absolute or relative filesystem path to the executable | `/usr/local/bin/codex-internal` |

- `CODEX_MCP_PATH` and `CODEX_MCP_COMMAND` are mutually exclusive.
- When none are set, codex-mcp tries `codex` then `codex-internal` on PATH automatically.

Examples:

```bash
# Use codex-internal instead of codex
CODEX_MCP_COMMAND=codex-internal npx -y @kvokka/codex-mcp
```

```bash
# Use an explicit path
CODEX_MCP_PATH=/opt/codex/bin/codex npx -y @kvokka/codex-mcp
```

MCP client config with env override:

```json
{
  "mcpServers": {
    "codex": {
      "command": "npx",
      "args": ["-y", "@kvokka/codex-mcp"],
      "env": {
        "CODEX_MCP_COMMAND": "codex-internal"
      }
    }
  }
}
```

## STDIO Guard Modes

`codex-mcp` includes a startup preflight guard for stdout contamination risk.

- `CODEX_MCP_STDIO_MODE=auto` (default): run with warnings when risk is elevated
- `CODEX_MCP_STDIO_MODE=strict`: fail fast on blocking risks (e.g. TTY stdio), keep heuristic risks as warnings
- `CODEX_MCP_STDIO_MODE=off`: disable the preflight guard

## Exec Fallback Mode

When the codex binary does not support `app-server` (e.g. internal variants like `codex-internal`), codex-mcp automatically falls back to `codex exec --json` mode.

| Env Var             | Default     | Description                                                                            |
| ------------------- | ----------- | -------------------------------------------------------------------------------------- |
| `CODEX_MCP_COMMAND` | `codex`     | Command name used to select the Codex executable; lower priority than `CODEX_MCP_PATH` |
| `CODEX_MCP_MODE`    | auto-detect | Force `app-server` or `exec` mode (skip detection)                                     |

If you need an explicit path-based override, use `CODEX_MCP_PATH` from the executable configuration section above.

**Exec mode supports multi-turn context** via `codex exec resume`. First turn uses `codex exec`, subsequent turns use `codex exec resume <threadId>`.

**Exec mode limitations:**

- No approval/user-input interactions
- `threadFork`/`threadResume` throw `EXEC_NOT_SUPPORTED`
- `sandbox`/`profile`/`cwd`/`outputSchema` overrides only apply on the first turn (exec resume does not support these flags)

Check `codex-mcp:///server-info` `clientMode` field to detect which mode is active.

Examples:

```bash
CODEX_MCP_STDIO_MODE=strict npx -y @kvokka/codex-mcp
```

```powershell
$env:CODEX_MCP_STDIO_MODE = "strict"; npx -y @kvokka/codex-mcp
```

## Tools

### `codex_setup` — Check local readiness

Run a local readiness check before starting work. It verifies Codex executable resolution, login status, detected backend mode (`app-server` vs `exec`), and whether user/project `config.toml` files are visible from the target cwd.

### `codex` — Start a new session

Start a Codex agent session asynchronously. Returns immediately with `sessionId` and `threadId`.

| Parameter        | Type   | Required | Description                                                                                                                       |
| ---------------- | ------ | -------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `prompt`         | string | Yes      | Task or question for the Codex agent                                                                                              |
| `approvalPolicy` | string | Yes      | Approval policy: `untrusted`, `on-failure`, `on-request`, `never` — caller must set based on its own permission level             |
| `sandbox`        | string | Yes      | Sandbox mode: `read-only`, `workspace-write`, `danger-full-access` — caller must set based on its own permission level            |
| `effort`         | string | No       | Reasoning effort: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`. Default: `low`; increase/decrease based on task complexity |
| `cwd`            | string | No       | Working directory. Default: server cwd                                                                                            |
| `model`          | string | No       | Model override. Default: from `~/.codex/config.toml`                                                                              |
| `profile`        | string | No       | `config.toml` profile name (passed as `codex app-server -p`)                                                                      |
| `advanced`       | object | No       | Low-frequency options (see below)                                                                                                 |

<details>
<summary><code>advanced</code> object parameters (10 low-frequency parameters)</summary>

| Parameter                        | Type     | Description                                                                                                                                                                                                          |
| -------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `advanced.baseInstructions`      | string   | Replace default instructions (thread-level)                                                                                                                                                                          |
| `advanced.developerInstructions` | string   | Developer instructions (thread-level)                                                                                                                                                                                |
| `advanced.personality`           | string   | Personality: `none`, `friendly`, `pragmatic` (default: from `~/.codex/config.toml`)                                                                                                                                  |
| `advanced.summary`               | string   | Reasoning summary: `auto`, `concise`, `detailed`, `none` (default: from `~/.codex/config.toml`)                                                                                                                      |
| `advanced.config`                | object   | Override `config.toml` values (passed as `codex app-server -c key=value`)                                                                                                                                            |
| `advanced.ephemeral`             | boolean  | Don't persist thread. Default: `false`                                                                                                                                                                               |
| `advanced.outputSchema`          | object   | JSON Schema for structured output                                                                                                                                                                                    |
| `advanced.images`                | string[] | Local image paths (adds `localImage` inputs)                                                                                                                                                                         |
| `advanced.approvalTimeoutMs`     | number   | Auto-decline timeout (ms) for pending approvals. Default: `60000`                                                                                                                                                    |
| `advanced.waitForResult`         | number   | Wait up to this many ms for the session to complete and return the result directly. Max `300000` (5 min). Falls back to polling when the run does not finish in time or enters interactive approval/user-input flow. |

</details>

**Returns:** `{ sessionId, threadId, status, pollInterval?, progress?, execution?, interactionState?, recommendedNextAction? }`

```json
{
  "prompt": "Fix the failing tests in src/",
  "approvalPolicy": "on-request",
  "sandbox": "workspace-write",
  "effort": "high",
  "cwd": "/path/to/project",
  "model": "o4-mini"
}
```

Structured output example:

```json
{
  "prompt": "Return a short health summary",
  "approvalPolicy": "on-failure",
  "sandbox": "workspace-write",
  "advanced": {
    "outputSchema": {
      "type": "object",
      "properties": {
        "ok": { "type": "boolean" },
        "summary": { "type": "string" }
      },
      "required": ["ok", "summary"]
    }
  }
}
```

If the backend accepts the schema, the terminal `result` includes `structuredOutput`:

```json
{
  "result": {
    "text": "Health check complete.",
    "structuredOutput": {
      "ok": true,
      "summary": "Repository is healthy"
    }
  }
}
```

### Resources

If your MCP client supports resources, this server exposes a few **read-only** resources:

- `codex-mcp:///server-info` (JSON): static server metadata (version/platform/runtime)
- `codex-mcp:///compat-report` (JSON): capability summary for cross-backend adapter compatibility
- `codex-mcp:///config` (Markdown): config mapping guide, including how to use `codex.advanced.config`
- `codex-mcp:///gotchas` (Markdown): practical limits/gotchas
- `codex-mcp:///quickstart` (Markdown): minimal workflow examples
- `codex-mcp:///errors` (Markdown): error code catalog + recovery hints
- `codex-mcp:///delegation-guide` (Markdown): approval/sandbox presets per task type

### `codex_reply` — Continue a session

Send a follow-up message to an existing session.

| Parameter        | Type   | Required | Description                                                                                                                                                                                             |
| ---------------- | ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessionId`      | string | Yes      | Session ID from `codex`                                                                                                                                                                                 |
| `prompt`         | string | Yes      | Follow-up message                                                                                                                                                                                       |
| `model`          | string | No       | Override model for this turn                                                                                                                                                                            |
| `approvalPolicy` | string | No       | Override approval policy                                                                                                                                                                                |
| `effort`         | string | No       | Override reasoning effort (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`)                                                                                                                         |
| `summary`        | string | No       | Override reasoning summary (`auto`, `concise`, `detailed`, `none`)                                                                                                                                      |
| `personality`    | string | No       | Override personality (`none`, `friendly`, `pragmatic`)                                                                                                                                                  |
| `sandbox`        | string | No       | Override sandbox (`read-only`, `workspace-write`, `danger-full-access`)                                                                                                                                 |
| `cwd`            | string | No       | Override working directory                                                                                                                                                                              |
| `outputSchema`   | object | No       | JSON Schema for structured output                                                                                                                                                                       |
| `waitForResult`  | number | No       | Wait up to this many ms for the reply turn to complete and return the result directly. Max `300000` (5 min). Falls back to polling when the turn does not finish in time or needs interactive approval. |

**Returns:** `{ sessionId, threadId, status, pollInterval?, progress?, result?, completedAt?, execution?, interactionState?, recommendedNextAction? }`

Additional orchestration hints may be present in `codex`, `codex_reply`, and `codex_check` responses:

- `execution`: whether foreground waiting was requested/effective, and whether it fell back to background polling
- `interactionState`: `working`, `waiting_input`, or `finished`
- `recommendedNextAction`: `poll`, `respond_permission`, `respond_user_input`, or `none`
- `progress`: normalized phase metadata, pending-action count, last observed method, and token totals when the backend exposes them

```json
{
  "sessionId": "sess_abc123",
  "prompt": "Now add error handling for the edge cases"
}
```

### `codex_session` — Manage sessions

List, inspect, resume, cancel, interrupt, fork, batch-clean sessions, or clean background terminals.

| Parameter          | Type     | Required                                                        | Description                                                                                                     |
| ------------------ | -------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `action`           | string   | Yes                                                             | `"list"`, `"get"`, `"resume"`, `"cancel"`, `"interrupt"`, `"fork"`, `"clean"`, or `"clean_background_terminals"` |
| `sessionId`        | string   | For get/resume/cancel/interrupt/fork/clean_background_terminals | Target session ID                                                                                               |
| `includeSensitive` | boolean  | No                                                              | Include `cwd`/`profile`/`config`/`threadId` in `get`. Default: `false`                                          |
| `statuses`         | string[] | No                                                              | For `clean` only. Statuses to remove: `"idle"`, `"error"`, `"cancelled"`, `"abandoned"`. Default: the first three |
| `olderThanMs`      | number   | No                                                       | For `clean` only. Only match sessions older than this many ms                                        |
| `dryRun`           | boolean  | No                                                       | For `clean` only. Preview matches without deleting                                                   |
| `includeDisk`      | boolean  | No                                                       | For `clean` only. Default: `true`; also remove persisted session state                               |

**Returns:**

- `action="list"` → `{ sessions: PublicSessionInfo[] }` — every session of the state directory, this server's and every other server's
- `action="get"` → `PublicSessionInfo` (or `SensitiveSessionInfo` when `includeSensitive=true`)
- `action="resume"` → `{ sessionId, threadId, status: "idle", pollInterval, progress }`
- `action="cancel"|"interrupt"` → `{ success: true, message }`
- `action="fork"` → `{ sessionId, threadId, status: "idle", pollInterval }`
- `action="clean"` → `{ matchedSessionIds, removedSessionIds, removedCount, diskSessionsRemoved, dryRun }`
- `action="clean_background_terminals"` → `{ success: true, message }`

```json
{ "action": "list" }
{ "action": "get", "sessionId": "sess_abc123", "includeSensitive": true }
{ "action": "resume", "sessionId": "sess_abc123" }
{ "action": "cancel", "sessionId": "sess_abc123" }
{ "action": "interrupt", "sessionId": "sess_abc123" }
{ "action": "fork", "sessionId": "sess_abc123" }
{ "action": "clean", "statuses": ["cancelled"], "olderThanMs": 3600000 }
{ "action": "clean_background_terminals", "sessionId": "sess_abc123" }
```

### `codex_check` — Check status & respond

Report where a session stands, respond to approval requests, or answer user input.

The turn's own history — every reasoning step, command and message — stays in Codex's
rollout log under `~/.codex/sessions/**/rollout-*.jsonl`. `codex_check` does not repeat
it: the caller gets the state of the session and the things it must answer.

| Parameter                  | Type     | Required                          | Description                                                                                                                                                                                                                       |
| -------------------------- | -------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `action`                   | string   | Yes                               | `"poll"`, `"respond_permission"`, or `"respond_user_input"`                                                                                                                                                                       |
| `sessionId`                | string   | Yes                               | Target session ID                                                                                                                                                                                                                 |
| `waitMs`                   | number   | No                                | `action="poll"` only. Long-poll budget in ms, capped at `120000`. The call returns when the status changes, an action arrives or the turn ends. Omit or `0` to answer at once.                                                     |
| `requestId`                | string   | For respond_permission/user_input | Request ID from `actions[]`                                                                                                                                                                                                       |
| `decision`                 | string   | For respond_permission            | For command approvals: `"accept"`, `"acceptForSession"`, `"acceptWithExecpolicyAmendment"`, `"applyNetworkPolicyAmendment"`, `"decline"`, `"cancel"`; for file changes: `"accept"`, `"acceptForSession"`, `"decline"`, `"cancel"` |
| `execpolicy_amendment`     | string[] | For acceptWithExecpolicyAmendment | Exec policy amendment list (required when `decision="acceptWithExecpolicyAmendment"`)                                                                                                                                             |
| `network_policy_amendment` | object   | For applyNetworkPolicyAmendment   | Network policy amendment object `{ action: "allow"                                                                                                                                                                                | "deny", host: string }`(required when`decision="applyNetworkPolicyAmendment"`) |
| `denyMessage`              | string   | No                                | Internal note on deny (not sent to app-server)                                                                                                                                                                                    |
| `answers`                  | object   | For respond_user_input            | For `respond_user_input`: `question-id -> { answers: string[] }`                                                                                                                                                                  |

**Returns (poll and respond\_\*):** `{ sessionId, status, pollInterval?, progress, interactionState, recommendedNextAction, actions, result? }`

```json
{ "action": "poll", "sessionId": "sess_abc123", "waitMs": 120000 }
{
  "action": "respond_permission",
  "sessionId": "sess_abc123",
  "requestId": "req_xyz",
  "decision": "accept"
}
{
  "action": "respond_user_input",
  "sessionId": "sess_abc123",
  "requestId": "req_abc",
  "answers": { "question_id": { "answers": ["choice_1"] } }
}
```

## What A Check Reports

`codex_check` answers every action with one payload:

- `status`: `running`, `waiting_approval`, `idle`, `error` or `cancelled`.
- `progress`: the phase (`starting`, `reasoning`, `acting`, `waiting_approval`, `finished`, `error`, `cancelled`), the number of open actions, the time of the last event, the active turn id, the token counters the backend reported, and `activity`.
- `progress.activity`: one line in Codex's own words saying what it is doing right now — `"Разбираю падение теста в session-manager"`. See [Activity Marker](#activity-marker).
- `actions[]`: what the caller must answer — approval requests and questions. Answer each by its `requestId`.
- `result`: the finished turn's answer, carried by the first check that sees a terminal status. Later checks of the same turn report the status alone.
- `interactionState` and `recommendedNextAction`: `poll`, `respond_permission`, `respond_user_input`, or `none` when the turn is over.
- `pollInterval`: minimum delay before the next check — `>=120000` ms while `running`, `~1000` ms while `waiting_approval`, absent in a terminal state.

Nothing else reaches the caller. Reasoning, command output, agent-message deltas and
token-counter updates are written to the session's `events.jsonl` under the state
directory, and the full history of the turn is in Codex's own rollout log; sending either
through an MCP client's context would put the whole run through the model a second time.

`waitMs` long-polls: the call blocks until the status changes, a new action arrives, or
the turn ends. Deltas, token-counter updates and a new activity line do not end the wait.
It is capped at `120000` ms, and a session accepts 4 concurrent long polls — the fifth
returns at once.

## Activity Marker

Between two approval requests a turn can run for minutes with nothing but a phase and a
token counter to show for it. The activity marker says what the work is, at the cost of
one string per session.

The server puts a standing developer instruction on every thread it starts
(`thread/start` → `developerInstructions`), asking Codex to write one line of the form

```text
%%%ACTIVITY: Разбираю падение теста в session-manager%%%
```

whenever it starts something new, in the language of the request. The server reads those
lines out of the `item/agentMessage/delta` stream, keeps the last one in
`progress.activity`, and cuts every marker out of `result.text`, so the caller reads
Codex's answer and nothing the server put there for itself.

- **It is a heading, not a percentage.** How much of the task is done is unknown to the
  agent and is not reported. The line is overwritten, never accumulated: ten sessions cost
  ten strings.
- **The stream cuts it.** Deltas are model tokens — a measured run had a median of three
  characters, and a live run delivered the closing `%%%` as `"%%"` then `"%\n"` — so the
  server scans the concatenation across deltas, not one delta.
- **A `%%%` run alone never matches.** The `ACTIVITY:` tag is required, which is what keeps
  `printf '%%%d'` in quoted output from registering. A whole marker Codex quotes back from
  a file does register; the cost is one wrong heading, overwritten by the next real one.
- **Bounded.** The line is cut to 120 characters, an opener with no closing sentinel on its
  line is given up as ordinary text, and `progress.activity` is empty until the turn's
  first marker.
- `advanced.developerInstructions` is appended after this instruction rather than replacing
  it. `CODEX_MCP_DISABLE_ACTIVITY_MARKER=1` stops the server from sending it.
- **Exec fallback has no activity line.** `codex exec` takes no developer instructions, so
  a session in exec mode gets no markers to extract.

Every extracted line is also written to the session's `events.jsonl` as a record of type
`activity`, so a reader of the state directory gets the sequence of what the session was
doing without reading the raw stream around it.

When a turn completes, `result.text` provides a stable final assistant message: `turn.output` when the backend sent one, else the last completed `agentMessage` item. Only `codex exec` sends `turn.output`, which `result.output` carries as sent; the app-server turn has no such field, so app-server sessions answer from the agent message.

## Approvals & User Input

When the agent requests approval or user input, `poll` includes an `actions[]` list. Respond with:

- `respond_permission`: `decision` is one of `accept`, `acceptForSession`, `decline`, `cancel`.
  - For command approvals, `acceptWithExecpolicyAmendment` is supported and requires `execpolicy_amendment`.
  - For command approvals, `applyNetworkPolicyAmendment` is supported and requires `network_policy_amendment`.
- `respond_user_input`: send `answers` keyed by the question `id`.
- For command approvals, `actions[]` may include `commandActions` and `proposedExecpolicyAmendment` for richer review UI.

Pending approvals auto-decline after `advanced.approvalTimeoutMs`.

Auth callback note: if app-server sends `account/chatgptAuthTokens/refresh`, codex-mcp returns JSON-RPC error `-32000` because external ChatGPT token refresh is out of scope for this server.

## Session Lifecycle & Cleanup

Sessions auto-clean up in the background, checked once a minute:

- `idle` > 30 minutes → cancelled
- `running`/`waiting_approval` > 4 hours → cancelled
- `cancelled`/`error` > 5 minutes → removed from memory and from disk

60 seconds before a session hits its TTL, `codex_check` emits one `progress` event with `data.method="codex-mcp/ttl_warning"` and `ttlRemainingMs`. Any tool call on the session refreshes `lastActiveAt` and postpones the cleanup.

`codex_session(action="clean")` removes matching terminal sessions on demand: filter with `statuses` and `olderThanMs`, preview with `dryRun`, and keep the persisted state with `includeDisk=false`.

### Sessions whose server went away

A session belongs to one codex-mcp process, which records itself in the session's own
directory as `owner.json`. Two clients can run two servers over one state directory:
each writes its own sessions, neither touches the other's, and both list all of them.

When a server dies or its client disconnects, the sessions it was driving are left with
no owner. A turn that was running at that moment comes back as `status: "abandoned"` —
the work was cut off, nothing failed, and the thread can be picked up. Every entry of
`action="list"` carries:

- `activity` — the last line Codex said it was working on, so the list reads
  "abandoned — Counting the TypeScript files in src" rather than an id and a status;
- `owner` — `{ pid, state: "self" | "other" }` for a session a running server holds,
  and nothing at all for a session that is free.

`codex_session(action="resume", sessionId)` starts a codex process for a free session
and restores its thread from Codex's rollout log, including the turn it was interrupted
in; the session becomes `idle` and `codex_reply` carries it on. A session another running
server holds is refused with `SESSION_HELD_BY_OTHER_SERVER`.

Looking for interrupted work, from a fresh session:

```json
{ "action": "list" }
```

Pick the entry with no `owner` and read its `activity` and `lastActiveAt`, then:

```json
{ "action": "resume", "sessionId": "sess_abc123" }
```

and reply to it as to any idle session.

Where a resume cannot happen:

- In `exec` mode — a codex binary without `app-server` — `resume` fails with
  `THREAD_FORK_RESUME_FAILED` carrying `EXEC_NOT_SUPPORTED`, because `codex exec`
  implements no thread resume. The session keeps its `abandoned` status; hand the
  work to a new session.
- A session whose owner could not be checked — the pid answered neither a
  liveness probe nor a start-time read — counts as held, and `resume` refuses it
  with `SESSION_HELD_BY_OTHER_SERVER`. No flag overrides that. Where you know the
  process is gone, delete `owner.json` from the session's directory under the
  state directory; that is the only way out.

## Error Model

Tools return errors as:

```json
{ "content": [{ "type": "text", "text": "Error [CODE]: message" }], "isError": true }
```

Common codes include `INVALID_ARGUMENT`, `SESSION_NOT_FOUND`, `SESSION_BUSY`, `SESSION_NOT_RUNNING`, `REQUEST_NOT_FOUND`, `CANCELLED`, `INTERNAL`.

## Client compatibility notes

- Tool responses follow `@modelcontextprotocol/sdk`'s `CallToolResult` contract: `content` (JSON text for wide compatibility), optional `structuredContent` (the canonical object), and `isError`. `structuredContent` is always object-shaped; when a tool returns a scalar/array, codex-mcp wraps it as `{ "value": ... }`. Claude Desktop and other clients tend to surface the `content` text directly, which shows the raw JSON blob, so they should fall back to `structuredContent` when they want typed data (Cursor already does this automatically whenever structured output is available).
- When an operation fails we set `isError: true` and return `Error [CODE]: message` in the `content` array instead of raising an MCP transport error. This keeps the STDIO channel healthy so Claude, Cursor, and other MCP clients stay connected even when a tool reports a problem.
- `codex-mcp` uses the MCP stdio transport (`src/index.ts`), so stdout is reserved for newline-delimited JSON and all diagnostics go to stderr. Anything else on stdout—including shell/profile banners (e.g., PowerShell's oh-my-posh warning) or CLI wrappers that print prompts—will break the MCP handshake for Claude/Cursor. Run `pwsh -NoProfile`, disable profile banners, or wrap the command so stdout stays quiet before piping it into the client.
- Windows command execution inside `codex app-server` may still inherit PowerShell profile side effects in some environments. This cannot be filtered by codex-mcp once emitted on stdout; if command turns are noisy or fail with profile errors, clean your PowerShell profile and prefer `approvalPolicy="on-failure"` / `"never"` to reduce approval churn.
- If Windows command output shows mojibake, enforce UTF-8 in the shell (`chcp 65001` and `$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()`).
- Startup guard behavior is controlled by `CODEX_MCP_STDIO_MODE` (`auto`/`strict`/`off`). Use `strict` in CI or hardened environments to fail fast on blocking contamination risks (while still surfacing heuristic risk warnings).
- A retryable transport/API interruption keeps the session `running`; only a failure the backend will not retry moves it to `error`, where `result.error` says what happened.
- Approval/user-input flows rely on the `actions[]` array returned by `codex_check`. Claude and Cursor render approval buttons from this payload, so they need to check at `pollInterval` (or pass `waitMs`) and reply within `approvalTimeoutMs` to avoid automatic declines.

## Typical Workflow

```text
1. codex(prompt="Fix bug X")                          → { sessionId, threadId, status: "running" }
2. codex_check(action="poll", waitMs=120000)          → status, progress, actions[]
3. codex_check(action="respond_permission", decision="accept")  (for each action)
4. codex_check(action="poll", waitMs=120000)          → result when status="idle"
5. codex_reply(prompt="Also add tests")               → new turn starts
6. codex_check(action="poll", waitMs=120000)          → check until done
```

## Permission Model

Three layers of protection:

| Layer | Mechanism       | Options                                                    |
| ----- | --------------- | ---------------------------------------------------------- |
| 0     | Approval Policy | `never`, `on-failure`, `on-request`, `untrusted`           |
| 1     | Sandbox         | `read-only`, `workspace-write`, `danger-full-access`       |
| 2     | Async Approval  | Command execution + file change approval via `codex_check` |

## Architecture

> **Same-platform assumption**: codex-mcp assumes the MCP client and server run on the same machine. All communication uses stdio (local IPC), child processes share the local filesystem and `~/.codex/config.toml`, and `cwd` paths refer to the local filesystem.

```text
MCP Client ←stdio→ codex-mcp server ←stdio→ codex app-server ←→ Codex Agent   (app-server mode)
MCP Client ←stdio→ codex-mcp server ←stdio→ codex exec --json ←→ Codex Agent  (exec fallback)
         (same machine, stdio transport)
```

Each session spawns an independent child process. In app-server mode, it uses the JSON-RPC protocol over stdio. In exec fallback mode, it uses `codex exec --json` JSONL output with `codex exec resume` for multi-turn context.

Session metadata, child-process identity, and turn results are persisted to disk (`~/.codex-mcp/state/` by default), one directory per session, written atomically. Ownership is per session: `owner.json` in each directory names the codex-mcp process driving it, so several servers share one state directory. On startup a server takes over the sessions whose owner is gone, leaves the rest alone, prunes by age (7 days), count (200), and total size (500 MB), and reaps the orphaned child processes of the sessions it took over after verifying each PID's recorded spawn time.

### Environment Variables

| Variable                         | Description                                      | Default              |
| -------------------------------- | ------------------------------------------------ | -------------------- |
| `CODEX_MCP_STATE_DIR`            | Directory for persistent session state           | `~/.codex-mcp/state` |
| `CODEX_MCP_PATH`                 | Explicit filesystem path to the codex binary     | _(unset)_            |
| `CODEX_MCP_COMMAND`              | Command name to resolve from PATH                | _(unset)_            |
| `CODEX_MCP_MODE`                 | Force `app-server` or `exec` backend mode        | auto-detect          |
| `CODEX_MCP_STDIO_MODE`           | STDIO preflight guard: `auto`/`strict`/`off`     | `auto`               |
| `CODEX_MCP_DISABLE_NOISE_FILTER` | Set to `1` to disable PowerShell noise filtering | `0`                  |
| `CODEX_MCP_DISABLE_ACTIVITY_MARKER` | Set to `1` to start threads without the activity-marker instruction | `0` |

## Development

```bash
git clone https://github.com/kvokka/codex-mcp.git
cd codex-mcp
npm install
npm run build
npm run typecheck
npm test
npm run check:stdio
npm run check:stdio:strict
```

End-to-end local test plan (after installing/configuring in an MCP client):

- Full guide (LLM operator handbook): `docs/E2E_LOCAL_TEST_PLAN.md`
- Quick English checklist: run `codex` → poll with `codex_check(action="poll")` → respond via `respond_permission`/`respond_user_input` if `actions[]` appears → continue polling until `status` is `idle`/`error`/`cancelled`.

## Project Policies

- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)

## License

[MIT](LICENSE)
