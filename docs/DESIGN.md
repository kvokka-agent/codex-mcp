# codex-mcp Design

`codex-mcp` is an MCP stdio server that exposes the Codex `app-server` JSON-RPC protocol through 5 tools (`codex`, `codex_reply`, `codex_setup`, `codex_session`, `codex_check`) and 7 read-only resources. Each session runs in its own `codex` child process; MCP clients drive it by polling a cursor-paginated event stream.

## Document Boundary (AGENTS vs DESIGN)

- `AGENTS.md` holds the execution handbook: change checklists and implementation guardrails.
- `docs/DESIGN.md` holds architecture and protocol truth, upgrade methodology, and field-level semantics.
- Each rule has one full definition. `AGENTS.md` keeps the summary and the entry point; this file keeps the rule.

## Dependency And SDK Upgrade Handbook (Single Source Of Truth)

This chapter is the authoritative procedure for dependency upgrades and interface alignment. The `AGENTS.md` upgrade checklist links back here.

### 1. Source-Of-Truth Priority

1. The `codex app-server` protocol definition plus `codex-schema/` (including `codex-schema/metadata.json`)
2. The repository implementation (`src/server.ts`, `src/tools/*`, `SessionManager`, `protocol.ts`, `types.ts`)
3. The public documents (`README.md`, `AGENTS.md`, `CHANGELOG.md`, `docs/E2E_LOCAL_TEST_PLAN.md`)

Constraints:

- `CHANGELOG` helps locate a change; it never substitutes for a protocol comparison.
- On conflict the upstream protocol and the vendored schema win, and code and documents follow them.

### 2. Upgrade Triggers

Any one of these enters this procedure:

- The `codex` CLI / `codex app-server` changes protocol, events, fields, or behavior
- `@modelcontextprotocol/sdk` changes the MCP tool contract or transport behavior
- `zod` changes schema or type-inference behavior
- Node.js or TypeScript constraints change in a way that affects tool interfaces, types, or the error model

### 3. Dependency Matrix

| Dependency / interface      | Truth source                      | Main impact                                                        | Change artifacts                                                                    |
| --------------------------- | --------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `codex app-server` protocol | `codex-schema/` + `metadata.json` | JSON-RPC methods, params/result, server-initiated requests, events | `src/app-server/protocol.ts`, `src/session/manager.ts`, `src/server.ts`, tests, docs |
| `@modelcontextprotocol/sdk` | Official SDK behavior             | Tool registration, `CallToolResult` shape, stdio interaction       | `src/server.ts`, `src/index.ts`, tests, README/docs                                  |
| `zod`                       | Zod API and inference semantics   | Tool input validation, output schemas, error messages              | `src/server.ts`, tests                                                               |
| Node / TS runtime           | `package.json` engines + tsconfig | Build and type system, boundary behavior                           | build/typecheck scripts, implementation and docs when behavior changes               |

### 4. Standard Upgrade Procedure

1. **Pull the truth and set a comparison baseline.**
   - Record the current repository version and dependency versions, including `codex-schema/metadata.json`.
   - State the target version and the scope of this upgrade.
2. **Refresh the schema baseline** when the app-server protocol is involved.
   - Regenerate and commit: `codex app-server generate-json-schema --experimental --out codex-schema`
   - Confirm `codex-schema/metadata.json` reflects the new baseline.
3. **Classify the diff (decision gate).**
   - Sort each change into: field added / field renamed / field removed / semantics changed / event behavior changed.
   - Mark whether it is a breaking change and whether it touches public MCP parameters.
4. **Align the implementation.**
   - Tool schemas: `src/server.ts`
   - Tool handlers: `src/tools/*`
   - Session state machine and approval flow: `src/session/manager.ts`
   - Protocol types: `src/app-server/protocol.ts`
   - Constants and shared types: `src/types.ts`
5. **Check naming consistency.**
   - Public MCP parameter names match upstream field names exactly.
   - `snake_case` stays `snake_case`; `camelCase` stays `camelCase`.
6. **Rule on compatibility.**
   - Keep no old aliases by default.
   - A compatibility layer that must stay records its scope, its removal version, its removal date, and its test coverage.
   - Compatibility runs through the whitelist below; anything outside the whitelist is deleted.

### 5. Compatibility Whitelist (Strict)

The project keeps only necessary compatibility.

- Necessary compatibility (the whole whitelist):
  - Response-id parsing for `thread/start` / `thread/fork` / `thread/resume` / `turn/start` accepts both `v1 {threadId|turnId}` and `v2 {thread:{id}|turn:{id}}`. Real runs still return mixed shapes; the parsing changes no public MCP field and only stabilizes internal id extraction.
- Forbidden compatibility:
  - `snake_case` field aliases `approval_id` and `network_approval_context`
  - The user-input question-id alias `questionId`; the schema field `id` is the only accepted name.

The whitelist constrains alias and compatibility layers only. Deprecated methods that still exist in `codex-schema` — `applyPatchApproval`, `execCommandApproval` — count as protocol coverage, not as aliases.

### 6. Diff Classification And Handling

- **Field added (non-breaking):** pass it through, complete the types, document its default and optionality, add a minimal regression test.
- **Field renamed (usually breaking):** switch to the new name, write no dual-write compatibility, and record a migration window and a removal plan if compatibility is unavoidable.
- **Field removed (breaking):** delete the implementation entry point and the documentation, state the error code or degraded behavior, add a test for misuse of the old parameter.
- **Semantics changed (breaking behavior):** update the state machine, error model, and polling semantics together, and state the new semantics in README and DESIGN.

### 7. Change Closure Checklist (Check On Every PR)

An interface field change confirms every item:

- `src/server.ts` (tool schema and output schema)
- `src/tools/codex.ts`
- `src/tools/codex-reply.ts`
- `src/tools/codex-session.ts`
- `src/tools/codex-check.ts`
- `src/tools/codex-setup.ts`
- `src/session/manager.ts`
- `src/app-server/protocol.ts`
- `src/types.ts`
- `README.md`
- `docs/DESIGN.md`
- `AGENTS.md`
- `CHANGELOG.md`
- `docs/E2E_LOCAL_TEST_PLAN.md`
- The matching `tests/*.test.ts`

### 8. Review Approach

- Explore the key paths in parallel first: schema, handlers, manager, docs.
- Cross-verify once independently before merging.
- Review priority: behavior regression > field consistency > documentation sync.

### 9. Single-Pass Update Template

```bash
codex --version
codex app-server generate-json-schema --experimental --out codex-schema
git diff --name-only -- codex-schema
git diff -- codex-schema/metadata.json
```

Decision rule:

- `git diff --name-only -- codex-schema` is empty: the schema baseline is unchanged; record "update executed, no diff".
- There are diffs: run section 4 in full and close the code, test, and documentation loop before merging.

### 10. Latest Run Record

- Run date: `2026-02-27` (local environment)
- `codex` version: `codex-cli 0.106.0`
- Command: `codex app-server generate-json-schema --experimental --out codex-schema`
- Result: no file diffs under `codex-schema`, no change to `codex-schema/metadata.json`
- Conclusion: the vendored schema baseline matches what the local CLI generates

Each single-pass update overwrites this section so the latest run stays auditable.

## System Architecture

> **Same-machine assumption:** the MCP client and the codex-mcp server run on one machine. All transport is stdio (local IPC), child processes share the local filesystem and `~/.codex/config.toml`, and `cwd` paths are local paths.

```text
MCP Client (Claude/Kiro/etc.)
    │
    │ MCP Protocol (stdio, same machine)
    ▼
codex-mcp server (Node.js)
    │
    │ JSON-RPC (stdio, per-session subprocess)
    ▼
codex app-server (Rust binary)      ── or ──  codex exec --json (fallback)
    │
    │ OpenAI Responses API
    ▼
Codex Agent (cloud)
```

### Why app-server Rather Than The TypeScript SDK

| Dimension            | TypeScript SDK (@openai/codex-sdk) | app-server protocol                                                       |
| -------------------- | ---------------------------------- | -------------------------------------------------------------------------- |
| Approvals            | No per-item approval callback      | Full: command approvals (6 decisions) + file-change approvals (4 decisions) |
| Event stream         | Limited event types                | Rich: AgentMessageDelta, ReasoningDelta, CommandOutputDelta, and more       |
| Thread management    | start/resume                       | start/resume/fork/archive/list/read/compact/rollback                        |
| Turn management      | None                               | start/interrupt/steer                                                       |
| Configuration        | Parse config.toml yourself         | Native config.toml plus read/write API                                      |
| Protocol stability   | High-level wrapper, API may change | The low-level protocol the VSCode extension uses, with a full JSON Schema   |

### Codex Executable Resolution

`src/utils/codex-executable.ts` resolves the executable once at startup and caches the result:

1. `CODEX_MCP_PATH` — a filesystem path. The server resolves it to an absolute path and throws when the file is missing or not executable.
2. `CODEX_MCP_COMMAND` — a bare command name looked up on `PATH` (with `PATHEXT` handling on Windows). The server throws when the value looks like a path or is not found.
3. Auto-detection — `codex`, then `codex-internal`, resolved from `PATH` to an absolute path.
4. The bare string `codex`, which lets the later `spawn` produce a clear "not found" error.

`CODEX_MCP_PATH` and `CODEX_MCP_COMMAND` are mutually exclusive; setting both throws at startup. `src/index.ts` calls `checkDefaultCodexExecutableAvailability()` before creating the server, so a misconfiguration fails immediately and prints the resolved path to stderr.

### Backend Mode Detection

`src/app-server/detect.ts` probes `<binary> app-server --help` with a 5-second timeout and picks `app-server` on success, `exec` otherwise. `CODEX_MCP_MODE=app-server|exec` skips the probe. In `exec` mode `src/app-server/exec-client.ts` drives `codex exec --json` and `codex exec resume <threadId>`; it rejects `threadFork` and `threadResume` with `EXEC_NOT_SUPPORTED` and surfaces no approval or user-input requests. Clients read the active mode from `codex-mcp:///server-info` (`clientMode`).

## Tool Design

### Tool 1: `codex` — Start A New Session

Starts asynchronously and returns `{ sessionId, threadId, status: "running", pollInterval, progress, execution, interactionState, recommendedNextAction }`.

**Parameter principle:** `prompt`, `approvalPolicy`, and `sandbox` are required; `effort` defaults to `low` and callers raise it for harder tasks; other frequent parameters stay at the top level and rare ones move into `advanced`.

```text
Top level (frequent):
├── prompt: string          # required, task description
├── approvalPolicy: enum    # required: untrusted | on-failure | on-request | never
├── sandbox: enum           # required: read-only | workspace-write | danger-full-access
├── effort?: enum           # default low: none | minimal | low | medium | high | xhigh
├── cwd?: string            # working directory, default server cwd
├── model?: string          # model, default from config.toml
└── profile?: string        # config.toml profile name

advanced (rare):
├── baseInstructions?: string        # replaces the default instructions
├── developerInstructions?: string   # developer instructions
├── personality?: enum               # none | friendly | pragmatic
├── summary?: enum                   # reasoning summary: auto | concise | detailed | none
├── config?: Record<string, unknown> # arbitrary config.toml overrides
├── ephemeral?: boolean              # do not persist the thread
├── outputSchema?: object            # JSON Schema for structured output
├── images?: string[]                # local image paths
├── approvalTimeoutMs?: number       # approval timeout, default 60000ms
└── waitForResult?: number           # foreground wait budget in ms, max 300000
```

**Workflow:**

1. Build the `codex app-server` spawn arguments (`-c` / `-p`).
2. Write `meta.json` for the new session and spawn the child process.
3. Write `pid.json` once the child process reports a PID.
4. Send `initialize` (params: `{ clientInfo: { name: "codex-mcp", version }, capabilities? }`).
5. Send `thread/start` to create the thread (every param optional: cwd, model, modelProvider, approvalPolicy, sandbox, personality, ephemeral, baseInstructions, developerInstructions, config).
6. Send `turn/start` for the first turn (params: `{ threadId, input: [{ type: "text", text: prompt }] }`). Each `images` entry becomes a `{ type: "localImage", path }` element of `input`.
7. Register the notification and server-request handlers before `client.start()`.
8. Take `activeTurnId` from the `turn/started` notification, which `turn/interrupt` needs.
9. Return the session id, or wait for the result when `advanced.waitForResult` is set.

For `kind="command"` approvals, `actions[]` and the matching `approval_request` event carry `commandActions`, `proposedExecpolicyAmendment`, `availableDecisions`, `additionalPermissions`, `networkApprovalContext`, and `proposedNetworkPolicyAmendments`, so a client can render the approval context directly.

### Tool 2: `codex_reply` — Continue A Session

```text
├── sessionId: string       # required
├── prompt: string          # required, follow-up message
├── model?: string          # overrides the model for this and later turns
├── approvalPolicy?: string # overrides the approval policy
├── effort?: string         # overrides reasoning effort
├── summary?: string        # overrides the reasoning summary
├── personality?: string    # overrides the personality
├── sandbox?: enum          # read-only | workspace-write | danger-full-access, mapped to a SandboxPolicy object
├── cwd?: string            # overrides the working directory
├── outputSchema?: object   # structured output for this turn
└── waitForResult?: number  # foreground wait budget in ms, max 300000
```

The override parameters map to the same-named fields of `TurnStartParams` and apply to the current turn and later ones.

**Workflow:**

1. Look up the session and require status `idle` or `error`; a cancelled session returns error code `CANCELLED`.
2. Require a `threadId`.
3. Drop the previous turn's `result` and `error` events.
4. Send `turn/start` over the existing child process; on failure restore the session to `error`.
5. Return immediately, or wait for the result when `waitForResult` is set.

### Tool 3: `codex_setup` — Report Local Readiness

Takes an optional `cwd` and returns:

```text
├── ready: boolean               # executable resolved and auth not rejected
├── cwd: string
├── executable: { ok, source, command?, isPath?, detail }
├── auth: { ok, state, detail }  # state: authenticated | unauthenticated | unknown
├── runtime: { sameMachineRequired: true, clientMode?, stateDir }
├── projectContext: { hasUserConfig, hasProjectConfig }
├── warnings: string[]
└── nextSteps: string[]
```

`auth` comes from `codex login status` with a 5-second timeout. A `codex-internal` executable skips the probe and reports `state: "unknown"` without blocking readiness. `projectContext` reports whether `~/.codex/config.toml` and `<cwd>/.codex/config.toml` exist. `runtime.clientMode` runs the same probe as startup detection.

### Tool 4: `codex_session` — Manage Sessions

```text
├── action: "list" | "get" | "cancel" | "interrupt" | "fork" | "clean" | "clean_background_terminals"
├── sessionId?: string          # required for get/cancel/interrupt/fork/clean_background_terminals
├── includeSensitive?: boolean  # get: include sensitive fields
├── statuses?: ("idle"|"error"|"cancelled")[]  # clean: default all three
├── olderThanMs?: number        # clean: only sessions inactive at least this long
├── dryRun?: boolean            # clean: report matches, remove nothing
└── includeDisk?: boolean       # clean: default true, also remove persisted state
```

**Actions:**

- `list`: public, redacted info for every session in memory.
- `get`: one session's details; `includeSensitive=true` adds `threadId`, `cwd`, `profile`, and `config`.
- `cancel`: terminal. Resolves every pending request with `cancel`, kills the child process, and records `cancelledReason`.
- `interrupt`: sends `turn/interrupt` with `threadId` + `activeTurnId` and keeps the session; the interrupted turn ends as `idle`.
- `fork`: sends `thread/fork` on the original client, then runs the forked thread in a new session with its own child process. The source session is unchanged.
- `clean`: batch-removes sessions matching `statuses` and `olderThanMs`, returning `{ matchedSessionIds, removedSessionIds, removedCount, diskSessionsRemoved, dryRun }`. `dryRun` fills `matchedSessionIds` only.
- `clean_background_terminals`: sends `thread/backgroundTerminals/clean` for the thread. The client asks for the `experimentalApi` capability during `initialize`, so a backend that carries the method serves it; a CLI build that does not know the capability answers `INTERNAL`.

### Tool 5: `codex_check` — Poll Events And Answer Requests

```text
├── action: "poll" | "respond_permission" | "respond_user_input"
├── sessionId: string
│
│ # poll
├── cursor?: number          # event offset, default the session's last consumed cursor
├── maxEvents?: number       # poll default 50 (minimum 1), respond_* default 0
├── responseMode?: "minimal" | "delta_compact" | "full"  # default minimal
├── pollOptions?: {
│     includeEvents?: boolean   # default true
│     includeActions?: boolean  # default true
│     includeResult?: boolean   # default true
│     skipDeltas?: boolean      # default false, drop delta events and advance the cursor past them
│     finalOnly?: boolean       # default false, forces includeEvents=false and includeResult=true
│     maxBytes?: number         # default unlimited, best-effort truncation when exceeded
│     waitMs?: number           # long-poll budget in ms, clamped to 120000
│   }
│
│ # respond_permission
├── requestId?: string       # approval request id
├── decision?: "accept" | "acceptForSession" | "acceptWithExecpolicyAmendment" | "applyNetworkPolicyAmendment" | "decline" | "cancel"
├── execpolicy_amendment?: string[]        # acceptWithExecpolicyAmendment only
├── network_policy_amendment?: { action: "allow" | "deny"; host: string }  # applyNetworkPolicyAmendment only
├── denyMessage?: string     # recorded in the codex-mcp approval_result event, never sent to app-server
│
│ # respond_user_input
├── requestId?: string       # user-input request id
└── answers?: Record<string, { answers: string[] }>  # question id → answers
```

**poll response:**

```json
{
  "sessionId": "sess_abc123",
  "status": "running",
  "pollInterval": 120000,
  "progress": {
    "phase": "acting",
    "lastEventAt": "2026-02-15T...",
    "activeTurnId": "turn_1",
    "pendingActionCount": 0,
    "lastMethod": "item/commandExecution/outputDelta",
    "tokens": { "input": 1200, "output": 340, "total": 1540 }
  },
  "interactionState": "working",
  "recommendedNextAction": "poll",
  "events": [
    { "id": 0, "type": "output", "data": {}, "timestamp": "..." },
    { "id": 1, "type": "progress", "data": {}, "timestamp": "..." }
  ],
  "nextCursor": 2,
  "actions": [
    {
      "type": "approval",
      "requestId": "req_001",
      "kind": "command",
      "params": { "command": "npm install", "cwd": "/project", "reason": "Install dependencies" },
      "itemId": "item_xxx",
      "reason": "Install dependencies",
      "commandActions": [],
      "proposedExecpolicyAmendment": [],
      "createdAt": "2026-02-15T..."
    }
  ],
  "result": null
}
```

### Static Resources (Not Tools)

The server exposes 7 read-only MCP resources carrying metadata and usage guidance. They take no part in agent lifecycle control:

- `codex-mcp:///server-info` (`application/json`): server version, runtime, platform, `clientMode`, and the resource index
- `codex-mcp:///compat-report` (`application/json`): cross-backend capability report
- `codex-mcp:///config` (`text/markdown`): parameter guide and the mapping to `codex app-server -c`
- `codex-mcp:///gotchas` (`text/markdown`): polling, cursors, approval timeouts, and exec-mode failure modes
- `codex-mcp:///quickstart` (`text/markdown`): the minimal end-to-end workflow
- `codex-mcp:///errors` (`text/markdown`): error-code reference and recovery hints
- `codex-mcp:///delegation-guide` (`text/markdown`): approval/sandbox presets per task type

Constraints:

- The server keeps 5 MCP tools and adds no others.
- The server exposes no prompts.
- Resource content is static documentation and metadata; it carries no environment variables or other sensitive values.

## Session Lifecycle

```text
                    +---> waiting_approval ---+
                    |                         |
  (start) ---> running ---+---> idle ---+---> running (reply)
                    |                   |
                    +---> error         +---> cancelled
                    |
                    +---> cancelled
```

**Statuses:**

- `running`: the agent is executing
- `idle`: the turn finished and the session accepts a follow-up
- `waiting_approval`: the agent needs an approval or user input
- `error`: the turn failed
- `cancelled`: the session was cancelled (terminal)

**Transitions:**

- `running` → `idle`: the turn completed (`turn/completed`)
- `running` → `error`: the turn failed (an `error` notification with `willRetry: false`)
- `running` → `waiting_approval`: an approval or user-input request arrived
- `running` → `cancelled`: the caller cancelled
- `waiting_approval` → `running`: the request was answered or timed out
- `waiting_approval` → `cancelled`: the caller cancelled
- `idle` → `running`: `codex_reply` sent a new message
- `error` → `running`: `codex_reply` retried
- A late approval request against a `cancelled` or `error` session gets an immediate rejection and creates no pending request, so the status never jumps back.

An `error` notification with `willRetry: true` keeps the status and emits a pinned `progress` event whose `data.method` is `codex-mcp/reconnect` and whose `phase` is `retrying`, so clients can show reconnect state without treating it as terminal.

## Foreground Execution

`codex` (`advanced.waitForResult`) and `codex_reply` (`waitForResult`) turn the normal background start into a foreground wait of up to 300000 ms. `src/utils/execution.ts` polls the session status in slices bounded by `SessionManager.waitForChange`, and:

- returns the final `result` and `completedAt` when the status becomes `idle`, `error`, or `cancelled`;
- returns immediately with `execution.fallbackReason: "interactive_poll_required"` when the status becomes `waiting_approval`, because answering an approval needs another tool call;
- returns session metadata with `execution.fallbackReason: "wait_for_result_timeout"` when the budget runs out;
- returns session metadata with `execution.fallbackReason: "wait_refused"` when the session already holds its
  maximum of four waiters, so the caller polls instead of waiting on a queue it cannot join.

Every `codex`, `codex_reply`, and `codex_check` response carries three orchestration hints: `execution` (`requested` vs `effective` mode plus the fallback reason), `interactionState` (`working` / `waiting_input` / `finished`), and `recommendedNextAction` (`poll` / `respond_permission` / `respond_user_input` / `none`).

## Progress Reporting

`progress` summarizes a session without reading its events:

| Field                | Source                                                                                              |
| -------------------- | --------------------------------------------------------------------------------------------------- |
| `phase`              | Status first (`waiting_approval`/`cancelled`/`error`/`finished`), then `starting` when no turn is active, then `reasoning` or `acting` from the last observed method, else `running` |
| `lastEventAt`        | Timestamp of the last notification or server request                                                |
| `activeTurnId`       | The turn id tracked from `turn/started`                                                             |
| `pendingActionCount` | Unresolved pending requests                                                                         |
| `lastMethod`         | The last observed JSON-RPC method, ignoring `thread/tokenUsage/updated`                             |
| `tokens`             | Merged from `thread/tokenUsage/updated` and the exec turn's `usage`, accepting both camelCase and snake_case key names |

`reasoning` covers `item/reasoning/textDelta`, `item/reasoning/summaryTextDelta`, `item/reasoning/summaryPartAdded`, and `item/plan/delta`. `acting` covers `item/commandExecution/outputDelta`, `item/commandExecution/terminalInteraction`, `item/fileChange/outputDelta`, `item/mcpToolCall/progress`, `turn/diff/updated`, and `turn/plan/updated`.

## Event Buffering

### EventBuffer

```typescript
interface EventBuffer {
  events: SessionEvent[];
  maxSize: number; // 1000 (soft limit)
  hardMaxSize: number; // 2000 (hard limit)
  nextId: number; // monotonic
}

interface SessionEvent {
  id: number;
  type: "output" | "progress" | "approval_request" | "approval_result" | "result" | "error";
  data: unknown;
  timestamp: string;
  pinned: boolean;
}
```

### Event Type Mapping

> The left column is the real `method` of the app-server JSON-RPC notification or request, as generated by `codex app-server generate-json-schema`. It appears in `codex_check` responses at `events[].data.method`.

| app-server method                       | codex-mcp event type | Pinned | Notes                                                                     |
| --------------------------------------- | -------------------- | ------ | --------------------------------------------------------------------------- |
| `item/agentMessage/delta`               | output               | No     | Agent text increment                                                        |
| `item/completed` (ThreadItem)           | output/progress      | No     | By `item.type`: `agentMessage`/`userMessage` → output; everything else → progress |
| `item/started`                          | progress             | No     | Item started                                                                |
| `rawResponseItem/completed` (ResponseItem) | progress          | No     | ExecClient's `raw_response_item`; a ResponseItem, so no `agentMessage` type and no final answer to read |
| `item/commandExecution/outputDelta`     | progress             | No     | Command output increment, after shell-noise filtering                       |
| `item/commandExecution/terminalInteraction` | progress         | No     | Terminal interaction                                                        |
| `item/fileChange/outputDelta`           | progress             | No     | File-change increment                                                       |
| `item/reasoning/textDelta`              | progress             | No     | Reasoning text increment                                                    |
| `item/reasoning/summaryTextDelta`       | progress             | No     | Reasoning summary increment                                                 |
| `item/reasoning/summaryPartAdded`       | progress             | No     | Reasoning summary part                                                      |
| `item/plan/delta`                       | progress             | No     | Plan increment (EXPERIMENTAL)                                               |
| `item/mcpToolCall/progress`             | progress             | No     | MCP tool call progress                                                      |
| `turn/started`                          | progress             | No     | Turn started; the source of `activeTurnId`                                  |
| `turn/completed`                        | result               | Yes    | Turn finished                                                               |
| `turn/diff/updated`                     | progress             | No     | Turn-level unified diff                                                     |
| `turn/plan/updated`                     | progress             | No     | Turn-level plan update                                                      |
| `thread/started`                        | progress             | No     | Thread started; refreshes `threadId` when the notification carries a new one |
| `thread/archived`, `thread/unarchived`, `thread/name/updated`, `thread/tokenUsage/updated` | progress | No | Thread state                                                          |
| `model/rerouted`                        | progress             | No     | Backend rerouted the model                                                  |
| `fuzzyFileSearch/sessionUpdated`, `fuzzyFileSearch/sessionCompleted` | progress | No | Fuzzy file search                                                    |
| `windows/worldWritableWarning`          | progress             | No     | Windows permission warning                                                  |
| `account/login/completed`               | progress             | No     | Login completed                                                             |
| `error` (`willRetry: false`)            | error                | Yes    | Terminal error                                                              |
| `error` (`willRetry: true`)             | progress             | Yes    | Rewritten to `codex-mcp/reconnect`                                          |
| `item/commandExecution/requestApproval` | approval_request     | Yes    | Command approval (server-initiated request)                                 |
| `item/fileChange/requestApproval`       | approval_request     | Yes    | File-change approval (server-initiated request)                             |
| `item/tool/requestUserInput`            | approval_request     | Yes    | User input (server-initiated request)                                       |
| approval response (codex-mcp internal)  | approval_result      | Yes    | The decision, including timeouts                                            |
| `codex-mcp/ttl_warning` (codex-mcp internal) | progress        | No     | 60 seconds before TTL cleanup                                               |

Notifications outside this table are ignored.

### Shell Noise Filtering

On Windows, PowerShell profile output (oh-my-posh banners, PSReadLine, terminal-integration escape sequences) leaks into every command execution. `item/commandExecution/outputDelta` deltas are stripped of those lines before they enter the buffer, and a delta that was entirely noise produces no event. `CODEX_MCP_DISABLE_NOISE_FILTER=1` turns the filter off.

### Eviction

1. `events.length > maxSize`: evict the oldest non-pinned event.
2. All events pinned: evict the oldest `approval_result` first.
3. `events.length > hardMaxSize`: `shift` the oldest event, pinned included.

### Cursor Pagination

- The client sends `cursor` (the previous `nextCursor`); omitting it continues from the session's last consumed cursor.
- The server returns events with `id >= cursor` plus `nextCursor`.
- When the earliest buffered event id is greater than the cursor, older events were evicted and the response carries `cursorResetTo`.

### Poll Shaping

- `responseMode` controls per-event payload size: `minimal` (default), `delta_compact`, `full`. Each caps a per-event `delta` — 256, 2048 and 16384 characters — and sets `deltaTruncated` on the event it cut.
- `pollOptions` rejects any key it does not declare. `maxEvents` is a top-level `codex_check` field, and sending it inside `pollOptions` fails validation instead of falling back to the default.
- `pollOptions.skipDeltas` omits `item/agentMessage/delta`, `item/commandExecution/outputDelta`, `item/fileChange/outputDelta`, `item/reasoning/textDelta`, `item/reasoning/summaryTextDelta`, and `item/plan/delta` while advancing the cursor past them, so the client never re-reads them.
- `pollOptions.finalOnly` forces `includeEvents=false` and `includeResult=true`, keeps `actions[]`, and advances the cursor past every unseen event. It is the result-centric poll.
- `pollOptions.maxBytes` caps the serialized response; when the cap bites, the response sets `truncated` and lists `truncatedFields`.
- `respond_permission` and `respond_user_input` advance the cursor monotonically — `max(cursor, sessionLastCursor)` — so a stale cursor from an MCP host replays nothing.

### Long Polling

`pollOptions.waitMs` turns a poll into a long poll. The handler polls, and when the response has no events, no actions, and no result it waits on `SessionManager.waitForChange` and polls again, until data appears, the request aborts, or the budget runs out. `waitMs` is clamped to 120000 ms.

`waitForChange` resolves on any state change: a pushed event, a new pending request, a status change, or a session eviction. A session accepts 4 concurrent waiters; the fifth rejects, and the caller falls back to an immediate poll.

## Permission Model — Three Layers

### Layer 0 — Approval Policy (`approvalPolicy`)

Controls when the agent needs a human decision:

- `never`: every operation is auto-approved, no interaction
- `on-failure`: auto-approve, retry on failure
- `on-request`: the model decides when to ask (the recommended default)
- `untrusted`: strictest, every operation needs approval

### Layer 1 — Sandbox Isolation (`sandbox`)

Controls the agent's filesystem and network access:

- `read-only`: read-only filesystem. Some client and policy combinations block shell commands entirely; `read-only + never` suits pure analysis.
- `workspace-write`: workspace writable, network restricted (the recommended default)
- `danger-full-access`: unrestricted (dangerous)

### Layer 2 — Asynchronous Approval Arbitration

1. app-server sends a server-initiated request:
   - `item/commandExecution/requestApproval` for command execution
   - `item/fileChange/requestApproval` for file changes
   - `item/tool/requestUserInput` for user input

2. codex-mcp handles it:
   - creates a `PendingRequest` (requestId, params, itemId, threadId, turnId, reason, approval context)
   - pushes an `approval_request` event into the EventBuffer
   - moves the session to `waiting_approval`
   - starts the timeout timer (60000 ms by default)
   - wakes any long-poll waiters

3. The MCP client answers:
   - `codex_check(action="respond_permission")` for approvals, `codex_check(action="respond_user_input")` for questions
   - Command decisions: accept / acceptForSession / acceptWithExecpolicyAmendment / applyNetworkPolicyAmendment / decline / cancel
   - File-change decisions: accept / acceptForSession / decline / cancel

4. codex-mcp forwards it:
   - sends the decision back as the response to the server-initiated request
   - pushes an `approval_result` event
   - returns the session to `running` once no unresolved request remains

5. Timeout:
   - the request auto-declines without interrupting the agent
   - the `approval_result` event carries `timeout: true`

### Client Permission Guidance

1. **Choosing `approvalPolicy`:** `never` for fully automated runs in trusted environments, `on-failure` for CI/CD, `on-request` for interactive development, `untrusted` for high-security work.
2. **Choosing `sandbox`:** `read-only` for analysis, `workspace-write` for normal development, `danger-full-access` only when genuinely required.
3. **Answering approvals:** the client can auto-approve by rule (read-only commands, for instance), or forward the decision to a person. `acceptForSession` cuts repeat prompts.

## app-server Subprocess Management

### Structure

Every MCP session owns one `codex` child process over stdio transport.

### Spawn

```text
codex app-server [-c key=value]... [-p profile]
```

- `-c` comes from `advanced.config` plus the top-level parameters
- `-p` comes from `profile`
- Top-level mapping: `model` → `-c model=gpt-5.2`, `approvalPolicy` → `-c approval_policy=on-request`, `sandbox` → `-c sandbox_mode=workspace-write`
- `advanced.config` values serialize by type: primitives through `String(value)`, objects and arrays through `JSON.stringify(value)`

### JSON-RPC Transport

- Messages travel over the child's stdin/stdout.
- Request ids map to `{ resolve, reject, timeout }`.
- Notifications dispatch to a handler by method.
- Server-initiated requests dispatch to a handler that returns a response.

### Lifecycle

- Start: spawn → initialize → ready
- Run: forward thread and turn requests, dispatch events
- Stop: close stdin → wait for exit → SIGKILL after the timeout
- Fault: the child exits unexpectedly → the session becomes `error`

### Graceful Shutdown

`src/index.ts` shuts down on SIGINT, SIGTERM, SIGBREAK, an unhandled runtime error, or a stdin close that passes the guard:

1. Stop accepting new tool calls.
2. Flush the persistence event logs and release the STATE_DIR lock.
3. `SessionManager.destroy()` clears every pending request timer.
4. Send SIGTERM to every child process (`stdin.end` + kill), then SIGKILL after 5 seconds.
5. Close the MCP transport, then force-exit after 5 seconds (10 on Windows) if cleanup hangs.

`src/utils/stdin-shutdown.ts` guards the stdin path: while the transport still reports itself connected, a stdin `end` or `close` is treated as transient and the server keeps serving. Otherwise the server exits at once when no session is active, and waits up to 10 seconds (15 on Windows) for active sessions before forcing the exit.

### STDIO Preflight

`src/utils/stdio-guard.ts` runs before the MCP handshake and reports stdout-contamination risk: a TTY on stdin or stdout, or a PowerShell environment on Windows. `CODEX_MCP_STDIO_MODE` selects the behavior — `auto` (default) warns, `strict` refuses to start on a blocking risk, `off` disables the guard.

### Session TTL Cleanup

`SessionManager` runs a cleanup pass every 60 seconds:

- `idle` beyond 30 minutes → cancel the session and kill the child process
- `running` or `waiting_approval` beyond 4 hours → cancel (this bounds zombie sessions)
- `cancelled` or `error` beyond 5 minutes → evict from memory and remove the persisted directory
- A session with an unparseable `lastActiveAt` → cancel immediately

A session within 60 seconds of its TTL gets one `progress` event with `data.method = "codex-mcp/ttl_warning"` carrying `ttlRemainingMs` and `sessionId`. The event fires once per session and resets when the session's status changes.

Cleanup-driven `cancelSession` pushes a `progress` event and a `result` with `status=cancelled`, never an extra `error` event.

## Disk Persistence

State lives under `CODEX_MCP_STATE_DIR`, defaulting to `~/.codex-mcp/state`.

```text
STATE_DIR/
├── .lock                      # PID lockfile, single writer
└── sessions/
    └── <sessionId>/
        ├── meta.json          # session metadata
        ├── pid.json           # child-process identity for the orphan reaper
        ├── result.json        # final turn result
        └── events.jsonl       # append-only event log
```

### Write Path

- `meta.json` holds `schemaVersion`, `sessionId`, `status`, `createdAt`, `lastActiveAt`, `cancelledAt`, `cancelledReason`, `threadId`, `model`, `cwd`, `approvalPolicy`, `sandbox`, and `profile`. `SessionManager` writes it when the session is created and on every status change, skipping a write when the status is unchanged.
- `pid.json` holds `{ pid, spawnedAt, command }` and is written right after the child process starts.
- `result.json` holds the final `TurnResult` and is written when a turn completes or ends in error.
- `events.jsonl` holds one `{ seq, type, data, timestamp }` object per line. `EventLog` writes it with a tiered flush: `approval_request`, `approval_result`, `result`, and `error` flush immediately; everything else batches and flushes every 100 ms, and shutdown forces a final flush. Nothing in the current session write path calls `appendEvent`, so the file exists only for sessions whose events another writer produced.

Every JSON file is written through `atomicWriteJson`: write a sibling temp file, then rename. A crash between the two steps leaves only the temp file.

### Recovery

`scanRecoverableSessions` runs at startup over `STATE_DIR/sessions/`, after retention has pruned, so a directory retention removed never reaches `SessionManager`:

- Reads `meta.json`; a directory without one, or with `schemaVersion` above the supported version, is skipped.
- Parses `events.jsonl` line by line and stops at the first unparseable line, dropping the torn tail a crash left behind. It keeps the last 500 events.
- Reads `result.json` and `pid.json` when present.

`SessionManager.ingestRecovered` then loads them into memory:

- A session whose persisted status was `running` or `waiting_approval` becomes `error` with `cancelledReason: "Server restarted while session was active"`, because its child process is gone.
- Other statuses carry over; an unrecognized status becomes `error`.
- `result.json` becomes `lastResult`, so a client can still read the outcome of a completed session.
- The event-log sequence resumes at `lastSeq + 1`.
- A session id already in memory is skipped.

### Lockfile

`STATE_DIR/.lock` holds `{ pid, startedAt }` and is created with `O_EXCL`. A lock held by a dead PID is reclaimed; a lock held by a live foreign PID throws, and the message names the file to delete if the lock is stale. `startDiskPersistence()` in `src/session/persistence.ts` decides what happens next: it hands back the adapter, the recovered sessions and the prune count when it takes the lock, and warns on stderr and hands back nothing when any startup step fails — creating the state directory, taking the lock, pruning or scanning. A server that lost the lock keeps serving from memory and never reads, writes, prunes or reaps inside the state directory another server owns.

### Retention

`pruneSessionDirs` runs at startup, before the recovery scan, and removes session directories oldest-first, ordering by `meta.lastActiveAt` with the directory mtime as the fallback:

1. Age: older than 7 days
2. Count: beyond 200 retained sessions
3. Size: beyond 500 MB total across all session directories

### Orphan Reaper

`src/session/orphan-reaper.ts` runs after recovery and before the server accepts calls. For every recovered session that has a `pid.json`:

1. `process.kill(pid, 0)` decides whether the PID is alive; a dead PID counts as already gone.
2. The identity check compares the recorded `spawnedAt` against the process start time reported by the OS, with a 5-second tolerance: `wmic process where "ProcessId=<pid>" get CreationDate` on Windows, `ps -p <pid> -o lstart=` elsewhere. When `ps` gives nothing but `/proc/<pid>/stat` field 22 exists, the reaper accepts the process as an orphan only while the recorded spawn time is under 24 hours old.
3. A live PID that fails the identity check is a reused PID; the reaper logs it and leaves it alone.
4. A confirmed orphan gets SIGTERM (`taskkill /PID` on Windows), a 5-second poll for exit, then SIGKILL (`taskkill /PID /F`).

The reaper re-runs the liveness and identity checks immediately before signalling, which narrows the window in which the PID could be recycled.

## Configuration Resolution

```text
codex({ prompt, model, profile, advanced: { config } })
    │
    ▼
app-server spawn arguments:
  codex app-server
    -c model=gpt-5.2                ← model
    -c approval_policy=on-request   ← approvalPolicy
    -c sandbox_mode=workspace-write ← sandbox
    -c custom.key=value             ← advanced.config
    -p my-profile                   ← profile
    │
    ▼
codex app-server:
  1. loads the ~/.codex/config.toml defaults
  2. applies the profile
  3. applies the -c overrides
  4. runs with the result
```

## Error Handling

### Error Codes

- `INVALID_ARGUMENT`: parameter validation failed
- `SESSION_NOT_FOUND`: no such session
- `SESSION_BUSY`: the session is running and takes no new message
- `SESSION_NOT_RUNNING`: the action needs an active turn
- `REQUEST_NOT_FOUND`: the approval or user-input request does not exist or is already resolved
- `TIMEOUT`: the operation timed out
- `CANCELLED`: the session is cancelled
- `APP_SERVER_START_FAILED`: the child process failed to start
- `THREAD_FORK_RESUME_FAILED`: `thread/fork` or `thread/resume` failed
- `PROTOCOL_PARSE_ERROR`: an app-server message did not parse
- `WRITE_QUEUE_DROPPED`: a write to the child process was dropped
- `EXEC_NOT_SUPPORTED`: exec fallback mode does not implement this operation
- `INTERNAL`: internal error

### Error Response Shape

```json
{
  "content": [
    { "type": "text", "text": "Error [SESSION_NOT_FOUND]: Session 'sess_abc' not found" }
  ],
  "isError": true
}
```

`INTERNAL` messages pass through path redaction before they reach the client.

### Subprocess Errors

- The child exits unexpectedly: the session becomes `error` and an `error` event is pushed.
- A JSON-RPC request times out: `TIMEOUT`.
- Initialization fails: `INTERNAL`, and the child process is cleaned up.

### Turn Compatibility Fallback

`src/utils/turn-compat.ts` classifies a `turn/start` failure whose message names `minimal`, `web_search`, and reasoning effort together. When such a failure follows a turn sent with `effort=minimal`, `SessionManager` retries once with `effort=low` and returns `compatWarnings` describing the substitution. A retry that fails again surfaces the message telling the caller to use `effort=low` or higher.

## Dependencies

- `@modelcontextprotocol/sdk` — MCP protocol (McpServer, StdioServerTransport)
- `zod` — input validation
- Node.js `child_process` — the codex child processes

The server talks to the `codex` child process directly and needs no `@openai/codex-sdk`.

## Protocol Implementation Notes

> `codex-schema/` vendors the JSON Schema bundle of `codex app-server` as a versioned commit, used for protocol alignment and as a regression baseline.
> Regenerate it with `codex app-server generate-json-schema --experimental --out codex-schema` and update `codex-schema/metadata.json` in the same change.

### Approval Response Format (Must Match The Schema Exactly)

Command approval response (`CommandExecutionRequestApprovalResponse`):

- `accept` → `{ decision: "accept" }`
- `acceptForSession` → `{ decision: "acceptForSession" }`
- `acceptWithExecpolicyAmendment` → `{ decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: string[] } } }`
- `applyNetworkPolicyAmendment` → `{ decision: { applyNetworkPolicyAmendment: { network_policy_amendment: { action: "allow"|"deny", host: string } } } }`
- `decline` → `{ decision: "decline" }`
- `cancel` → `{ decision: "cancel" }`

File-change approval response (`FileChangeRequestApprovalResponse`):

- `accept` / `acceptForSession` / `decline` / `cancel` → `{ decision: "..." }`

`denyMessage` is not a protocol field; it only decorates the codex-mcp `approval_result` event.

### Approval Request Params

`CommandExecutionRequestApprovalParams`:

- required: `itemId`, `threadId`, `turnId`
- optional: `approvalId?`, `command?` (string | null), `cwd?`, `reason?`, `commandActions?` (array | null), `proposedExecpolicyAmendment?` (string[] | null)
- optional, richer approval context: `availableDecisions?`, `additionalPermissions?`, `networkApprovalContext?`, `proposedNetworkPolicyAmendments?`

`FileChangeRequestApprovalParams`:

- required: `itemId`, `threadId`, `turnId`
- optional: `grantRoot?` (UNSTABLE), `reason?`
- It carries no `changes[]`; file-change detail comes from `item/fileChange/outputDelta` aggregated by `itemId`.

### Other Server-Initiated Requests (All Must Be Answered)

app-server hangs the turn when a server-initiated request goes unanswered, so codex-mcp answers each one:

1. `item/tool/requestUserInput` — the tool asks the user a question
   - params: `{ itemId, threadId, turnId, questions: [{ id, header, question, isOther?, isSecret?, options? }] }`
   - response: `{ answers: Record<question-id, { answers: string[] }> }`
   - handling: buffered as an `approval_request` event of kind `user_input`, answered through `codex_check(action="respond_user_input")`

2. `item/tool/call` — a dynamic tool call
   - params: `{ threadId, turnId, callId, tool, arguments }`
   - response: `{ success: boolean, contentItems: [...] }`
   - handling: declined automatically with `{ success: false, contentItems: [{ type: "inputText", text: "Not supported by codex-mcp" }] }`

3. `account/chatgptAuthTokens/refresh` — auth token refresh
   - params: `{ reason: "unauthorized", previousAccountId? }`
   - response: `{ accessToken, chatgptAccountId, chatgptPlanType? }`
   - handling: a JSON-RPC error with code `-32000`, because codex-mcp manages no external auth
   - messages: `"account/chatgptAuthTokens/refresh unsupported: codex-mcp does not manage external ChatGPT auth tokens"` while running or waiting, `"account/chatgptAuthTokens/refresh unsupported: session is terminal"` in a terminal state

4. `applyPatchApproval` / `execCommandApproval` — deprecated approvals
   - handling: respond `{ decision: "denied" }` and log a warning

### turn/start Input Format

`prompt: string` becomes a `UserInput[]`:

```text
input: [{ type: "text", text: prompt }]
```

`images: string[]` (local paths) append:

```text
input: [..., { type: "localImage", path: imagePath }]
```

### State SessionManager Tracks

- `threadId` from the `thread/start` response (whitelist compatibility: v1 `{threadId}` and v2 `{thread: {id}}`), refreshed by a `thread/started` notification that carries a different id
- `activeTurnId` from the `turn.id` of the `turn/started` notification, needed by `turn/interrupt`
- `pendingRequests`, mapping requestId to the record that backs both `actions[]` and the response to the server-initiated request
- `lastAgentMessageText`, the last completed `agentMessage` item text, used as `result.text`: the app-server `Turn` carries no final text, and `turn.output` is sent by `codex exec` alone
- `progressState`, the running `lastEventAt`, `lastMethod`, and token counters

## Security Considerations

### Input Validation

- Zod schemas validate every tool parameter, including cross-field rules for the `codex_check` actions.
- `cwd` defaults to the server cwd and is resolved and validated before use; app-server validates it again.
- `advanced.config` values serialize by type before reaching app-server.
- `advanced.images` paths are resolved and validated against `cwd`.

### Subprocess Isolation

- Sessions run in separate child processes and do not affect each other.
- A child inherits the parent's environment variables, and public session output exposes none of them.
- A child that exits abnormally does not take down the MCP server process.

### Sensitive Data

- `codex_session(action="get")` returns redacted info by default; `includeSensitive=true` adds `cwd`, `profile`, `config`, and `threadId`.
- Approval requests carry the command text verbatim, and the client decides how to show it.
- `INTERNAL` error messages pass through path redaction.
- The answer to a user-input question marked `isSecret` reaches codex as given and enters the event buffer and `events.jsonl` as `<secret>`.

### Approval Timeout

- The default 60-second timeout auto-declines, which stops a session from hanging forever.
- A user-input request that times out is answered with an empty `answers` map, which says the caller answered nothing.
- A timeout declines the operation without interrupting the agent.

## Client Polling Guide

### Polling Strategy

`codex_check` returns `pollInterval` as a **minimum** interval; a client waiting longer for a slow task is behaving correctly:

```text
status = "waiting_approval" → pollInterval: 1000ms (respond before the approval times out)
status = "running"          → pollInterval: 120000ms (at least 2 minutes; 3-10+ for large tasks)
status = "idle"/"error"/"cancelled" → pollInterval: undefined (terminal, stop polling)
```

Long stretches without an event are normal while the model reasons and mean nothing about failure. A client that wants to hear about the next event sooner passes `pollOptions.waitMs` instead of shortening the interval. A client that prefers its own backoff multiplies the interval by 1.5 when a poll returns nothing and resets it when events arrive.

### Typical Loop

```text
1. codex({ prompt, approvalPolicy, sandbox }) → sessionId
2. loop:
   a. codex_check({ action: "poll", sessionId, cursor })
   b. render events[]
   c. answer any pending actions[]
      - codex_check({ action: "respond_permission", requestId, decision })
      - codex_check({ action: "respond_user_input", requestId, answers })
   d. branch on status:
      - "idle": the turn finished; continue with codex_reply or stop
      - "error": read the error and decide whether codex_reply retries
      - "cancelled": the session is over, leave the loop
      - "running" / "waiting_approval": keep polling
   e. cursor = nextCursor
   f. wait at least pollInterval
3. optionally codex_session({ action: "cancel" }) to release the child process
```

### Notes

- Always send back `nextCursor` so events arrive once.
- A `cursorResetTo` means older events were evicted; continue from the returned cursor.
- Approvals expire, so answer them within `approvalTimeoutMs`.
- `codex-mcp/ttl_warning` gives 60 seconds of notice before a session is cleaned up; a `codex_reply` or another tool call refreshes `lastActiveAt` and postpones the cleanup.
- A session recovered after a server restart reports `status: "error"` with `cancelledReason` naming the restart, and its last result is still readable.
