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
- **Event streaming** — cursor-based pagination with pin-protected event buffer
- **Disk persistence** — session state, event logs, and results survive server restarts (`~/.codex-mcp/state/`)
- **Long-polling** — `codex_check` supports `pollOptions.waitMs` to wait for new events instead of busy-polling
- **Graceful shutdown** — stdin drain logic waits for active sessions before exiting
- **Orphan reaping** — leaked child processes from crashed runs are automatically cleaned up on startup
- **Static read-only resources** — `codex-mcp:///server-info`, `codex-mcp:///compat-report`, `codex-mcp:///config`, `codex-mcp:///gotchas`, `codex-mcp:///quickstart`, `codex-mcp:///errors`, `codex-mcp:///delegation-guide`

## Prerequisites

- [Node.js](https://nodejs.org) >= 18
- [OpenAI Codex CLI](https://github.com/openai/codex) installed and configured (`codex` or `codex-internal` in PATH)

## Thanks

The project was originally made by @leo000001 and forked from <https://github.com/xihuai18/codex-mcp/>
Happy to share my gratitude for his brilliant work

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

List, inspect, cancel, interrupt, fork, batch-clean sessions, or clean background terminals.

| Parameter          | Type     | Required                                                 | Description                                                                                          |
| ------------------ | -------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `action`           | string   | Yes                                                      | `"list"`, `"get"`, `"cancel"`, `"interrupt"`, `"fork"`, `"clean"`, or `"clean_background_terminals"` |
| `sessionId`        | string   | For get/cancel/interrupt/fork/clean_background_terminals | Target session ID                                                                                    |
| `includeSensitive` | boolean  | No                                                       | Include `cwd`/`profile`/`config`/`threadId` in `get`. Default: `false`                               |
| `statuses`         | string[] | No                                                       | For `clean` only. Terminal statuses to remove: `"idle"`, `"error"`, `"cancelled"`                    |
| `olderThanMs`      | number   | No                                                       | For `clean` only. Only match sessions older than this many ms                                        |
| `dryRun`           | boolean  | No                                                       | For `clean` only. Preview matches without deleting                                                   |
| `includeDisk`      | boolean  | No                                                       | For `clean` only. Default: `true`; also remove persisted session state                               |

**Returns:**

- `action="list"` → `{ sessions: PublicSessionInfo[] }`
- `action="get"` → `PublicSessionInfo` (or `SensitiveSessionInfo` when `includeSensitive=true`)
- `action="cancel"|"interrupt"` → `{ success: true, message }`
- `action="fork"` → `{ sessionId, threadId, status: "idle", pollInterval }`
- `action="clean"` → `{ matchedSessionIds, removedSessionIds, removedCount, diskSessionsRemoved, dryRun }`
- `action="clean_background_terminals"` → `{ success: true, message }`

```json
{ "action": "list" }
{ "action": "get", "sessionId": "sess_abc123", "includeSensitive": true }
{ "action": "cancel", "sessionId": "sess_abc123" }
{ "action": "interrupt", "sessionId": "sess_abc123" }
{ "action": "fork", "sessionId": "sess_abc123" }
{ "action": "clean", "statuses": ["cancelled"], "olderThanMs": 3600000 }
{ "action": "clean_background_terminals", "sessionId": "sess_abc123" }
```

### `codex_check` — Poll events & respond

Query a running session for events, respond to approval requests, or answer user input.

| Parameter                  | Type     | Required                          | Description                                                                                                                                                                                                                       |
| -------------------------- | -------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `action`                   | string   | Yes                               | `"poll"`, `"respond_permission"`, or `"respond_user_input"`                                                                                                                                                                       |
| `sessionId`                | string   | Yes                               | Target session ID                                                                                                                                                                                                                 |
| `cursor`                   | number   | No                                | Event cursor for incremental polling (`action="poll"`). For `respond_*`, codex-mcp applies monotonic cursor progression: `max(cursor, sessionLastCursor)`.                                                                        |
| `maxEvents`                | number   | No                                | Keep this small. `poll` default: `1` (minimum `1`; increase only for catch-up). `respond_*` default: `0` (recommended; compact ACK, no event replay).                                                                             |
| `responseMode`             | string   | No                                | Response shaping mode: `minimal` (default), `delta_compact`, `full`                                                                                                                                                               |
| `pollOptions`              | object   | No                                | Optional controls: `includeEvents` (default `true`), `includeActions` (default `true`), `includeResult` (default `true`), `skipDeltas`, `finalOnly`, `maxBytes` (default unlimited), `waitMs` (long-poll budget, capped at `120000`) |
| `requestId`                | string   | For respond_permission/user_input | Request ID from `actions[]`                                                                                                                                                                                                       |
| `decision`                 | string   | For respond_permission            | For command approvals: `"accept"`, `"acceptForSession"`, `"acceptWithExecpolicyAmendment"`, `"applyNetworkPolicyAmendment"`, `"decline"`, `"cancel"`; for file changes: `"accept"`, `"acceptForSession"`, `"decline"`, `"cancel"` |
| `execpolicy_amendment`     | string[] | For acceptWithExecpolicyAmendment | Exec policy amendment list (required when `decision="acceptWithExecpolicyAmendment"`)                                                                                                                                             |
| `network_policy_amendment` | object   | For applyNetworkPolicyAmendment   | Network policy amendment object `{ action: "allow"                                                                                                                                                                                | "deny", host: string }`(required when`decision="applyNetworkPolicyAmendment"`) |
| `denyMessage`              | string   | No                                | Internal note on deny (not sent to app-server)                                                                                                                                                                                    |
| `answers`                  | object   | For respond_user_input            | For `respond_user_input`: `question-id -> { answers: string[] }`                                                                                                                                                                  |

**Returns (poll and respond\_\*):** `{ sessionId, status, pollInterval?, progress?, interactionState?, recommendedNextAction?, cursorResetTo?, events, nextCursor, actions?, result? }`

```json
{ "action": "poll", "sessionId": "sess_abc123", "cursor": 0 }
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

## Event Polling Semantics

`codex_check(action="poll")` returns an append-only event stream with cursor pagination:

- `cursor`: the first event id you want (use the previous `nextCursor`)
- `nextCursor`: pass this back on the next poll
- `cursorResetTo`: when present, older events were evicted; restart from this cursor to avoid gaps
- `maxEvents`: max events returned per call
- If `cursor` is omitted, codex-mcp continues from that session's last consumed cursor.
- If `responseMode` is omitted, codex-mcp uses `minimal`.
- `pollOptions.includeEvents/includeActions/includeResult` default to `true`.
- `pollOptions.skipDeltas=true` drops streaming delta events but still advances the cursor past them.
- `pollOptions.finalOnly=true` omits `events[]`, focuses on `actions[]` plus terminal `result`, and advances the cursor past hidden events.
- `pollOptions.maxBytes` is optional and enforces best-effort payload truncation (`truncated`, `truncatedFields`).
- `pollOptions.waitMs` long-polls: the call blocks until an event, an action, or a result appears, or the budget runs out. It is capped at `120000` ms, and a session accepts 4 concurrent long polls — the fifth returns immediately.
- `progress.phase` gives a coarse execution snapshot (`starting`, `reasoning`, `acting`, `waiting_approval`, `finished`, etc.).
- `progress.tokens` is populated when the backend exposes token counts.
- `respond_*` defaults to compact ACK (`events: []`, no cursor advance) unless you explicitly pass `maxEvents`.
- `poll` defaults to `maxEvents=1` to keep payloads small; increase temporarily (for example `10-20`) when you need to catch up faster.
- If `poll` is called with `maxEvents=0`, codex-mcp treats it as `1` to avoid no-op polling loops.
- For `respond_*`, prefer `maxEvents=0` instead of `1`: `0` keeps approval ACK minimal and avoids consuming/replaying stream events in the same call. Use `1-5` only when you explicitly need immediate events.
- For `poll`, keep windows small to reduce payload spikes and context pressure.

Event types include `output`, `progress`, `approval_request`, `approval_result`, `result`, `error`.
Approvals/results/errors are pinned to reduce eviction risk.
When a turn completes, `result.text` provides a stable final assistant message. It falls back to the last completed `agentMessage` item when the backend omits `turn.output`. `result.output` remains the raw backend `turn.output` value when present.

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

After a server restart, sessions that were `running` or `waiting_approval` come back as `status: "error"` with a `cancelledReason` naming the restart, and their last result stays readable.

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
- Retryable transport/API interruptions are emitted as `progress` events with `data.method="codex-mcp/reconnect"` and `willRetry=true`, so clients can surface reconnect state without treating it as terminal failure.
- Approval/user-input flows rely on the `actions[]` array returned by `codex_check(action="poll")`. Claude and Cursor render approval buttons from this payload, so they need to poll at `pollInterval`, honour `cursorResetTo`, and reply within `approvalTimeoutMs` to avoid automatic declines.

## Typical Workflow

```text
1. codex(prompt="Fix bug X")           → { sessionId, threadId, status: "running" }
2. codex_check(action="poll", ...)      → events[], status, actions[]
3. codex_check(action="respond_permission", decision="accept")  (if needed)
4. codex_check(action="poll", ...)      → result when status="idle"
5. codex_reply(prompt="Also add tests") → new turn starts
6. codex_check(action="poll", ...)      → poll until done
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

Session metadata, child-process identity, and turn results are persisted to disk (`~/.codex-mcp/state/` by default), one directory per session, written atomically. A PID lockfile at the state directory root keeps a single writer. On startup the server recovers persisted sessions, prunes them by age (7 days), count (200), and total size (500 MB), and reaps orphaned child processes left by the previous run after verifying each PID's recorded spawn time.

### Environment Variables

| Variable                         | Description                                      | Default              |
| -------------------------------- | ------------------------------------------------ | -------------------- |
| `CODEX_MCP_STATE_DIR`            | Directory for persistent session state           | `~/.codex-mcp/state` |
| `CODEX_MCP_PATH`                 | Explicit filesystem path to the codex binary     | _(unset)_            |
| `CODEX_MCP_COMMAND`              | Command name to resolve from PATH                | _(unset)_            |
| `CODEX_MCP_MODE`                 | Force `app-server` or `exec` backend mode        | auto-detect          |
| `CODEX_MCP_STDIO_MODE`           | STDIO preflight guard: `auto`/`strict`/`off`     | `auto`               |
| `CODEX_MCP_DISABLE_NOISE_FILTER` | Set to `1` to disable PowerShell noise filtering | `0`                  |

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
