import {
  DEFAULT_IDLE_CLEANUP_MS,
  DEFAULT_RUNNING_CLEANUP_MS,
  DEFAULT_TERMINAL_CLEANUP_MS,
  MAX_LONG_POLL_WAIT_MS,
} from "../../types.js";
import { MIN_CODEX_CLI_VERSION } from "../../utils/codex-version.js";
import type { SessionDefaults } from "../../utils/session-defaults.js";

function msToMinutes(ms: number): number {
  return Math.floor(ms / 60_000);
}

export function buildGotchasText(defaults: SessionDefaults): string {
  return [
    "## Checking a session",
    "",
    '- Sessions are async. Check `codex_check(action="poll")` until status is `idle`/`error`/`cancelled`.',
    "- Every action answers with the same payload: `{ sessionId, status, progress, actions[], warnings[], result?, interactionState, recommendedNextAction }`.",
    "- No event stream reaches the caller. Codex writes the turn's own history to its rollout log under `~/.codex/sessions/`, and codex-mcp does not repeat it.",
    `- \`waitMs\` (max ${MAX_LONG_POLL_WAIT_MS}) holds the call until the status changes, an action arrives, the turn ends, a new warning arrives, or Codex says it is working on something new. Reasoning, command output and token counters do not end the wait.`,
    "- **Check frequency guidance**: pass `waitMs: 300000` and call again with the same arguments. Each answer carries the whole state, so nothing is carried between rounds. Without `waitMs` the call answers at once and you are polling on a timer, which spends a round trip per tick.",
    "- **A round that answers with nothing new** held the call for the whole window — `waitedMs` says so — and means the turn is still on the same line, not that the poll was too long.",
    "- **A caller nobody can see**: `notifications/progress` reaches the MCP client, and a client renders it under the call it made itself, so a call made inside a subagent shows the person watching nothing. Such a caller writes the line itself after every round — the new `progress.activity`, or the standing one with `progress.activityStandingMs` in minutes — under a marker its own delegator can pick out of the output.",
    "",
    "## Approval behavior",
    "",
    `- Pending approvals/user-input auto-decline after \`approvalTimeoutMs\` (default ${defaults.approvalTimeoutMs} ms).`,
    "- The Codex CLI decides which commands `untrusted` prompts for, and that set moves between CLI versions: do not count on a given read-only command asking for approval.",
    `- **Timeout vs polling conflict**: The recommended polling interval for \`running\` status is >=120 seconds, but the default approval timeout is ${defaults.approvalTimeoutMs / 1000} seconds. If that is shorter than the gap between two polls, a session that transitions to \`waiting_approval\` between them auto-declines before the client can respond: raise \`advanced.approvalTimeoutMs\` to at least 300000 (5 minutes) under \`untrusted\` or \`on-request\`.`,
    "",
    "## What a check reports",
    "",
    "- `status` is one of `running`, `waiting_approval`, `idle`, `error`, `cancelled`.",
    "- `actions[]` holds what the caller must answer: approval requests and questions. Answer each by its `requestId`.",
    "- `result` arrives with the first check that sees a terminal status and carries the turn's final answer; every later check of that terminal session carries it again, so a lost answer is read back rather than written from memory.",
    "- Terminal `result.text` is the turn's final assistant message.",
    "- The app-server `Turn` carries no text field: `result.turn` holds `turn.status` and `turn.error`, and the answer stays in `result.text`.",
    "- `progress` normalizes the current phase, the pending action count, the time of the last event, the active turn id and the token totals the backend has reported.",
    "- `progress.activity` is one line in Codex's own words saying what it is doing right now — `\"Разбираю падение теста в session-manager\"`. The server tells every thread it starts to mark such a line as `%%%ACTIVITY: ...%%%`, lifts it out of the agent-message stream and overwrites the previous one. It is a heading, not a percentage: it says nothing about how much is done, it is absent until the turn's first marker, and it is cut out of `result.text`.",
    "- `warnings[]` says why a turn is producing no output: a backend `warning` or `guardianWarning`, a `model/safetyBuffering/updated` naming the reasons the model's output is held back, or a hook of the user's own codex config that blocked, failed or was stopped. `progress.activity` is what the turn is doing; a warning is what stands in its way. The five newest are kept, and a hook that wrote a display line stands in `progress.activity` while the turn has written no marker.",
    "- A retryable interruption keeps the session `running` and shows up as a phase that does not advance; a failure the backend will not retry moves the session to `error`, where `result.error` says what happened.",
    "",
    "## Windows shell/profile issues",
    "",
    "- On Windows wrappers, prefer `pwsh -NoProfile` to avoid profile/banner stdout noise.",
    "- Profile noise can affect both MCP handshake and agent-internal command turns.",
    "- For mojibake, enforce UTF-8 shell output (`chcp 65001`, `$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()`).",
    "- Prefer host-native absolute paths for `cwd` and file args (Windows example: `D:\\\\Lab\\\\codex-mcp`).",
    "",
    "## Lifecycle and cleanup",
    "",
    `- Idle sessions are auto-cleaned after ${msToMinutes(DEFAULT_IDLE_CLEANUP_MS)} minutes.`,
    `- Running/waiting sessions are auto-cleaned after ${msToMinutes(DEFAULT_RUNNING_CLEANUP_MS)} minutes.`,
    `- Error/cancelled sessions are retained for about ${msToMinutes(DEFAULT_TERMINAL_CLEANUP_MS)} minutes, then removed.`,
    '- Use `codex_session(action="clean")` to batch-remove idle/error/cancelled sessions on demand.',
    "- Session metadata/results are persisted for recovery; manual clean can also delete those disk artifacts.",
    "",
    "## Capacity",
    "",
    "- codex-mcp does not hard-code a strict concurrent-session cap.",
    "- Practical limit depends on machine resources and child-process load.",
    "",
    "## The Codex CLI",
    "",
    `- codex-mcp drives \`codex app-server\`, which the Codex CLI carries from ${MIN_CODEX_CLI_VERSION}. An older binary starts no session; \`codex_setup\` reports the version it found.`,
    "",
  ].join("\n");
}
