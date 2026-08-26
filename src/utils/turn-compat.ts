import { ErrorCode, type EffortLevel } from "../types.js";

export type TurnCompatibilityErrorKind = "minimal_web_search";

export function classifyTurnCompatibilityError(
  err: unknown
): TurnCompatibilityErrorKind | undefined {
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
  const mentionsMinimal = message.includes("minimal");
  const mentionsWebSearch = message.includes("web_search") || message.includes("web search");
  const mentionsEffort =
    message.includes("effort") ||
    message.includes("reasoning_effort") ||
    message.includes("reasoning effort");
  return mentionsMinimal && mentionsWebSearch && mentionsEffort ? "minimal_web_search" : undefined;
}

export function compatibilityErrorMessage(kind: TurnCompatibilityErrorKind): string {
  switch (kind) {
    case "minimal_web_search":
      return `Error [${ErrorCode.INVALID_ARGUMENT}]: effort=minimal is incompatible with the Codex web_search tool in this CLI build. Use effort=low or higher, or let codex-mcp auto-upgrade it.`;
  }
}

export function toFriendlyTurnCompatibilityError(err: unknown): Error {
  const kind = classifyTurnCompatibilityError(err);
  if (kind) {
    return new Error(compatibilityErrorMessage(kind));
  }
  return err instanceof Error ? err : new Error(String(err));
}

export function buildEffortFallbackWarning(from: EffortLevel, to: EffortLevel): string {
  return `effort=${from} is incompatible with the Codex web_search tool in this CLI build; automatically retried with effort=${to}.`;
}
