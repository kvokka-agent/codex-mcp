/** Reading a value out of JSON another process wrote. */
import { redactPaths } from "../../utils/redact.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** An error as one redacted line, for a report field rather than for a throw. */
export function messageOf(err: unknown): string {
  return redactPaths(err instanceof Error ? err.message : String(err));
}

export function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * One of `values`, or nothing where the value is not one of them.
 *
 * `meta.json` is JSON another process wrote — an older release, a hand edit, a
 * write cut in half — so a field of it is held against the set `codex_session`
 * publishes rather than cast to it. `approvalPolicy` no longer takes
 * `on-failure`, and a directory the previous release left behind carries it.
 *
 * The narrowing sits here, where a record becomes a session, and not in
 * `src/persistence/recovery-scanner.ts`: the scanner reads JSON off disk and
 * types everything past `sessionId` and the timestamps as `unknown` because the
 * vocabulary of these fields belongs to the session, and these same values are
 * what a resume hands back to `thread/resume`. A value outside the set is left
 * out, which reports the field as unknown — the whole session still lists, and
 * so does every other session of the directory.
 */
export function readOneOf<T extends string>(values: readonly T[], value: unknown): T | undefined {
  return typeof value === "string" && (values as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}
