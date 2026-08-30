import { ErrorCode } from "../../types.js";

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
  [ErrorCode.INTERNAL]: "Unexpected server-side failure. Inspect logs and retry safely.",
};

export function buildErrorsText(): string {
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
