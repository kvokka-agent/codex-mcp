import { spawnSync } from "child_process";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import type { SessionManager } from "../session/manager.js";
import {
  APPROVAL_POLICIES,
  SANDBOX_MODES,
  EFFORT_LEVELS,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  MAX_LONG_POLL_WAIT_MS,
  DEFAULT_IDLE_CLEANUP_MS,
  DEFAULT_RUNNING_CLEANUP_MS,
  DEFAULT_TERMINAL_CLEANUP_MS,
  ErrorCode,
} from "../types.js";
import { resolveStdioMode } from "../utils/stdio-guard.js";
import { getDefaultCodexExecutable } from "../utils/codex-executable.js";

const RESOURCE_SCHEME = "codex-mcp";

/**
 * The runtime this process is, as a name and a version.
 *
 * bun sets `process.versions.bun` and answers `process.version` with the Node
 * release it emulates, so reading `process.version` alone names the wrong
 * runtime.
 */
function describeRuntime(): string {
  const bun = process.versions.bun;
  return bun ? `bun v${bun}` : `node ${process.version}`;
}

export const RESOURCE_URIS = {
  serverInfo: `${RESOURCE_SCHEME}:///server-info`,
  compatReport: `${RESOURCE_SCHEME}:///compat-report`,
  config: `${RESOURCE_SCHEME}:///config`,
  gotchas: `${RESOURCE_SCHEME}:///gotchas`,
  quickstart: `${RESOURCE_SCHEME}:///quickstart`,
  errors: `${RESOURCE_SCHEME}:///errors`,
  delegationGuide: `${RESOURCE_SCHEME}:///delegation-guide`,
} as const;

type RuntimeMetadataProvider = Pick<
  SessionManager,
  "getActiveSessionCount" | "getObservedDefaultModel"
>;

export interface ResourceDeps {
  version: string;
  sessionManager: RuntimeMetadataProvider;
  /** Backend the server drives, as the caller resolved it; `unknown` when it could not. */
  clientMode: string;
  /** Whether the state directory was claimed at startup, so session history outlives a restart. */
  diskPersistence: boolean;
}

interface ResourceCatalogEntry {
  key: keyof typeof RESOURCE_URIS;
  name: string;
  title: string;
  description: string;
  mimeType: string;
}

const RESOURCE_CATALOG: ResourceCatalogEntry[] = [
  {
    key: "serverInfo",
    name: "server_info",
    title: "Server Info",
    description: "Server metadata and runtime capabilities",
    mimeType: "application/json",
  },
  {
    key: "compatReport",
    name: "compat_report",
    title: "Compat Report",
    description: "Cross-backend compatibility capability report",
    mimeType: "application/json",
  },
  {
    key: "config",
    name: "config",
    title: "Config Guide",
    description: "Parameter guide and config.toml mapping",
    mimeType: "text/markdown",
  },
  {
    key: "gotchas",
    name: "gotchas",
    title: "Gotchas",
    description: "Practical limits and common issues",
    mimeType: "text/markdown",
  },
  {
    key: "quickstart",
    name: "quickstart",
    title: "Quickstart",
    description: "Minimal end-to-end workflow",
    mimeType: "text/markdown",
  },
  {
    key: "errors",
    name: "errors",
    title: "Errors",
    description: "Error code reference and recovery hints",
    mimeType: "text/markdown",
  },
  {
    key: "delegationGuide",
    name: "delegation_guide",
    title: "Delegation Guide",
    description: "Best practices for delegating tasks to Codex",
    mimeType: "text/markdown",
  },
];

const ERROR_CODE_HINTS: Record<ErrorCode, string> = {
  [ErrorCode.INVALID_ARGUMENT]: "Input shape/value mismatch. Fix payload and retry.",
  [ErrorCode.SESSION_NOT_FOUND]: "Unknown sessionId or already cleaned up.",
  [ErrorCode.SESSION_HELD_BY_OTHER_SERVER]:
    "Another running codex-mcp holds this session. Its own client drives it; this one lists it and nothing more.",
  [ErrorCode.SESSION_BUSY]: "Session is running or waiting approval. Poll until idle/error.",
  [ErrorCode.SESSION_NOT_RUNNING]: "Action requires running/waiting_approval session.",
  [ErrorCode.REQUEST_NOT_FOUND]: "requestId was resolved, stale, or never existed.",
  [ErrorCode.TIMEOUT]: "Operation timed out. Retry or use a longer timeout where supported.",
  [ErrorCode.CANCELLED]: "Session was cancelled and cannot be continued.",
  [ErrorCode.APP_SERVER_START_FAILED]: "codex app-server failed to boot. Check CLI install/path.",
  [ErrorCode.THREAD_FORK_RESUME_FAILED]:
    "Forked thread could not resume in new process. Retry fork from current source session.",
  [ErrorCode.PROTOCOL_PARSE_ERROR]:
    "Non-JSON or malformed app-server line. Check shell/profile noise and transport health.",
  [ErrorCode.WRITE_QUEUE_DROPPED]:
    "stdin backpressure overflow. Reduce burst size and re-run in smaller turns.",
  [ErrorCode.EXEC_NOT_SUPPORTED]:
    "Operation not supported in exec mode. Features like threadFork and threadResume require app-server mode.",
  [ErrorCode.INTERNAL]: "Unexpected server-side failure. Inspect logs and retry safely.",
};

function asTextResource(uri: URL, text: string, mimeType: string): ReadResourceResult {
  return {
    contents: [
      {
        uri: uri.toString(),
        text,
        mimeType,
      },
    ],
  };
}

/**
 * The version the local codex CLI printed, or null when it printed no version.
 *
 * `spawnSync` reports a failed launch in `run.error` and a non-zero exit in `run.status`, and a
 * codex build that does not know `--version` writes its usage error to stderr with exit 1. Only a
 * successful run whose output carries a version number answers this question; anything else is
 * "not detected", never the first word of an error message.
 */
function detectCodexCliVersion(timeoutMs = 1500): string | null {
  try {
    const executable = getDefaultCodexExecutable();
    const run = spawnSync(executable.command, ["--version"], {
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
    });
    if (run.error || run.status !== 0) return null;
    const combined = `${run.stdout ?? ""}\n${run.stderr ?? ""}`.trim();
    const versionToken = combined.match(/v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/);
    if (!versionToken) return null;
    return versionToken[0].replace(/^v/, "");
  } catch {
    return null;
  }
}

function msToMinutes(ms: number): number {
  return Math.floor(ms / 60_000);
}

function buildConfigGuideText(): string {
  return [
    "## Top-level parameters (`codex`)",
    "",
    "- Required: `prompt`, `approvalPolicy`, `sandbox`.",
    "- Optional: `effort` (default `low`), `cwd` (default server cwd), `model` (default config.toml), `profile` (default CLI profile), `advanced`.",
    "- Prefer passing `cwd` explicitly to avoid accidental server-cwd execution.",
    "",
    "## `advanced.*` guide",
    "",
    "- `advanced.baseInstructions`: replace default system instructions for this session (default: unchanged).",
    "- `advanced.developerInstructions`: append extra developer instructions (default: none).",
    "- `advanced.personality`: optional personality preset (default: config.toml).",
    "- `advanced.summary`: summary verbosity preset for turn output (default: config.toml).",
    "- `advanced.ephemeral`: do not persist thread state remotely (default `false`).",
    "- `advanced.images`: local image file paths on the same host as codex-mcp (default: none).",
    `- \`advanced.approvalTimeoutMs\`: auto-decline timeout for approval/user-input requests (default \`${DEFAULT_APPROVAL_TIMEOUT_MS}\` ms).`,
    "- `advanced.outputSchema`: JSON Schema for structured output from `codex` turns (default: none).",
    "",
    "## `advanced.config` mapping",
    "",
    "Forwarded as `-c key=value` flags to `codex app-server`.",
    "Primitives use `String(value)`; objects/arrays use `JSON.stringify(value)`.",
    "",
    "Prefer dedicated top-level params when available:",
    "",
    "- `codex.model` -> `-c model=...`",
    "- `codex.approvalPolicy` -> `-c approval_policy=...`",
    "- `codex.sandbox` -> `-c sandbox_mode=...`",
    "- `codex.effort` -> turn-level reasoning effort (do not encode in `advanced.config`)",
    "- `codex.profile` -> `-p ...`",
    "",
    "## `codex_reply` differences",
    "",
    "- `codex_reply.outputSchema` is top-level; `codex` takes the same schema as `advanced.outputSchema`.",
    "- `codex_reply` can override `model`, `approvalPolicy`, `sandbox`, `effort`, `summary`, `personality`, and `cwd`.",
    "- `codex_reply` only works when session state is `idle` or `error`; otherwise returns `SESSION_BUSY`.",
    "- All `codex_reply` override fields default to no override when omitted.",
    "",
    "## Override persistence (`codex_reply`)",
    "",
    "- `model`, `approvalPolicy`, `sandbox`, and `cwd` update in-memory session defaults for later turns.",
    "- `effort`, `summary`, `personality`, and `outputSchema` apply to the submitted turn payload.",
    "",
    "## Environment variables",
    "",
    "Read by the codex-mcp process at startup; the MCP client sets them where it launches the server.",
    "",
    "- `CODEX_MCP_PATH`: filesystem path to the codex executable. Default: none — codex-mcp looks for `codex`, then `codex-internal`, in `PATH`.",
    "- `CODEX_MCP_COMMAND`: bare command name resolved from `PATH`. Default: none. Mutually exclusive with `CODEX_MCP_PATH`; setting both, or pointing either at something that does not resolve, stops the server at startup.",
    "- `CODEX_MCP_MODE`: forces the backend to `app-server` or `exec`. Default: probe `<codex> app-server --help` and fall back to `exec`.",
    "- `CODEX_MCP_STDIO_MODE`: `auto` (default) reports stdout contamination risk on stderr, `strict` refuses to start when stdio is attached to a terminal, `off` skips the check. An unknown value is treated as `auto`.",
    "- `CODEX_MCP_STATE_DIR`: directory holding session metadata, events and results. Default: `~/.codex-mcp/state`.",
    "- `CODEX_MCP_DISABLE_NOISE_FILTER`: set to `1` to keep shell-profile noise (oh-my-posh, PSReadLine banners) in command output events. Default: those lines are stripped.",
    "- `CODEX_MCP_DISABLE_ACTIVITY_MARKER`: set to `1` to start threads without the activity-marker instruction, which leaves `progress.activity` empty. Default: the instruction is sent, and markers are extracted and cut from the result either way.",
    '- `CODEX_MCP_PROGRESS_HEARTBEAT_MS`: how often a held `codex_check(action="poll")` repeats the standing activity line as `notifications/progress`. Default: 30000. Set 0 to send heartbeats no more, which also lets a client watchdog end a call that has been silent.',
    "",
    "## Version compatibility note",
    "",
    "Available `advanced.config` keys depend on installed Codex CLI version.",
    "To inspect your local CLI version, read `codex-mcp:///server-info` (`codexCliVersion`).",
    "",
    "## Other tool defaults (quick reference)",
    "",
    "- `codex_session.includeSensitive`: default `false`.",
    `- \`codex_check.waitMs\`: default \`0\` (answer at once), maximum \`${MAX_LONG_POLL_WAIT_MS}\`; \`poll\` only. The server cuts it further to what the MCP client tolerates in one tool call.`,
    "- `progress` is included on `codex`, `codex_reply`, and `codex_check` responses.",
    "- `advanced.developerInstructions` is appended after the server's activity-marker instruction, not instead of it.",
    "",
  ].join("\n");
}

function buildGotchasText(): string {
  return [
    "## Checking a session",
    "",
    '- Sessions are async. Check `codex_check(action="poll")` until status is `idle`/`error`/`cancelled`.',
    "- Every action answers with the same payload: `{ sessionId, status, progress, actions[], result?, interactionState, recommendedNextAction }`.",
    "- No event stream reaches the caller. Codex writes the turn's own history to its rollout log under `~/.codex/sessions/`, and codex-mcp does not repeat it.",
    `- \`waitMs\` (max ${MAX_LONG_POLL_WAIT_MS}) holds the call until the status changes, an action arrives, the turn ends, or Codex says it is working on something new. Reasoning, command output and token counters do not end the wait.`,
    "- **Check frequency guidance**: pass `waitMs: 300000` and call again with the same arguments. Each answer carries the whole state, so nothing is carried between rounds. Without `waitMs` the call answers at once and you are polling on a timer, which spends a round trip per tick.",
    "- **A round that answers with nothing new** held the call for the whole window — `waitedMs` says so — and means the turn is still on the same line, not that the poll was too long.",
    "- **A caller nobody can see**: `notifications/progress` reaches the MCP client, and a client renders it under the call it made itself, so a call made inside a subagent shows the person watching nothing. Such a caller writes the line itself after every round — the new `progress.activity`, or the standing one with `progress.activityStandingMs` in minutes — under a marker its own delegator can pick out of the output.",
    "",
    "## Approval behavior",
    "",
    `- Pending approvals/user-input auto-decline after \`approvalTimeoutMs\` (default ${DEFAULT_APPROVAL_TIMEOUT_MS} ms).`,
    "- The Codex CLI decides which commands `untrusted` prompts for, and that set moves between CLI versions: do not count on a given read-only command asking for approval.",
    `- **Timeout vs polling conflict**: The recommended polling interval for \`running\` status is >=120 seconds, but the default approval timeout is ${DEFAULT_APPROVAL_TIMEOUT_MS / 1000} seconds. If a session transitions to \`waiting_approval\` between polls, the approval will auto-decline before the client can respond. Set \`advanced.approvalTimeoutMs\` to at least 300000 (5 minutes) when using \`untrusted\` or \`on-request\` policies.`,
    "",
    "## What a check reports",
    "",
    "- `status` is one of `running`, `waiting_approval`, `idle`, `error`, `cancelled`.",
    "- `actions[]` holds what the caller must answer: approval requests and questions. Answer each by its `requestId`.",
    "- `result` arrives with the first check that sees a terminal status and carries the turn's final answer; every later check of that terminal session carries it again, so a lost answer is read back rather than written from memory.",
    "- Terminal `result.text` is the turn's final assistant message.",
    "- `result.output` is exec-mode only, where the exec client fills it with that same message. The app-server `Turn` has no text field: `result.turn` carries `turn.status` and `turn.error`, and the answer stays in `result.text`.",
    "- `progress` normalizes the current phase, the pending action count, the time of the last event, the active turn id and the token totals the backend has reported.",
    "- `progress.activity` is one line in Codex's own words saying what it is doing right now — `\"Разбираю падение теста в session-manager\"`. The server tells every thread it starts to mark such a line as `%%%ACTIVITY: ...%%%`, lifts it out of the agent-message stream and overwrites the previous one. It is a heading, not a percentage: it says nothing about how much is done, it is absent until the turn's first marker, and it is cut out of `result.text`.",
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
    "## Exec fallback mode",
    "",
    "- When the codex binary does not support `app-server`, codex-mcp falls back to `exec` mode (`codex exec --json`).",
    "- Check `codex-mcp:///server-info` `clientMode` field to detect which mode is active.",
    "- **Exec mode supports multi-turn**: first turn uses `codex exec`, subsequent turns use `codex exec resume <threadId>` for context continuity.",
    "- **Exec mode limitations**: no approval/user-input interactions, `threadFork`/`threadResume` throw `EXEC_NOT_SUPPORTED`. `sandbox`/`profile`/`cwd`/`outputSchema` overrides only apply on the first turn (exec resume does not support `-s`/`-p`/`-C`/`--output-schema`).",
    "",
  ].join("\n");
}

function buildQuickstartText(): string {
  return [
    "## Minimal flow",
    "",
    "0. Optional but recommended: run `codex_setup` first to verify the local Codex CLI, login state, and backend mode.",
    "",
    "1. Start session (`codex`)",
    "",
    "```json",
    "{",
    '  "prompt": "List files and summarize repository purpose.",',
    '  "approvalPolicy": "on-request",',
    '  "sandbox": "workspace-write",',
    '  "effort": "low",',
    '  "cwd": "D:\\\\Lab\\\\codex-mcp"',
    "}",
    "```",
    "",
    "Typical start result:",
    "",
    "```json",
    "{",
    '  "sessionId": "sess_abc123",',
    '  "threadId": "thread_xyz",',
    '  "status": "running",',
    '  "pollInterval": 120000',
    "}",
    "```",
    "",
    "2. Check where it stands (`codex_check`)",
    "",
    "```json",
    "{",
    '  "action": "poll",',
    '  "sessionId": "sess_abc123",',
    `  "waitMs": ${MAX_LONG_POLL_WAIT_MS}`,
    "}",
    "```",
    "",
    "- The answer is the session state — status, progress, actions, and the final result once the turn ends. It never carries the turn's events; those are in the Codex rollout log under `~/.codex/sessions/`.",
    "- `waitMs` holds the call until the status changes, an action arrives, the turn ends, or Codex says it is working on something new. 300000 is the round the driver is written for: long enough that a quiet turn costs twelve calls an hour, short enough that a silent stretch still gets reported.",
    "- Write `progress.activity` out after every round that came back with the turn still running, then call again. `progress.activityStandingMs` says how long that same line has stood, so a repeat reads `compiling the workspace — 15 min` rather than the same sentence twice.",
    "- Without `waitMs`, use `pollInterval` as a minimum delay: `running` >=120000ms (and usually longer for big tasks).",
    "- `waiting_approval` is the exception: poll/answer around 1000ms to avoid timeout.",
    `- When using \`untrusted\` or \`on-request\` policies, set \`advanced.approvalTimeoutMs\` to at least 300000 to prevent approvals from expiring between polling intervals.`,
    "",
    "3. If `actions[]` contains an approval request, respond:",
    "",
    "```json",
    "{",
    '  "action": "respond_permission",',
    '  "sessionId": "sess_abc123",',
    '  "requestId": "req_123",',
    '  "decision": "acceptForSession"',
    "}",
    "```",
    "",
    "4. If `actions[]` contains a user-input request, respond:",
    "",
    "```json",
    "{",
    '  "action": "respond_user_input",',
    '  "sessionId": "sess_abc123",',
    '  "requestId": "req_456",',
    '  "answers": {',
    '    "question-id": {',
    '      "answers": ["Option A"]',
    "    }",
    "  }",
    "}",
    "```",
    "",
    "5. Keep checking until terminal status (`idle`, `error`, or `cancelled`); the check that first sees it carries `result`.",
    "6. Read `progress.phase` / `progress.tokens` for a coarse execution snapshot, and `progress.activity` for what Codex says it is doing right now.",
    "",
    "## What the person waiting sees",
    "",
    "The line the caller writes between two polls is the whole of it. A client renders `notifications/progress` under the call that asked for it — the server sends one per activity line and a heartbeat every 30s while a poll is held — but only for the caller that made the call. A caller whose calls nobody watches, a subagent driving a turn for a delegator, writes each round's line into its own output under a marker its delegator reads.",
    "",
    "## Notes",
    "",
    "- `respond_permission` and `respond_user_input` answer with the same payload as `poll`, so one response shape covers the whole loop.",
    "- `recommendedNextAction` names the next call: `poll`, `respond_permission`, `respond_user_input`, or `none` when the turn is over.",
    "- If you need schema-constrained results, pass `advanced.outputSchema` (or top-level `outputSchema` in `codex_reply`) and read terminal `result.structuredOutput`.",
    "",
    "## Read next",
    "",
    "- `codex-mcp:///config`: parameter-by-parameter guide, including `advanced.*` mapping and reply overrides.",
    "- `codex-mcp:///delegation-guide`: task presets for approvalPolicy/sandbox selection.",
    "- `codex-mcp:///gotchas`: checking, approval timeout, and exec-mode failure modes.",
    "",
  ].join("\n");
}

function buildErrorsText(): string {
  const lines: string[] = [
    "## Error format",
    "",
    "Tool failures use: `Error [CODE]: message`",
    "",
    "## Codes",
    "",
  ];

  for (const code of Object.values(ErrorCode)) {
    lines.push(`- \`${code}\`: ${ERROR_CODE_HINTS[code]}`);
  }

  lines.push("");
  lines.push("## Recovery basics");
  lines.push("");
  lines.push("- `INVALID_ARGUMENT`: fix payload fields/enums and retry.");
  lines.push("- `SESSION_BUSY`: poll until terminal/idle before issuing incompatible action.");
  lines.push("- `REQUEST_NOT_FOUND`: re-poll and use latest `actions[].requestId`.");
  lines.push("- `PROTOCOL_PARSE_ERROR`: remove shell/profile stdout noise and restart session.");
  lines.push("");

  return lines.join("\n");
}

function buildDelegationGuideText(): string {
  return [
    "# Codex Delegation Guide",
    "",
    "## When to delegate",
    "- Bug investigation or fix that benefits from a second opinion",
    "- Code review (use read-only sandbox)",
    "- Refactoring or migration tasks with clear scope",
    "- Tasks where the calling agent is stuck or wants parallel work",
    "",
    "## Permission combinations by task type",
    "",
    "| Task | approvalPolicy | sandbox | Notes |",
    "|------|---------------|---------|-------|",
    "| Code review / analysis | `never` | `read-only` | Safe: sandbox blocks writes, no approval needed |",
    "| Quick bug fix | `on-failure` | `workspace-write` | Auto-approves unless error |",
    "| Feature implementation | `on-failure` | `workspace-write` | Async mode recommended for longer tasks |",
    "| Sensitive refactor | `on-request` | `workspace-write` | Codex asks before each action; requires active polling |",
    "| Full autonomy | `never` | `workspace-write` | No guardrails — only for well-scoped, trusted tasks |",
    "| Network access needed | `on-failure` | `danger-full-access` | Rare; avoid unless genuinely required |",
    "",
    "**Key rule:** `read-only` sandbox already prevents writes, so `approvalPolicy: 'never'` is safe with it. Avoid `untrusted` + `read-only` — every read command triggers approval for no safety gain.",
    "",
    "## Approval policy quick guide",
    "- `never`: no interactive prompts. Best for read-only review or tightly scoped trusted tasks.",
    "- `on-failure`: pragmatic default for implementation work when you still want some safety rails.",
    "- `on-request`: use when a human or outer agent will actively poll and answer approvals.",
    "- `untrusted`: strictest interactive mode; expect frequent prompts and higher timeout sensitivity.",
    `- Default approval timeout is ${DEFAULT_APPROVAL_TIMEOUT_MS}ms. If interactive approvals are possible, raise \`advanced.approvalTimeoutMs\` to at least 300000 so requests do not expire between normal running-session polls.`,
    "",
    "## The loop",
    `Every start returns at once. Follow the turn with \`codex_check(action="poll", waitMs=300000)\` until the status is terminal, and write \`progress.activity\` out after each round that came back still running — that line is what the person waiting reads. \`waitMs\` accepts up to ${MAX_LONG_POLL_WAIT_MS}, and the server holds the call for as long as the MCP client tolerates one.`,
    "",
    "## Effort selection",
    "Levels, least to most reasoning: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`. The value is passed to the Codex CLI as the turn reasoning effort.",
    "- `none`: least reasoning; fully specified, mechanical steps",
    "- `minimal`: small lookups and single-file edits",
    "- `low` (default): quick questions, lookups, simple edits",
    "- `medium`: multi-file changes, moderate reasoning",
    "- `high`/`xhigh`: complex architecture decisions, large refactors",
    "",
    "**`minimal` and web search:** some Codex CLI builds reject `effort: 'minimal'` when the `web_search` tool is enabled. codex-mcp retries that turn at `low` and reports the switch in `compatWarnings` on the response.",
    "",
    "## Troubleshooting",
    "",
    "**Empty polls:** Pass `waitMs`; stop when status is terminal. See `codex-mcp:///gotchas`.",
    "",
    "**Session not found after restart:** Sessions survive a restart as readable history, not as live sessions. Previously-running ones surface as `status: 'error'` with a restart reason, and `codex_reply` on any recovered session fails with `SESSION_NOT_FOUND`. Start a new session instead.",
    "",
    "**Approval timeout:** Default is 60s; infrequent polling causes silent auto-decline. See `codex-mcp:///gotchas`.",
    "",
    "## Read next",
    "- `codex-mcp:///quickstart` for the exact start -> poll -> respond loop",
    "- `codex-mcp:///config` for parameter mapping and override persistence",
    "- `codex-mcp:///gotchas` for timeout and exec-mode caveats",
    "",
    "## Security notes",
    "- `sandbox: 'read-only'` is the strongest isolation — blocks all writes regardless of approval policy",
    "- `approvalPolicy: 'never'` + `sandbox: 'workspace-write'` gives the agent full write access with no human oversight — use only for well-defined, low-risk tasks",
    "- `danger-full-access` allows network and system access — treat as root-equivalent",
    "- Persisted session data (events, results) may contain code snippets and file paths — stored in `~/.codex-mcp/state/`, or in `CODEX_MCP_STATE_DIR` when that variable is set (see `codex-mcp:///config`)",
    "",
  ].join("\n");
}

function buildCompatReport(deps: ResourceDeps, codexCliVersion: string | null): string {
  const runtimeWarnings: string[] = [];
  if (!codexCliVersion) {
    runtimeWarnings.push("Unable to detect local codex CLI version from PATH.");
  }
  if (!deps.diskPersistence) {
    runtimeWarnings.push(
      "Disk persistence is off: sessions are held in memory only and are lost when the server restarts."
    );
  }
  return JSON.stringify(
    {
      schemaVersion: "1.0.0",
      features: {
        respondPermission: true,
        respondApprovalAlias: false,
        respondUserInput: true,
        sessionInterrupt: true,
        statusOnlyCheck: true,
        checkLongPoll: true,
        compatWarnings: true,
        diskPersistence: deps.diskPersistence,
        diskResume: deps.diskPersistence,
        dynamicTools: false,
        toolPermissionControl: false,
      },
      featureNotes: {
        diskPersistence: deps.diskPersistence
          ? "Session metadata, events and results are written under the state directory and read back on every listing, so every server sharing the directory sees the same sessions."
          : "The state directory could not be written, so sessions are held in memory only and a restart drops their history.",
        diskResume: deps.diskPersistence
          ? 'A session whose server went away mid-turn comes back as status `abandoned` and carries the last line it said it was doing. `codex_session(action="resume")` starts a codex process for it and restores the thread from Codex\'s rollout log; `codex_reply` then carries it on. Replying to a session that has not been resumed fails with SESSION_NOT_RUNNING.'
          : "Without a state directory nothing survives a restart, so there is nothing to resume.",
      },
      recommendedSettings: {
        codexCheck: {
          waitMs: MAX_LONG_POLL_WAIT_MS,
        },
      },
      toolCounts: {
        core: 5,
      },
      runtimeWarnings,
      detectedMismatches: [],
      runtime: {
        codexMcpVersion: deps.version,
        codexCliVersion,
        activeSessions: deps.sessionManager.getActiveSessionCount(),
      },
    },
    null,
    2
  );
}

export function registerResources(
  server: Pick<McpServer, "registerResource">,
  deps: ResourceDeps
): void {
  let codexCliVersionCache: string | null | undefined;
  const getCodexCliVersion = (): string | null => {
    if (codexCliVersionCache !== undefined) return codexCliVersionCache;
    codexCliVersionCache = detectCodexCliVersion();
    return codexCliVersionCache;
  };

  const byKey = new Map(RESOURCE_CATALOG.map((entry) => [entry.key, entry]));

  const serverInfoMeta = byKey.get("serverInfo")!;
  const serverInfoUri = new URL(RESOURCE_URIS.serverInfo);
  server.registerResource(
    serverInfoMeta.name,
    serverInfoUri.toString(),
    {
      title: serverInfoMeta.title,
      description: serverInfoMeta.description,
      mimeType: serverInfoMeta.mimeType,
    },
    () => {
      const observedModel = deps.sessionManager.getObservedDefaultModel();
      return asTextResource(
        serverInfoUri,
        JSON.stringify(
          {
            name: "codex-mcp",
            version: deps.version,
            codexCliVersion: getCodexCliVersion(),
            clientMode: deps.clientMode,
            runtime: describeRuntime(),
            platform: process.platform,
            arch: process.arch,
            stdioMode: resolveStdioMode().mode,
            supportedApprovalPolicies: APPROVAL_POLICIES,
            supportedSandboxModes: SANDBOX_MODES,
            supportedEffortLevels: EFFORT_LEVELS,
            activeSessions: deps.sessionManager.getActiveSessionCount(),
            defaultModel: observedModel,
            defaultModelSource: observedModel ? "session-default" : "unknown",
            resources: RESOURCE_CATALOG.map((entry) => ({
              uri: RESOURCE_URIS[entry.key],
              title: entry.title,
              mimeType: entry.mimeType,
              description: entry.description,
            })),
          },
          null,
          2
        ),
        "application/json"
      );
    }
  );

  const compatReportMeta = byKey.get("compatReport")!;
  const compatReportUri = new URL(RESOURCE_URIS.compatReport);
  server.registerResource(
    compatReportMeta.name,
    compatReportUri.toString(),
    {
      title: compatReportMeta.title,
      description: compatReportMeta.description,
      mimeType: compatReportMeta.mimeType,
    },
    () =>
      asTextResource(
        compatReportUri,
        buildCompatReport(deps, getCodexCliVersion()),
        "application/json"
      )
  );

  const configMeta = byKey.get("config")!;
  const configUri = new URL(RESOURCE_URIS.config);
  server.registerResource(
    configMeta.name,
    configUri.toString(),
    {
      title: configMeta.title,
      description: configMeta.description,
      mimeType: configMeta.mimeType,
    },
    () => asTextResource(configUri, buildConfigGuideText(), "text/markdown")
  );

  const gotchasMeta = byKey.get("gotchas")!;
  const gotchasUri = new URL(RESOURCE_URIS.gotchas);
  server.registerResource(
    gotchasMeta.name,
    gotchasUri.toString(),
    {
      title: gotchasMeta.title,
      description: gotchasMeta.description,
      mimeType: gotchasMeta.mimeType,
    },
    () => asTextResource(gotchasUri, buildGotchasText(), "text/markdown")
  );

  const quickstartMeta = byKey.get("quickstart")!;
  const quickstartUri = new URL(RESOURCE_URIS.quickstart);
  server.registerResource(
    quickstartMeta.name,
    quickstartUri.toString(),
    {
      title: quickstartMeta.title,
      description: quickstartMeta.description,
      mimeType: quickstartMeta.mimeType,
    },
    () => asTextResource(quickstartUri, buildQuickstartText(), "text/markdown")
  );

  const errorsMeta = byKey.get("errors")!;
  const errorsUri = new URL(RESOURCE_URIS.errors);
  server.registerResource(
    errorsMeta.name,
    errorsUri.toString(),
    {
      title: errorsMeta.title,
      description: errorsMeta.description,
      mimeType: errorsMeta.mimeType,
    },
    () => asTextResource(errorsUri, buildErrorsText(), "text/markdown")
  );

  const delegationGuideMeta = byKey.get("delegationGuide")!;
  const delegationGuideUri = new URL(RESOURCE_URIS.delegationGuide);
  server.registerResource(
    delegationGuideMeta.name,
    delegationGuideUri.toString(),
    {
      title: delegationGuideMeta.title,
      description: delegationGuideMeta.description,
      mimeType: delegationGuideMeta.mimeType,
    },
    () => asTextResource(delegationGuideUri, buildDelegationGuideText(), "text/markdown")
  );
}
