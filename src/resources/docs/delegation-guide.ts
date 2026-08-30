import { ADVERTISED_EFFORT_LEVELS, MAX_LONG_POLL_WAIT_MS } from "../../types/index.js";
import type { SessionDefaults } from "../../utils/session-defaults.js";
import { SESSION_DEFAULT_ENV } from "../../utils/session-defaults.js";

function delegationTaskLines(): string[] {
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
    "| Quick bug fix | `on-request` | `workspace-write` | Codex edits inside the sandbox and asks only to step outside it |",
    "| Feature implementation | `on-request` | `workspace-write` | Same, and the poll loop answers what a longer task raises |",
    "| Sensitive refactor | `untrusted` | `workspace-write` | Codex asks before each command; requires active polling |",
    "| Unattended run | `never` | `danger-full-access` | No prompts, and nothing to step outside of. `never` refuses a command that needs approval rather than granting it, so pair it with a sandbox wide enough for the work |",
    "| Network access needed | `on-request` | `danger-full-access` | Rare; avoid unless genuinely required |",
    "",
    "**Key rule:** `read-only` sandbox already prevents writes, so `approvalPolicy: 'never'` is safe with it. Avoid `untrusted` + `read-only` — every read command triggers approval for no safety gain.",
    "",
    "A `permissions` profile id replaces the `sandbox` column: it carries the sandbox and the approval policy its `[permissions.<id>]` table sets. Name one or the other, never both. `codex_setup` lists the ids this machine offers.",
    "",
  ];
}

function delegationPolicyLines(defaults: SessionDefaults): string[] {
  return [
    "## Approval policy quick guide",
    defaults.approvalPolicy || defaults.sandbox
      ? `A call that names neither starts on ${[
          defaults.approvalPolicy && `\`${defaults.approvalPolicy}\``,
          defaults.sandbox && `\`${defaults.sandbox}\``,
        ]
          .filter(Boolean)
          .join(
            " with "
          )}, which ${SESSION_DEFAULT_ENV.approvalPolicy} and ${SESSION_DEFAULT_ENV.sandbox} set.`
      : "A call states its own approval policy and sandbox; the server carries no default for either.",
    "",
    "- `never`: no interactive prompts, and no escalation either — a command that needs approval is refused with `approval required by policy, but AskForApproval is set to Never`. Pair it with a sandbox that already permits the work: `read-only` for review, `danger-full-access` for an unattended run.",
    "- `on-request`: Codex works inside the sandbox and asks when it wants to step outside it. The pragmatic choice for implementation work, and it needs a human or outer agent polling to answer.",
    "- `untrusted`: strictest interactive mode; expect frequent prompts and higher timeout sensitivity.",
    "",
    "## Who answers an approval (`approvalsReviewer`)",
    "",
    "- `user` (the default) routes every approval to you: `codex_check` reports it in `actions[]` and `respond_permission` answers it. It needs a caller polling, and an unanswered request auto-declines.",
    "- `auto_review` routes it to a Codex subagent that gathers context and applies a risk-based decision framework. Pair it with `on-request` for a run nobody watches: the turn can step outside its sandbox where the review approves, instead of being refused the way `never` refuses it.",
    '- A review that denies an action becomes `progress.activity` — "Approval auto-review denied an action of this turn" — so the next poll says why the turn did what it did.',
    `- Default approval timeout is ${defaults.approvalTimeoutMs}ms. If interactive approvals are possible, raise \`advanced.approvalTimeoutMs\` to at least 300000 so requests do not expire between normal running-session polls.`,
    "",
    "## The loop",
    `Every start returns at once. Follow the turn with \`codex_check(action="poll", waitMs=300000)\` until the status is terminal, and write \`progress.activity\` out after each round that came back still running — that line is what the person waiting reads. \`waitMs\` accepts up to ${MAX_LONG_POLL_WAIT_MS}, and the server holds the call for as long as the MCP client tolerates one.`,
    "",
    "## Effort selection",
    `The effort is any non-empty string, and each model advertises the set it takes. Codex 0.150.1 advertises ${ADVERTISED_EFFORT_LEVELS.map((level) => `\`${level}\``).join(", ")}, least to most reasoning; Codex refuses an effort the chosen model does not advertise and that refusal comes back on the turn.`,
    "- `low`: quick questions, lookups, simple edits",
    "- `medium`: multi-file changes, moderate reasoning",
    "- `high`/`xhigh`: complex architecture decisions, large refactors",
    "- `max`/`ultra`: the deepest reasoning a model that advertises them offers",
    `A codex call that names no effort runs at ${defaults.effort}, and \`${SESSION_DEFAULT_ENV.effort}\` sets which level that is.`,
    "",
    "**`minimal` and web search:** some Codex CLI builds reject `effort: 'minimal'` when the `web_search` tool is enabled. codex-mcp retries that turn at `low` and reports the switch in `compatWarnings` on the response.",
    "",
  ];
}

function delegationTroubleshootingLines(): string[] {
  return [
    "## Troubleshooting",
    "",
    "**Empty polls:** Pass `waitMs`; stop when status is terminal. See `codex-mcp:///gotchas`.",
    "",
    "**A session the server left behind:** a session whose server went away mid-turn comes back as `status: 'abandoned'`, and `codex_reply` on it answers `SESSION_NOT_RUNNING`. Call `codex_session(action=\"resume\")` to pick its thread back up — Codex restores it from its own rollout log, including a turn that never finished.",
    "",
    "**Approval timeout:** Default is 60s; infrequent polling causes silent auto-decline. See `codex-mcp:///gotchas`.",
    "",
    "## Read next",
    "- `codex-mcp:///quickstart` for the exact start -> poll -> respond loop",
    "- `codex-mcp:///config` for parameter mapping and override persistence",
    "- `codex-mcp:///gotchas` for timeout caveats",
    "",
    "## Security notes",
    "- `sandbox: 'read-only'` is the strongest isolation — blocks all writes regardless of approval policy",
    "- `approvalPolicy: 'never'` + `sandbox: 'workspace-write'` gives the agent full write access with no human oversight — use only for well-defined, low-risk tasks",
    "- `danger-full-access` allows network and system access — treat as root-equivalent",
    "- Persisted session data (events, results) may contain code snippets and file paths — stored in `~/.codex-mcp/state/`, or in `CODEX_MCP_STATE_DIR` when that variable is set (see `codex-mcp:///config`)",
    "",
  ];
}

export function buildDelegationGuideText(defaults: SessionDefaults): string {
  return [
    ...delegationTaskLines(),
    ...delegationPolicyLines(defaults),
    ...delegationTroubleshootingLines(),
  ].join("\n");
}
