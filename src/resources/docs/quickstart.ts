import { MAX_LONG_POLL_WAIT_MS } from "../../types.js";
import type { SessionDefaults } from "../../utils/session-defaults.js";

function quickstartStartLines(): string[] {
  return [
    "## Minimal flow",
    "",
    "0. Optional but recommended: run `codex_setup` first to verify the local Codex CLI, its version, and login state.",
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
  ];
}

function quickstartCheckLines(defaults: SessionDefaults): string[] {
  return [
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
    "- Write every new `warnings[]` entry out too: it is what a turn that is answering nothing says about itself, and the activity line stays where it was while one stands.",
    "- Write `progress.activity` out after every round that came back with the turn still running, then call again. `progress.activityStandingMs` says how long that same line has stood, so a repeat reads `compiling the workspace — 15 min` rather than the same sentence twice.",
    "- Without `waitMs`, use `pollInterval` as a minimum delay: `running` >=120000ms (and usually longer for big tasks).",
    "- `waiting_approval` is the exception: poll/answer around 1000ms to avoid timeout.",
    `- A pending approval auto-declines after ${defaults.approvalTimeoutMs}ms. Under \`untrusted\` or \`on-request\`, that has to outlive the gap between two polls: raise \`advanced.approvalTimeoutMs\` to at least 300000 where it does not.`,
    "",
  ];
}

function quickstartRespondLines(): string[] {
  return [
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
  ];
}

function quickstartClosingLines(): string[] {
  return [
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
    "- `codex-mcp:///gotchas`: checking, approval timeout, and the Codex CLI floor.",
    "",
  ];
}

export function buildQuickstartText(defaults: SessionDefaults): string {
  return [
    ...quickstartStartLines(),
    ...quickstartCheckLines(defaults),
    ...quickstartRespondLines(),
    ...quickstartClosingLines(),
  ].join("\n");
}
