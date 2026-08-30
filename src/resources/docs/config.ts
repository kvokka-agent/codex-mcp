import {
  ADVERTISED_EFFORT_LEVELS,
  APPROVAL_POLICIES,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  DEFAULT_EFFORT_LEVEL,
  MAX_LONG_POLL_WAIT_MS,
  SANDBOX_MODES,
} from "../../types.js";
import type { SessionDefaults } from "../../utils/session-defaults.js";
import { SESSION_DEFAULT_ENV } from "../../utils/session-defaults.js";

function configTopLevelLines(defaults: SessionDefaults): string[] {
  return [
    "## Top-level parameters (`codex`)",
    "",
    `- Required: ${["`prompt`", defaults.approvalPolicy ? "" : "`approvalPolicy`"].filter(Boolean).join(", ")}.`,
    `- Optional: ${defaults.approvalPolicy ? `\`approvalPolicy\` (default \`${defaults.approvalPolicy}\`), ` : ""}\`sandbox\`${defaults.sandbox ? ` (default \`${defaults.sandbox}\`)` : ""}, \`permissions\`, \`approvalsReviewer\` (default \`user\`), \`effort\` (default \`${defaults.effort}\`), \`cwd\` (default server cwd), \`model\` (default ${defaults.model ? `\`${defaults.model}\`` : "config.toml"}), \`profile\` (default CLI profile), \`advanced\`.`,
    defaults.sandbox
      ? "- Name `sandbox` or `permissions`, never both. A call that names neither starts on the sandbox `" +
        defaults.sandbox +
        "`."
      : "- Name `sandbox` or `permissions`: the call carries one of the two, and never both.",
    "- `permissions`: a named profile id such as `:read-only` or `:workspace`, from a `[permissions.<id>]` table of the Codex config. It carries the sandbox and the approval policy the profile sets, and `codex_setup` lists the ids this machine offers. An id it does not offer is refused before the thread starts, with the list of the ids it does.",
    "- Prefer passing `cwd` explicitly to avoid accidental server-cwd execution.",
    `- \`approvalsReviewer\`: who decides an approval the turn raises. \`user\` reports it in \`codex_check.actions[]\` for you to answer; \`auto_review\` hands it to a Codex subagent that decides it inside Codex, and a review that denies an action arrives as \`progress.activity\` and as an \`approval_result\` record in the session's event log.`,
    "",
    "## `advanced.*` guide",
    "",
    "- `advanced.baseInstructions`: replace default system instructions for this session (default: unchanged).",
    "- `advanced.developerInstructions`: append extra developer instructions (default: none).",
    "- `advanced.personality`: optional personality preset (default: config.toml).",
    "- `advanced.summary`: summary verbosity preset for turn output (default: config.toml).",
    "- `advanced.ephemeral`: do not persist thread state remotely (default `false`).",
    "- `advanced.images`: local image file paths on the same host as codex-mcp (default: none).",
    `- \`advanced.approvalTimeoutMs\`: auto-decline timeout for approval/user-input requests (default \`${defaults.approvalTimeoutMs}\` ms).`,
    "- `advanced.outputSchema`: JSON Schema for structured output from `codex` turns (default: none).",
    "",
  ];
}

function configMappingLines(): string[] {
  return [
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
    "- `codex.permissions` -> `thread/start.permissions`; no `-c` flag, and no `-c sandbox_mode=` is sent with it",
    "- `codex.effort` -> turn-level reasoning effort (do not encode in `advanced.config`)",
    "- `codex.profile` -> `-p ...`",
    "",
    "## `codex_reply` differences",
    "",
    "- `codex_reply.outputSchema` is top-level; `codex` takes the same schema as `advanced.outputSchema`.",
    "- `codex_reply` can override `model`, `approvalPolicy`, `approvalsReviewer`, `sandbox` or `permissions`, `effort`, `summary`, `personality`, and `cwd`.",
    "- `codex_reply` only works when session state is `idle` or `error`; otherwise returns `SESSION_BUSY`.",
    "- All `codex_reply` override fields default to no override when omitted.",
    "",
    "## Override persistence (`codex_reply`)",
    "",
    "- `model`, `approvalPolicy`, `approvalsReviewer`, `sandbox`, `permissions`, and `cwd` update in-memory session defaults for later turns.",
    "- `effort`, `summary`, `personality`, and `outputSchema` apply to the submitted turn payload.",
    "",
  ];
}

function configEnvironmentLines(defaults: SessionDefaults): string[] {
  return [
    "## Environment variables",
    "",
    "Read by the codex-mcp process at startup; the MCP client sets them where it launches the server.",
    "",
    "- `CODEX_MCP_PATH`: filesystem path to the codex executable. Default: none — codex-mcp looks for `codex`, then `codex-internal`, in `PATH`.",
    "- `CODEX_MCP_COMMAND`: bare command name resolved from `PATH`. Default: none. Mutually exclusive with `CODEX_MCP_PATH`; setting both, or pointing either at something that does not resolve, stops the server at startup.",
    "- `CODEX_MCP_STDIO_MODE`: `auto` (default) reports stdout contamination risk on stderr, `strict` refuses to start when stdio is attached to a terminal, `off` skips the check. An unknown value is treated as `auto`.",
    "- `CODEX_MCP_STATE_DIR`: directory holding session metadata, events and results. Default: `~/.codex-mcp/state`.",
    "- `CODEX_MCP_DISABLE_NOISE_FILTER`: set to `1` to keep shell-profile noise (oh-my-posh, PSReadLine banners) in command output events. Default: those lines are stripped.",
    "- `CODEX_MCP_DISABLE_ACTIVITY_MARKER`: set to `1` to start threads without the activity-marker instruction, which leaves `progress.activity` empty. Default: the instruction is sent, and markers are extracted and cut from the result either way.",
    '- `CODEX_MCP_PROGRESS_HEARTBEAT_MS`: how often a held `codex_check(action="poll")` repeats the standing activity line as `notifications/progress`. Default: 30000. Set 0 to send heartbeats no more, which also lets a client watchdog end a call that has been silent.',
    `- \`${SESSION_DEFAULT_ENV.model}\`: model a \`codex\` call that names none starts on. Default: none — the Codex CLI reads its own config.toml. Now: ${defaults.model ?? "unset"}.`,
    `- \`${SESSION_DEFAULT_ENV.effort}\`: reasoning effort a \`codex\` call that names none starts on. Any non-empty value; Codex 0.150.1 advertises ${ADVERTISED_EFFORT_LEVELS.join(", ")}, and Codex refuses one the chosen model does not advertise. Default: ${DEFAULT_EFFORT_LEVEL}. Now: ${defaults.effort}.`,
    `- \`${SESSION_DEFAULT_ENV.approvalTimeoutMs}\`: milliseconds a pending approval waits before it auto-declines, where the call names no \`advanced.approvalTimeoutMs\`. Default: ${DEFAULT_APPROVAL_TIMEOUT_MS}. Now: ${defaults.approvalTimeoutMs}.`,
    `- \`${SESSION_DEFAULT_ENV.approvalPolicy}\`: approval policy a \`codex\` call that names none starts on, one of ${APPROVAL_POLICIES.join(", ")}. Default: none, which keeps \`approvalPolicy\` a required parameter. Now: ${defaults.approvalPolicy ?? "unset"}.`,
    `- \`${SESSION_DEFAULT_ENV.sandbox}\`: sandbox a \`codex\` call that names none starts on, one of ${SANDBOX_MODES.join(", ")}. Default: none, which keeps \`sandbox\` a required parameter. Now: ${defaults.sandbox ?? "unset"}.`,
    "",
    "A value none of those five can be read as stops the server at startup, naming the variable.",
    "",
  ];
}

function configReferenceLines(): string[] {
  return [
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
  ];
}

export function buildConfigGuideText(defaults: SessionDefaults): string {
  return [
    ...configTopLevelLines(defaults),
    ...configMappingLines(),
    ...configEnvironmentLines(defaults),
    ...configReferenceLines(),
  ].join("\n");
}
