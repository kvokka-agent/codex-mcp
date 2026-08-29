/**
 * What the backend says about a turn that is producing no output.
 *
 * `codex app-server` names four such things on the wire — a `warning`, a
 * `guardianWarning`, a `model/safetyBuffering/updated` and a hook run that
 * blocked, failed or was stopped. This module turns each into the one line a
 * caller reads. Every line here is text this server did not write, so it goes
 * through `redactPaths` before it can reach a tool response.
 */

import { redactPaths } from "../utils/redact.js";
import { MAX_ACTIVITY_LENGTH } from "./activity-marker.js";

/**
 * How many warnings a session keeps.
 *
 * The volume is not the server's to predict: a `preToolUse` hook fires once per
 * tool call and the backend sends a `warning` whenever it wants to. So the
 * session holds a ring rather than a log — what a caller reports is why the turn
 * is quiet now, and the newest few carry the whole of it.
 */
export const MAX_SESSION_WARNINGS = 5;

/**
 * Longest warning message that reaches a caller. A hook's `entries[]` carry
 * whatever the hook printed, which has no bound of its own.
 */
export const MAX_WARNING_MESSAGE_CHARS = 400;

/** A hook run in one of these states is holding the turn back or has broken. */
const HOOK_HELD_STATUSES = new Set(["blocked", "failed", "stopped"]);

/** The `HookOutputEntryKind` values that say why a hook held the turn. */
const HOOK_REASON_KINDS = new Set(["stop", "error", "warning"]);

/** What separates the parts of a composed line, as `activityLine` separates its own. */
const PART_SEPARATOR = " — ";

/**
 * Free text from the backend, ready to leave the process: trimmed, redacted and
 * cut to `limit`. Text that is not a non-empty string yields nothing rather than
 * an invented line.
 */
export function displayText(raw: unknown, limit = MAX_WARNING_MESSAGE_CHARS): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  const redacted = redactPaths(trimmed);
  if (redacted.length <= limit) return redacted;
  return `${redacted.slice(0, limit - 1)}…`;
}

/**
 * The line a `model/safetyBuffering/updated` says: which model is being held
 * back and the reasons the backend named for it.
 */
export function bufferingWarningMessage(params: Record<string, unknown>): string | undefined {
  const model = displayText(params.model);
  if (model === undefined) return undefined;
  const reasons = stringsOf(params.reasons);
  const head =
    reasons.length === 0
      ? `${model} is buffering its output`
      : `${model} is buffering its output: ${reasons.join(", ")}`;
  const faster = displayText(params.fasterModel);
  const line = faster === undefined ? head : `${head}${PART_SEPARATOR}${faster} is faster`;
  return displayText(line);
}

/**
 * Why a finished hook run held the turn, or nothing for a run that did not.
 *
 * A hook that wrote no `statusMessage` still says which event it ran on and how
 * it ended, and both of those the schema requires — the line is the run's own
 * fields rather than a description composed for it.
 */
export function hookWarningMessage(run: Record<string, unknown>): string | undefined {
  const status = displayText(run.status);
  if (status === undefined || !HOOK_HELD_STATUSES.has(status)) return undefined;
  const eventName = displayText(run.eventName);
  const parts = [eventName === undefined ? `a hook ${status}` : `${eventName} hook ${status}`];
  const statusMessage = displayText(run.statusMessage);
  if (statusMessage !== undefined) parts.push(statusMessage);
  parts.push(...hookReasonEntries(run));
  return displayText(parts.join(PART_SEPARATOR));
}

/**
 * The line a hook's author wrote for display, or nothing where they wrote none.
 *
 * It is cut to the activity marker's own length, because it stands in the same
 * place a marker does.
 */
export function hookActivityLine(run: Record<string, unknown>): string | undefined {
  return displayText(run.statusMessage, MAX_ACTIVITY_LENGTH);
}

/** The texts of the hook output entries that carry a reason. */
function hookReasonEntries(run: Record<string, unknown>): string[] {
  if (!Array.isArray(run.entries)) return [];
  const texts: string[] = [];
  for (const entry of run.entries) {
    if (entry === null || typeof entry !== "object") continue;
    const { kind, text } = entry as Record<string, unknown>;
    if (typeof kind !== "string" || !HOOK_REASON_KINDS.has(kind)) continue;
    const line = displayText(text);
    if (line !== undefined) texts.push(line);
  }
  return texts;
}

/** The non-empty strings of a wire array, and nothing at all from anything else. */
function stringsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const found: string[] = [];
  for (const entry of value) {
    const text = displayText(entry);
    if (text !== undefined) found.push(text);
  }
  return found;
}
