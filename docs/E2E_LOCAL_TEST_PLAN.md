# codex-mcp E2E Local Test Plan (For Third-Party MCP Client LLMs)

This document is written for a large model running inside a third-party MCP client, where `@kvokka/codex-mcp` and `codex` CLI are already installed on the host machine.

Your goal is to verify that `codex-mcp` works correctly as an MCP server in real tasks, not to modify `codex-mcp` source code.

## 0. Executor Contract (Read First)

When you execute this plan as an LLM test operator:

1. Treat MCP tool responses as ground truth. Do not rely on UI guesswork.
2. For each step, record:
   - tool name
   - input params
   - output payload
   - session `status`
   - `progress`
   - `actions[]` (if present)
3. If `actions[]` is non-empty, respond before timeout using `codex_check`.
4. Keep testing in an isolated project workspace, not inside production code.

## 1. What You Must Prove

Minimum pass target:

1. The server exposes 5 tools and 7 resources correctly.
2. `codex` and `codex_reply` are asynchronous (return immediately, then progress via polling).
3. Approval flow works (`respond_permission`) and session state changes correctly.
4. A real coding task closes the loop: test fails -> agent fixes -> test passes.
5. Session management works (`list/get/resume/cancel/interrupt/steer/fork/clean/clean_background_terminals/terminate_background_terminal`).
6. A session whose server went away comes back as `abandoned` and `resume` carries its thread on.

Optional but recommended:

1. Structured output via `outputSchema`.
2. User input response flow via `respond_user_input`.
3. Long polling (`waitMs`) and the once-only delivery of the terminal `result`.

## 2. Preconditions

Required:

1. bun >= 1.4
2. `codex` in PATH (`codex --version` works)
3. `@kvokka/codex-mcp` launchable from host machine
4. Network available for model calls

Recommended:

1. Ensure server stdout is clean (no banner/noise on stdout).
2. Keep server logs on stderr only.
3. Validate model/auth availability with a lightweight `codex` session before approval-heavy tests (recommended pair: `approvalPolicy=on-request`, `sandbox=read-only`).

Windows-specific:

1. **CRITICAL: Clean your PowerShell profile before testing.** Use `pwsh -NoProfile` or temporarily rename/empty your `$PROFILE` file. If your profile loads modules like oh-my-posh or custom PSReadLine configurations, their stdout output leaks into **every** `codex app-server` command execution — not just the MCP handshake. In practice this means ~15 lines of noise per command turn, causing significant token waste and context window pollution. The agent will self-correct after failed commands, but the first round of commands (typically 3-4) will all fail, wasting substantial tokens before recovery. This is not a minor inconvenience — it is the single largest source of wasted tokens in Windows E2E testing.
2. Paths with parentheses (e.g., `C:\Program Files (x86)`) can cause shell parsing failures. Prefer paths without special characters for `cwd`. **Note:** This also affects codex internally — on many Windows installations, codex defaults to `C:\Program Files (x86)\PowerShell\7\pwsh.exe` as its shell, which itself contains parentheses. This is a known codex-side issue that users cannot work around via `cwd` alone. If you observe shell parsing errors unrelated to your workspace path, this may be the cause.
3. Codex defaults to PowerShell as the shell on Windows. If bash-style commands fail (e.g., `ls -la`), this is expected. The agent will self-correct, but expect the first 1-4 commands to fail before it adapts to PowerShell syntax. Budget extra tokens and polling rounds for this Windows-specific warm-up.

## 2.1 Start codex-mcp (Required Before TC0)

Use one of these launch modes in your MCP client configuration:

1. Recommended installed package path:

```bash
bunx @kvokka/codex-mcp
```

2. If globally installed:

```bash
codex-mcp
```

3. If you are testing this repository checkout directly:

```bash
bun install
bun run build
bun dist/index.js
```

Do not continue to TC0 until the MCP client can start the server command successfully.

Source-only verification (skip if you installed the published package):

If you are testing from a local repository checkout (option 3 above), these scripts can verify stdout cleanliness before connecting an MCP client. They are **not available** when using the published npm package.

```bash
bun run check:stdio        # basic stdout cleanliness check
bun run check:stdio:strict # strict mode (fails on any stdout contamination)
bun run smoke:mcp          # lightweight MCP handshake smoke test
```

## 3. Capability Gate (5-Minute Smoke)

Before deep E2E, verify basics.

## 3.1 Tool Discovery

Run `tools/list` from your MCP client.

Expected tool names:

1. `codex`
2. `codex_reply`
3. `codex_setup`
4. `codex_session`
5. `codex_check`

Call `codex_setup` first. It reports executable resolution, `codex login status`, the Codex CLI version against the minimum this server drives, the state directory, and whether user/project `config.toml` files are visible. Fix anything in `nextSteps` before TC1; `ready: false` means later tests will fail for environment reasons, not server reasons.

## 3.2 Resource Discovery

Run `resources/list`, then read each resource that appears.

The server registers 7 resources:

1. `codex-mcp:///server-info` — JSON metadata (server version, platform, `codexCliVersion`, resource index)
2. `codex-mcp:///compat-report` — JSON metadata (feature flags, compatibility warnings)
3. `codex-mcp:///config` — markdown (parameter guide and config.toml mapping)
4. `codex-mcp:///gotchas` — markdown (practical limits and common issues)
5. `codex-mcp:///quickstart` — markdown (minimal end-to-end workflow)
6. `codex-mcp:///errors` — markdown (error code reference and recovery hints)
7. `codex-mcp:///delegation-guide` — markdown (approval/sandbox presets per task type)

Expected:

1. `resources/list` returns 7 entries. A smaller count means an older build; run `bun run build` when testing from source, or update the package.
2. JSON resources parse cleanly; markdown resources return non-empty text.
3. `server-info.codexCliVersion` reports the CLI on PATH, and `server-info.minCodexCliVersion` the oldest this server drives.

Stop and troubleshoot only if `resources/list` itself fails or returns 0 resources.

## 4. Build a Minimal Repro Workspace (No `e2e/` Dependency)

Because this plan targets third-party environments, use an inline reproducible project.

Choose the setup script that matches your **shell**, not your OS:

- **Bash** (Linux, macOS, Windows MINGW/Git Bash, WSL): use section 4.1
- **PowerShell** (Windows native `pwsh` or `powershell`): use section 4.2

> **Windows users**: If your MCP client runs in MINGW/Git Bash (e.g., Claude Code on Windows defaults to bash), use the Bash setup even though you are on Windows. Only use the PowerShell setup if you are explicitly running in a PowerShell terminal.

## 4.1 Bash Setup (Linux / macOS / Windows MINGW / WSL)

```bash
dst="$HOME/codex-mcp-e2e/mean-bug"
mkdir -p "$dst"

cat > "$dst/package.json" <<'EOF'
{
  "name": "mean-bug",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "bun test"
  }
}
EOF

cat > "$dst/math.js" <<'EOF'
export function mean(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return 0;
  const sum = arr.reduce((a, b) => a + b, 0);
  return sum / (arr.length + 1); // BUG: should divide by arr.length
}
EOF

cat > "$dst/math.test.js" <<'EOF'
import test from "node:test";
import assert from "node:assert/strict";
import { mean } from "./math.js";

test("mean of [1,2,3] should be 2", () => {
  assert.equal(mean([1, 2, 3]), 2);
});

test("mean of [5,5] should be 5", () => {
  assert.equal(mean([5, 5]), 5);
});
EOF

bun test --prefix "$dst"
```

> **Note**: Avoid `cd "$dst"` in the setup script — some MCP client environments (e.g., Claude Code) reset the working directory after each shell invocation. Use `bun test --prefix "$dst"` or `(cd "$dst" && bun test)` instead.

## 4.2 PowerShell Setup (Windows native pwsh)

> **Warning**: If your PowerShell profile loads modules like oh-my-posh or custom PSReadLine configurations, their stdout output will leak into every `codex app-server` command execution. This causes token waste and occasional command parsing failures. Run `pwsh -NoProfile` or clean your profile before testing.

```powershell
$dst = "D:\Lab\codex-mcp-e2e\mean-bug"
New-Item -ItemType Directory -Force -Path $dst | Out-Null

@'
{
  "name": "mean-bug",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "bun test"
  }
}
'@ | Set-Content -Path (Join-Path $dst "package.json") -Encoding UTF8

@'
export function mean(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return 0;
  const sum = arr.reduce((a, b) => a + b, 0);
  return sum / (arr.length + 1); // BUG: should divide by arr.length
}
'@ | Set-Content -Path (Join-Path $dst "math.js") -Encoding UTF8

@'
import test from "node:test";
import assert from "node:assert/strict";
import { mean } from "./math.js";

test("mean of [1,2,3] should be 2", () => {
  assert.equal(mean([1, 2, 3]), 2);
});

test("mean of [5,5] should be 5", () => {
  assert.equal(mean([5, 5]), 5);
});
'@ | Set-Content -Path (Join-Path $dst "math.test.js") -Encoding UTF8

Set-Location $dst
bun test
```

Expected initial state: tests fail.

Define a reusable workspace placeholder now and keep it consistent in all tool calls:

- `REPRO_CWD = <the absolute path you created above>`
- Examples:
  - PowerShell: `D:\Lab\codex-mcp-e2e\mean-bug`
  - Bash: `/home/<user>/codex-mcp-e2e/mean-bug`

Important:

1. Put an expanded absolute path in MCP JSON payloads.
2. Do not pass shell variables like `$HOME` literally as `cwd`.
3. On Windows (including MINGW/Git Bash clients), pass Windows-style paths in MCP payloads (for example `D:\\Lab\\...`), not `/d/Lab/...`. In JSON strings, backslashes must be double-escaped: the literal path `C:\Users\me\project` becomes `"C:\\Users\\me\\project"` in JSON.

## 5. Protocol Ground Rules You Must Follow

## 5.1 Required Inputs

When starting a session with `codex`, these are required:

1. `prompt`
2. `approvalPolicy`: `untrusted|on-request|never`
3. `sandbox`: `read-only|workspace-write|danger-full-access`, or `permissions` naming a profile id instead — one of the two, never both
4. `effort` is optional: any non-empty string, and Codex 0.150.1 advertises `low|medium|high|xhigh|max|ultra` (default: `low`). For complex tasks, explicitly set `medium`, `high` or `xhigh`.
5. `approvalsReviewer` is optional: `user` (default) or `auto_review`.

For `codex_reply`, required:

1. `sessionId`
2. `prompt`

## 5.2 Checking Rules

After `codex` or `codex_reply`:

1. Check with `codex_check(action="poll")`. Every action — `poll`, `respond_permission`, `respond_user_input` — answers with the same payload: `{ sessionId, status, progress, actions[], warnings[], result?, interactionState, recommendedNextAction }`.
2. No check returns the events of the turn. Codex writes the whole run to its rollout log under `~/.codex/sessions/**/rollout-*.jsonl`, and codex-mcp writes its own view to `events.jsonl` in the state directory. Read either from disk; the tool reports state.
3. Terminal statuses are `idle`, `error`, `cancelled`. `abandoned` also ends the turn, but the session is resumable rather than finished.
4. `result` arrives with the first check that sees a terminal status and carries the turn's final answer. Every later check of that terminal session carries the same result again.
5. `waitMs` long-polls: the call blocks until the status changes, a new action arrives, a new warning arrives, or the turn ends. Reasoning, command output and token counters do not end the wait. It is capped at `3600000` ms and cut further to what the MCP client sits through in one tool call, and a session accepts 4 concurrent long polls — the fifth returns immediately instead of waiting.
6. `progress` reports `phase`, `lastEventAt`, `activeTurnId`, `pendingActionCount`, `tokens` when the backend reports them, and `activity` — one line in Codex's own words saying what it is doing, or the line a hook wrote while the turn has written none, absent until one of them arrives. `warnings[]` says why a turn is producing no output at all. `interactionState` and `recommendedNextAction` tell you what to call next.
7. Inputs the tool no longer takes — `cursor`, `nextCursor`, `maxEvents`, `responseMode`, `pollOptions` — are refused with a message naming what replaced them.

codex-mcp does not poll the app-server. The backend pushes JSON-RPC notifications as they happen, and the only recurring timer in the server is the once-a-minute TTL sweep. During long reasoning phases 30-60+ seconds with no notification is normal.

Recommended MCP client polling strategy:

Codex tasks often take 2-10+ minutes. Do not poll every turn.

1. When `status` is `running`: wait at least 2 minutes between polls (never less). Estimate task duration and increase to 3-10+ minutes for larger tasks.
2. When `status` is `waiting_approval`: target ~1 second polling to respond to `actions[]` and unblock quickly.
3. When `status` is `idle`, `error`, or `cancelled`: stop polling. The session is done.
4. The tool descriptions for `codex`, `codex_reply`, and `codex_check` include this guidance so LLM callers see it directly.
5. To learn about a change as it happens without shortening the interval, pass `waitMs`: one call covers the whole stretch and costs one round trip, and it answers as soon as Codex says it is working on something new.
6. A start never blocks for the result. `codex` and `codex_reply` return as soon as the turn is under way, and `codex_check(action="poll", waitMs=300000)` is the only place a caller waits.
7. A session writes one `codex-mcp/ttl_warning` line to its event log 60 seconds before TTL cleanup. Checking a session does not postpone it: the TTL measures `lastActiveAt`, which moves when the session does — a reply, a cancel, a resume, a notification from the backend — and a `poll` writes nothing.

**CRITICAL: Approval timeout vs polling interval conflict.** The default `approvalTimeoutMs` is 60 seconds, but the recommended `running` polling interval is ≥2 minutes. If a session transitions from `running` to `waiting_approval` between polls, the approval will auto-decline before the client can respond. Mitigations:

- For approval-heavy tests (TC2, TC4 with `untrusted`/`on-request`), set `advanced.approvalTimeoutMs` to at least 300000 (5 minutes) to ensure approvals survive between polling intervals.
- Alternatively, use `approvalPolicy="never"` for tests that do not specifically test the approval flow, to avoid this timing issue entirely.
- A future server-side improvement (e.g., push notifications for status changes) would eliminate this fundamental tension.

## 5.3 Approval Rules

When `actions[]` is present:

1. Approval actions use `respond_permission`.
2. User-input actions use `respond_user_input`.
3. Do not guess request IDs; always copy the exact `requestId`.

Auto-approval behavior by policy:

Not all commands trigger an approval request. The codex CLI applies its own safety classification before surfacing approvals to the MCP layer:

- `untrusted`: Read-only commands (e.g., `ls`, `cat`, `dir`, `type`) are typically auto-approved by codex internally and will **not** generate an `actions[]` entry. Commands with side effects (e.g., `bun test`, `bun run`, write operations) require explicit approval.
- `on-request`: Similar to `untrusted` but with a broader set of auto-approved commands. Most read operations pass through; write operations and unknown commands require approval.
- `never`: All commands are auto-approved. No `actions[]` will appear for command approvals (file-change approvals may still appear depending on sandbox mode).

If you expect an approval request but none appears, the command was likely auto-approved by codex's internal policy. This is normal behavior, not a bug.

Decision constraints:

1. Command approvals accept:
   - `accept`
   - `acceptForSession`
   - `acceptWithExecpolicyAmendment` (requires `execpolicy_amendment`)
   - `applyNetworkPolicyAmendment` (requires `network_policy_amendment: { action: "allow"|"deny", host }`)
   - `decline`
   - `cancel`
2. File-change approvals accept:
   - `accept`
   - `acceptForSession`
   - `decline`
   - `cancel`

Parallel approval responses:

When multiple `actions[]` entries are pending simultaneously, you may send `respond_permission` for each in parallel. However, be aware that:

1. The second response may return stale `actions[]` data (showing already-resolved requests as still pending) due to race conditions in the response payload.
2. If a request was already resolved by the time your response arrives, you will get `Error [REQUEST_NOT_FOUND]`. This is expected and safe to ignore.
3. For reliability, prefer sending approval responses sequentially, or handle `REQUEST_NOT_FOUND` gracefully when sending in parallel.

## 6. Core E2E Test Matrix (Generic for Any MCP Client)

## TC0: Discovery & Basic Connectivity

Purpose:

1. Verify baseline server capabilities.

Steps:

1. Call `tools/list`.
2. Call `resources/list`.
3. Read each resource returned in section 3.2.

Pass criteria:

1. 5 tools present.
2. All 7 resources present, and `server-info`, `config` and `gotchas` readable.
3. No transport-level JSON-RPC corruption.

## TC1: Async Start + Poll (Read-Only Path)

Tool call (`codex`) suggested payload:

```json
{
  "prompt": "Read this workspace and summarize its structure. You may run read-only inspection commands only. Do not edit files.",
  "approvalPolicy": "on-request",
  "sandbox": "read-only",
  "effort": "low",
  "cwd": "<REPRO_CWD>"
}
```

Then poll (wait at least 2 minutes after starting the session before first poll):

```json
{
  "action": "poll",
  "sessionId": "<sessionId>",
  "waitMs": 3600000
}
```

Pass criteria:

1. Start call returns quickly with `sessionId`.
2. The check reports a status and a `progress` that moves between calls, and carries no events.
3. Final status reaches `idle` (or `error` with explicit reason).
4. If `actions[]` appears, respond and verify session can return from `waiting_approval` to `running`.

## TC2: Approval Flow (Command + File Change)

Tool call (`codex`) suggested payload:

```json
{
  "prompt": "Run bun test, fix the bug, rerun tests, then summarize changes.",
  "approvalPolicy": "untrusted",
  "sandbox": "workspace-write",
  "effort": "medium",
  "cwd": "<REPRO_CWD>",
  "advanced": { "approvalTimeoutMs": 300000 }
}
```

> **Why `approvalTimeoutMs: 300000`?** With the recommended ≥2-minute polling interval, the default 60-second approval timeout will expire before the client can respond. Setting 5 minutes ensures approvals survive between polling rounds. See Section 5.2 for details.

Expected behavior:

1. `status` switches to `waiting_approval` when approvals arrive.
2. `actions[]` contains pending requests.
3. After `respond_permission`, request disappears and status returns to `running` when queue empties.

Pass criteria:

1. At least one approval request handled successfully.
2. No stuck state after valid response.

## TC3: Real Bug-Fix Closed Loop

TC3 is the acceptance criteria for the TC2 session, not an independent test step. Since TC2's prompt already includes "fix the bug, rerun tests, then summarize changes", TC3 validates the end-to-end outcome of that same session.

Continue polling and approving the TC2 session until it reaches `idle`.

Pass criteria:

1. `math.js` is corrected (`sum / arr.length`).
2. Tests pass after fix.
3. Final result includes a coherent change summary.

## TC4: Multi-turn Context (`codex_reply`)

After session reaches `idle`, call:

```json
{
  "sessionId": "<sessionId>",
  "prompt": "Add two boundary tests for mean() and keep all tests passing.",
  "effort": "low"
}
```

Pass criteria:

1. Reply returns immediately.
2. Subsequent polling shows the status and `progress` moving; no check returns turn events.
3. Model uses existing context without re-explaining repository basics.

## TC5: Session Management (`codex_session`)

Validate:

1. `action="list"` returns every session of the state directory, each with its `activity` and its `owner` when a running server holds it.
2. `action="get"` returns details, `effective` among them: the model, provider,
   reasoning effort, approval policy and sandbox Codex answered the thread call
   with. Start a session naming no `model` and confirm `effective.model` names
   the model `config.toml` picked, while `model` stays absent.
3. `action="cancel"` moves to `cancelled`.
4. `action="interrupt"` works only while active turn is running.
5. `action="fork"` creates a new session/thread branch.
6. `action="resume"` is refused with `SESSION_BUSY` on a session this server already drives, and with `SESSION_HELD_BY_OTHER_SERVER` on one another running server holds. Section 7.7 covers the case it is for.
7. `action="clean"` batch-removes terminal sessions. Run it first with `dryRun: true` and confirm `matchedSessionIds` lists only `idle`/`error`/`cancelled` sessions, then run it for real and confirm `removedCount` matches and `codex_session(action="list")` no longer shows them.
8. `action="clean_background_terminals"` answers `backgroundTerminals` and does not crash the session. On a thread that ran no background command it reads `terminals: []`, `survivors: []`, `truncated: false`. Start one (`codex_reply` with a prompt that runs a command in the background) and confirm the same call then lists it, carries `terminated` for it, and reports it in `survivors` or as `gone: true`.
9. `action="terminate_background_terminal"` with a `processId` from step 8 answers `terminals: [{ processId, terminated }]`. A `processId` no longer running answers `terminated: false` rather than an error.
10. `action="steer"` on a running turn answers `turnId` equal to the `activeTurnId` the previous poll reported, and `status: "running"`. Use the slow prompt below, poll once to confirm `running`, then steer with `"Also list the file sizes"`. The session stays on the same turn — no new `turnId` appears — and the final `result` covers what the steer asked for. Steering an `idle` session answers `SESSION_NOT_RUNNING`; steering with no `prompt` answers `INVALID_ARGUMENT`.

**Note:** `thread/backgroundTerminals/list` and `…/terminate` arrived in Codex CLI 0.150; the floor this server drives is 0.101.0. codex-mcp asks for the `experimentalApi` capability during `initialize`, so a build that carries these methods serves them. A build that does not answers `Error [INTERNAL]`: `clean_background_terminals` falls back to `thread/backgroundTerminals/clean` and reports `cleanCalled: true` with `listError.stage: "before"`, and `terminate_background_terminal` raises the error. Record which of the two you saw and continue.

Example payload:

```json
{ "action": "clean", "statuses": ["cancelled"], "olderThanMs": 0, "dryRun": true }
{ "action": "clean", "statuses": ["cancelled"], "olderThanMs": 0 }
{ "action": "clean_background_terminals", "sessionId": "<SESSION_ID>" }
{ "action": "terminate_background_terminal", "sessionId": "<SESSION_ID>", "processId": "<PROCESS_ID>" }
{ "action": "steer", "sessionId": "<SESSION_ID>", "prompt": "Also list the file sizes" }
```

The `steer` action needs the same `running` window the `interrupt` trigger below
creates, so run both against that session: steer it first, confirm the turn
carried on, then interrupt it.

Interrupt trigger strategy:

The `interrupt` action requires the session to be in `running` status, but MCP client polling latency makes the window narrow. To reliably test it:

1. Start a new session with a deliberately slow prompt and high effort to create a long `running` window:

```json
{
  "prompt": "Read every file in this workspace carefully, then write a detailed 500-word analysis of the code structure, patterns used, and potential improvements. Take your time.",
  "approvalPolicy": "never",
  "sandbox": "read-only",
  "effort": "high",
  "cwd": "<REPRO_CWD>"
}
```

2. Using `approvalPolicy="never"` avoids `waiting_approval` interruptions, keeping the session in `running` longer.
3. Poll once to confirm `status="running"`, then immediately call `codex_session(action="interrupt", sessionId=...)`.
4. Poll again to verify the session transitions to `idle` (interrupted turns end as `idle`).
5. If the session reaches `idle` before you can interrupt, the prompt was too simple — retry with a more complex prompt or higher effort.

Pass criteria:

1. State changes match action semantics.
2. No transport crash on management operations.
3. `interrupt` successfully stops a running turn (or is documented as missed due to timing).
4. `clean` reports `{ matchedSessionIds, removedSessionIds, removedCount, diskSessionsRemoved, dryRun }`, and the dry run removes nothing.
5. `clean_background_terminals` returns `{ sessionId, backgroundTerminals }` whose `terminals` and `survivors` match what the thread actually ran, and `terminate_background_terminal` returns the `terminated` the CLI answered — never `Error [INTERNAL]` on a CLI at 0.150 or above (see the note under step 9 for one below it).
6. `steer` answers the running turn's own id and the turn carries on to one result covering the steered request; a steer that arrives after the turn ended answers `SESSION_NOT_RUNNING` carrying `no active turn to steer`, and is recorded as that rather than as a steer that landed.

## TC6 (Optional): Structured Output

`outputSchema` location differs by tool:

1. In `codex`, put it under `advanced.outputSchema`.
2. In `codex_reply`, put it at top-level `outputSchema`.

Schema example:

```json
{
  "type": "object",
  "properties": {
    "changedFiles": { "type": "array", "items": { "type": "string" } },
    "commandsRun": { "type": "array", "items": { "type": "string" } },
    "summary": { "type": "string" }
  },
  "required": ["changedFiles", "summary"],
  "additionalProperties": false
}
```

`codex` example with required fields:

```json
{
  "prompt": "Summarize what changed and output structured fields.",
  "approvalPolicy": "on-request",
  "sandbox": "workspace-write",
  "effort": "low",
  "cwd": "<REPRO_CWD>",
  "advanced": {
    "outputSchema": {
      "type": "object",
      "properties": {
        "changedFiles": { "type": "array", "items": { "type": "string" } },
        "commandsRun": { "type": "array", "items": { "type": "string" } },
        "summary": { "type": "string" }
      },
      "required": ["changedFiles", "summary"],
      "additionalProperties": false
    }
  }
}
```

`codex_reply` example:

```json
{
  "sessionId": "<sessionId>",
  "prompt": "Return structured summary for the previous turn.",
  "outputSchema": {
    "type": "object",
    "properties": {
      "changedFiles": { "type": "array", "items": { "type": "string" } },
      "commandsRun": { "type": "array", "items": { "type": "string" } },
      "summary": { "type": "string" }
    },
    "required": ["changedFiles", "summary"],
    "additionalProperties": false
  }
}
```

Pass criteria:

1. Result includes structured output or JSON-compatible text matching schema shape.

## 7. Advanced/Edge Tests (Implementation-Aware)

## 7.1 Approval Timeout

Use short timeout:

```json
{
  "prompt": "Run bun test and fix.",
  "approvalPolicy": "untrusted",
  "sandbox": "workspace-write",
  "effort": "low",
  "cwd": "<REPRO_CWD>",
  "advanced": { "approvalTimeoutMs": 3000 }
}
```

When an approval action appears, intentionally do not respond for >3 seconds.

Expected:

1. Request auto-declines.
2. The session's `events.jsonl` under the state directory holds an `approval_result` with `timeout: true`. No check returns it.

## 7.2 Invalid Decision Contract

Negative checks:

1. Respond with wrong decision type for `fileChange` -> expect `Error [INVALID_ARGUMENT]`.
2. Use `acceptWithExecpolicyAmendment` without `execpolicy_amendment` -> expect `Error [INVALID_ARGUMENT]`.
3. Reuse resolved `requestId` -> expect `Error [REQUEST_NOT_FOUND]`.

## 7.3 The Status Payload

Checks:

1. Generate a delta-heavy turn (a long build, a big file read), then check the session. The response carries `status`, `progress`, `actions[]` and nothing of the stream: no `events`, no `delta`, no `nextCursor`.
2. `progress.tokens` grows across checks while the turn runs, so the counters the backend reports still reach you.
3. Read `~/.codex/sessions/**/rollout-*.jsonl` for that thread and confirm the history is there, and `<STATE_DIR>/sessions/<sessionId>/events.jsonl` for this server's own view.

## 7.4 Removed Inputs

Checks:

1. Send `codex_check(action="poll", cursor=0)`, then the same with `maxEvents`, `responseMode`, and `pollOptions`. Each is refused with a message naming what replaced it.
2. Send `codex_check(action="respond_permission", ..., waitMs=1000)`. It is refused: `waitMs` belongs to `poll`.

## 7.4a Approval auto-review (`approvalsReviewer`)

Checks:

1. Start a session with `approvalPolicy: "on-request"`, `sandbox: "workspace-write"`, `approvalsReviewer: "auto_review"` and a prompt that must step outside the sandbox — reaching the network is the plainest one. Poll it. Expect `actions[]` to stay empty: the decision is made inside Codex and no approval reaches this server.
2. Where the review denies, expect `progress.activity` to read "Approval auto-review denied an action of this turn", and `<STATE_DIR>/sessions/<sessionId>/events.jsonl` to carry an `approval_result` record with `method: "item/autoApprovalReview/completed"`, its `reviewId` and `status: "denied"`.
3. Run the same prompt with `approvalsReviewer: "user"` and the same policy. Expect the approval to arrive in `actions[]` for you to answer, which is what the two settings differ in.
4. Resume the `auto_review` session in a second server (`codex_session(action="resume")`) and reply on it. Expect the reviewer to still be `auto_review`: it is recorded in `meta.json` and goes back on `thread/resume`.

## 7.4b Permission profiles (`permissions`)

Checks:

1. Call `codex_setup`. Expect `permissionProfiles.profiles` to carry the ids of this machine — `:read-only`, `:workspace` and `:danger-full-access` are the built-ins — each with an `allowed` flag.
2. Start a session with `permissions: ":read-only"` and no `sandbox`. Expect it to start, and a prompt that writes a file to be refused by the profile.
3. Send `sandbox` and `permissions` together. Expect `INVALID_ARGUMENT` from the tool schema naming both, with no codex process spawned.
4. Send `permissions: "no-such-profile"`. Expect `INVALID_ARGUMENT` listing the ids this machine offers, and not the Codex message about a `[permissions]` table.
5. Send a `codex` call naming neither `sandbox` nor `permissions`, with `CODEX_MCP_DEFAULT_SANDBOX` unset. Expect it refused, naming both ways out.

## 7.5 Long Polling (`waitMs`)

Checks:

1. Start a long `running` session, then check with `waitMs: 300000`. The call sits through the model's reasoning and its command output, and returns when the status changes, an action arrives, the turn ends, or Codex writes a new activity line — or, if none of them happens, just inside the client's own ceiling on one tool call.
2. Check an `idle` session with `waitMs: 5000`. It returns at once with the terminal `result`; a second check returns the same status without the result.
3. Issue 5 concurrent long polls on one session. Four wait; the fifth returns immediately instead of blocking.

## 7.6 The round the person waiting reads

Checks:

1. Start a session on a prompt that takes several minutes, then poll it with `waitMs: 300000` in a loop. Expect each round to answer with a `progress.activity` that has moved on, a `progress.activityStandingMs` counting from when that line arrived, and a `waitedMs` shorter than the window.
2. Poll a turn that stays on one line for longer than the window. Expect `waitedMs` at the window, the same `progress.activity`, and `progress.activityStandingMs` grown by about the window.
3. Poll with `_meta.progressToken` set. Expect a `notifications/progress` for the standing line, one per new line, and one every 30 s carrying the standing line with how long it has stood. Set `CODEX_MCP_PROGRESS_HEARTBEAT_MS=5000` and expect the repeat every five seconds instead.

## 7.7 Why a turn is quiet

Requires a hook in the user's own `~/.codex` config; `hooks/list` on the installed CLI shows what is configured.

Checks:

1. Configure a `preToolUse` hook carrying a `statusMessage` and start a turn. Expect `progress.activity` to read that message before Codex writes its first marker, and to be replaced by the marker when it arrives — the hook line does not come back for the rest of that turn.
2. Configure a hook that refuses the command it is asked about. Expect `warnings[]` to carry an entry whose `method` is `hook/completed` and whose `message` names the event, the `blocked` status and whatever the hook said.
3. Poll with `waitMs: 300000` while such a hook fires. Expect the call to answer on the warning rather than sitting out the window, and a repeat of the same warning not to end a later wait.
4. Confirm `<STATE_DIR>/sessions/<sessionId>/events.jsonl` carries a `progress` record for every `hook/started` and `hook/completed`, whether or not it reached `warnings[]`.

## 7.8 Restart Recovery And Orphan Reaping

Requires control over the server process, so run it only when you launched codex-mcp yourself.

Steps:

1. Start a long `running` session and record its `sessionId`.
2. Note the state directory from `codex_setup` (`runtime.stateDir`) and confirm `sessions/<sessionId>/meta.json` exists.
3. Kill the codex-mcp server process, then start it again with the same `CODEX_MCP_STATE_DIR`.
4. Call `codex_session(action="get", sessionId=...)`.

Expected:

1. The session is present with `status: "abandoned"` and no `owner` — the work was cut off, nothing failed, and nobody holds it.
2. Its `activity` says what it was cut off doing.
3. `codex_reply` on it answers `SESSION_NOT_RUNNING` and names `resume`.
4. `codex_session(action="resume", sessionId=...)` answers `status: "idle"`, and `codex_reply` then carries the same thread on — the agent knows what the interrupted turn was about. Its `effective` block now carries what the rollout log says the thread runs with, which the server before the restart never recorded.
5. A completed session recovered the same way still returns its last `result`.
6. The `codex` child process from before the restart is gone; the server logs the reap count to stderr.
7. Starting a second server against the same state directory reports how many sessions belong to another running codex-mcp and keeps serving; each server lists the other's sessions and acts on none of them.

## 8. Generic Troubleshooting

## Symptom: MCP handshake fails / invalid JSON

Likely cause:

1. Server stdout polluted by shell/profile/banner text.

Fix:

1. Ensure server prints logs to stderr only.
2. On Windows, avoid profile output (`pwsh -NoProfile` if needed).
3. Set `CODEX_MCP_STDIO_MODE=strict` during verification to fail fast on blocking contamination risk (heuristic risk is still surfaced as warning).

## Symptom: Session stuck in `waiting_approval`

Likely cause:

1. `actions[]` exists but no response sent.
2. Wrong `requestId` or wrong response action.

Fix:

1. Poll again, copy exact `requestId`.
2. Use `respond_permission` / `respond_user_input` with valid payload.

## Symptom: Unexpected permission behavior

Likely cause:

1. Mismatch between intended trust model and actual `approvalPolicy`/`sandbox`.

Fix:

1. Re-run with explicit policy pair:
   - safe read path with controllable approvals: `on-request + read-only`
   - pure dialogue path (no workspace commands expected): `never + read-only`
   - strict review path: `untrusted + workspace-write`

## Symptom: Excessive token waste on Windows (PowerShell profile noise)

Likely cause:

1. PowerShell profile (`$PROFILE`) loads modules (oh-my-posh, PSReadLine, etc.) that emit stdout on every shell invocation. Codex spawns a new PowerShell process for each command, so profile output repeats on every turn — typically ~15 lines of noise per command execution.

Mitigation (code-level):

Since v0.2.0, codex-mcp includes a built-in shell noise filter that strips known PowerShell profile noise patterns (oh-my-posh, PSReadLine, module warnings, etc.) from `item/commandExecution/outputDelta` deltas before they reach the event log. This significantly reduces token waste without user intervention. The filter can be disabled with `CODEX_MCP_DISABLE_NOISE_FILTER=1` if it incorrectly strips legitimate output.

Additional fix (recommended):

1. For best results, also clean your PowerShell profile: run `pwsh -NoProfile` or temporarily rename your `$PROFILE` file. The code-level filter catches common patterns but cannot eliminate all possible profile noise.
2. Alternatively, consider setting codex's shell to `cmd.exe` or a clean PowerShell installation path without profile loading.

## Symptom: Too many polling round-trips / slow session progress

Likely cause:

1. The LLM caller polls `codex_check` every turn instead of waiting between polls. Codex tasks commonly take multiple minutes; polling every few seconds wastes tool calls.

Fix:

1. The tool descriptions for `codex`, `codex_reply`, and `codex_check` now include explicit polling frequency guidance: for `running`, wait at least 2 minutes and increase interval based on estimated task duration; only poll promptly when `status` is `waiting_approval`.
2. If your LLM still polls too frequently, add a system prompt instruction: "When using codex_check, while status is running, wait at least 2 minutes between polls and extend further for complex tasks; only poll sooner for waiting_approval."

## Symptom: Approvals auto-decline before client can respond

Likely cause:

1. The session transitions from `running` to `waiting_approval` between polling intervals. With the default `approvalTimeoutMs` of 60 seconds and the recommended ≥2-minute polling interval, the approval expires before the next poll.

Fix:

1. Set `advanced.approvalTimeoutMs` to at least 300000 (5 minutes) when using `untrusted` or `on-request` approval policies. This ensures approvals survive between polling rounds.
2. For tests that do not specifically test the approval flow, use `approvalPolicy="never"` to avoid the issue entirely.
3. If your MCP client supports it, consider implementing an adaptive polling strategy: poll at the recommended ≥2-minute interval while `running`, but if the previous poll returned `waiting_approval`, switch to ~1-second polling until the approval queue is cleared.

## 9. Test Report Template (Use This in Final Report)

```markdown
# codex-mcp E2E Report

- Client:
- Client version:
- Host OS:
- Server launch command:
- Test workspace path:

## TC Results

- TC0 Discovery:
- TC1 Async Poll:
- TC2 Approval:
- TC3 Bug Fix Loop:
- TC4 Reply Context:
- TC5 Session Management:
- TC6 Structured Output (optional):

## Key Telemetry

- Session IDs:
- Status transitions observed:
- Long polls issued and what ended each one:
- Approval actions handled (count/type):
- Errors encountered (exact `Error [CODE]`):

## Verdict

- Pass / Partial / Fail
- Blocking issues:
- Suggested fixes:
```

## 10. How to Discuss Key Points with Claude Code

If you are unsure about any critical behavior, discuss it with Claude Code explicitly with concrete payloads.

Recommended prompts:

1. `My check of session <id> returned status running with an empty actions[]. Show the exact next payload I should send and why.`
2. `For request kind=fileChange, which decisions are legal? Validate this payload before I send respond_permission.`
3. `I used acceptWithExecpolicyAmendment and got INVALID_ARGUMENT. Diagnose which field is missing from my payload.`
4. `Given this check output, determine if the session is terminal and whether I should check again.`
5. `Convert this content text JSON into a normalized report table with status transitions and approval decisions.`

Keep all discussion grounded in actual tool responses (copy the exact JSON payloads).

## Appendix A: Claude Code (Optional Client-Specific Notes)

This appendix is optional and does not replace the generic flow above.

1. In Claude Code MCP settings, prefer launch commands that avoid shell stdout noise.
2. On Windows, if command resolution needs it, use `bunx.exe` instead of `bunx`.
3. In MCP payloads, keep `cwd` as Windows path format (for example `D:\\Lab\\repo`) even if your shell prompt is `/d/Lab/repo`.
4. Recommended order:
   - validate stdout cleanliness
   - validate tools/resources
   - then run TC1 -> TC5 in order
5. If Claude UI shows mostly `content[0].text`, parse JSON text and cross-check `structuredContent` when available.

End of document.
