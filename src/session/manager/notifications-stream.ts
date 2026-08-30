/** The notifications that carry a turn's stream rather than its lifecycle. */
import type { SessionInfo } from "../../types/index.js";
import {
  bufferingWarningMessage,
  displayText,
  hookActivityLine,
  hookWarningMessage,
  MAX_SESSION_WARNINGS,
} from "../warnings.js";
import type { SessionRuntime } from "./core.js";
import {
  markerStands,
  notifyActivityListeners,
  recordActivity,
  recordEvent,
  scannerOf,
} from "./events.js";
import { isRecord, normalizeOptionalString } from "./read.js";
import { notifyWaiters } from "./waiters.js";

// ── Shell noise filtering ────────────────────────────────────────────
// On Windows, PowerShell profile output (oh-my-posh, PSReadLine, etc.) leaks
// into every command execution, wasting tokens in MCP client contexts.
// These patterns are stripped from COMMAND_OUTPUT_DELTA events before they
// reach the event log.  Disable with CODEX_MCP_DISABLE_NOISE_FILTER=1.
const NOISE_FILTER_ENABLED = process.env.CODEX_MCP_DISABLE_NOISE_FILTER !== "1";

const WINDOWS_TERMINAL_INTEGRATION_PREFIX = `${String.fromCharCode(0x1b)}]633;`;

const SHELL_NOISE_LINE_PATTERNS: RegExp[] = [
  // oh-my-posh migration / update prompts
  /oh-my-posh/i,
  // PSReadLine configuration errors
  /PSReadLine/i,
  /Set-PSReadLineOption/i,
  // PowerShell module auto-import warnings
  /^WARNING:\s/,
  // PowerShell profile loading messages
  /Loading personal and system profiles/i,
  // conda/mamba init noise that leaks through profiles
  /^(\(base\)|\(conda\))/,
  // Common "new version available" nag lines from profile tools
  /A new version of .+ is available/i,
];

/**
 * Strip known shell profile noise lines from a command output delta.
 * Returns the cleaned string, or empty string if everything was noise.
 */
function stripShellNoise(delta: string): string {
  if (!NOISE_FILTER_ENABLED) return delta;
  const lines = delta.split("\n");
  const cleaned = lines.filter(
    (line) =>
      !line.includes(WINDOWS_TERMINAL_INTEGRATION_PREFIX) &&
      !SHELL_NOISE_LINE_PATTERNS.some((re) => re.test(line))
  );
  // Preserve original trailing newline structure
  if (cleaned.length === 0) return "";
  return cleaned.join("\n");
}

/** `item/agentMessage/delta` — the stream the activity marker is lifted out of. */
export function onAgentMessageDelta(
  runtime: SessionRuntime,
  session: SessionInfo,
  method: string,
  p: Record<string, unknown>
): void {
  if (typeof p.delta === "string") {
    let lines = 0;
    for (const line of scannerOf(session).push(p.delta)) {
      recordActivity(session, line, normalizeOptionalString(p.itemId));
      lines += 1;
    }
    // A new line is what the person waiting reads, so the poll holding
    // this session answers with it rather than sitting out its window.
    if (lines > 0) notifyWaiters(runtime, session.sessionId);
  }
  recordEvent(session, "output", { method, delta: p.delta, itemId: p.itemId });
}

/** `item/commandExecution/outputDelta` — the stream shell profile noise is cut from. */
export function onCommandOutputDelta(
  session: SessionInfo,
  method: string,
  p: Record<string, unknown>
): void {
  // Filter known shell profile noise (PowerShell oh-my-posh, PSReadLine, etc.)
  if (typeof p.delta === "string") {
    const cleaned = stripShellNoise(p.delta);
    if (cleaned.length === 0) return; // entire delta was noise, skip event
    recordEvent(session, "progress", { method, ...p, delta: cleaned });
  } else {
    recordEvent(session, "progress", { method, ...p });
  }
}

/**
 * `warning` and `guardianWarning` — free text the backend wrote for the person.
 *
 * There is no code and no structure on either notification to act on, so the
 * message is the whole of it and it goes where a waiting caller reads it.
 */
export function onWarningNotification(
  runtime: SessionRuntime,
  session: SessionInfo,
  method: string,
  p: Record<string, unknown>
): void {
  recordEvent(session, "progress", { method, ...p });
  recordWarning(runtime, session, method, displayText(p.message));
}

/**
 * `model/safetyBuffering/updated` — a named reason the turn is answering nothing.
 *
 * `showBufferingUi` is the backend deciding whether the person is meant to be
 * told, so a buffering it marks silent stays in the event log and out of the
 * check answer.
 */
export function onSafetyBufferingUpdated(
  runtime: SessionRuntime,
  session: SessionInfo,
  method: string,
  p: Record<string, unknown>
): void {
  recordEvent(session, "progress", { method, ...p });
  if (p.showBufferingUi !== true) return;
  recordWarning(runtime, session, method, bufferingWarningMessage(p));
}

/**
 * `hook/started` and `hook/completed` — the intervals a hook of the user's own
 * codex config holds the turn for.
 *
 * Two things come off a run. A hook that blocked, failed or was stopped is a
 * turn held with nothing else said about why, so it becomes a warning. The
 * `statusMessage` its author wrote is a line for display, so it stands where
 * `progress.activity` stands — but only while the turn has written no marker
 * of its own, because a hook says nothing about what the model is doing.
 */
export function onHookNotification(
  runtime: SessionRuntime,
  session: SessionInfo,
  method: string,
  p: Record<string, unknown>
): void {
  recordEvent(session, "progress", { method, ...p });
  if (!isRecord(p.run)) return;
  const run = p.run;
  recordWarning(runtime, session, method, hookWarningMessage(run));

  const line = hookActivityLine(run);
  if (line === undefined || markerStands(session)) return;
  if (session.progressState?.activity === line) return;
  recordActivity(session, line, normalizeOptionalString(run.id), true);
  notifyWaiters(runtime, session.sessionId);
}

/**
 * Keep one thing the backend said about a quiet turn, and wake what is waiting.
 *
 * The backend repeating itself said nothing new: the standing entry keeps its
 * place with a fresh instant, `warningSeq` does not move, and the poll holding
 * this session sleeps on. Anything new moves `warningSeq`, which `signalOf`
 * carries, so the poll answers with it — a warning is the only thing that will
 * be said while a turn stalls, and a caller holding a long window would
 * otherwise never learn why.
 */
function recordWarning(
  runtime: SessionRuntime,
  session: SessionInfo,
  method: string,
  message?: string
): void {
  if (message === undefined) return;
  const warnings = session.warnings ?? [];
  const standing = warnings[warnings.length - 1];
  const at = new Date().toISOString();
  if (standing?.method === method && standing.message === message) {
    standing.at = at;
    return;
  }
  warnings.push({ method, message, at });
  while (warnings.length > MAX_SESSION_WARNINGS) warnings.shift();
  session.warnings = warnings;
  session.warningSeq = (session.warningSeq ?? 0) + 1;
  // The same listeners the activity line reaches: a held poll shows the person
  // waiting why nothing is arriving, without waiting for the poll to return.
  notifyActivityListeners(session, message);
  notifyWaiters(runtime, session.sessionId);
}

/**
 * The line a poll reports for a review that did not approve, keyed by status.
 *
 * `approved` is absent: the action went through, and overwriting the turn's own
 * activity line to say so would bury what the work is on.
 */
const AUTO_REVIEW_ACTIVITY: Record<string, string> = {
  denied: "Approval auto-review denied an action of this turn",
  timedOut: "Approval auto-review timed out on an action of this turn",
  aborted: "Approval auto-review was aborted on an action of this turn",
};

/**
 * `item/autoApprovalReview/completed` — the auto_review subagent decided an
 * approval this server never saw.
 *
 * Only `review.status` is read. The schema marks `GuardianApprovalReview`
 * `[UNSTABLE]`, "This shape is expected to change soon", so `rationale`,
 * `riskLevel` and `userAuthorization` reach `events.jsonl` with the rest of the
 * raw params and no branch here depends on them.
 *
 * A status other than `approved` is why the turn did what it did, so it becomes
 * the activity line a poll answers with as well as an `approval_result` record.
 */
export function onAutoApprovalReviewCompleted(
  session: SessionInfo,
  method: string,
  p: Record<string, unknown>
): void {
  const review = p.review as Record<string, unknown> | undefined;
  const status = normalizeOptionalString(review?.status);
  recordEvent(session, "approval_result", {
    method,
    ...p,
    reviewer: "auto_review",
    status,
  });
  const line = status === undefined ? undefined : AUTO_REVIEW_ACTIVITY[status];
  if (line) recordActivity(session, line);
}
