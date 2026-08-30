/**
 * The envelope every tool answers in: the payload as text, the same payload as
 * structured content, and whether the call failed.
 */
import { ErrorCode } from "../types/index.js";
import { redactPaths } from "../utils/redact.js";
import { classifyTurnCompatibilityError, compatibilityErrorMessage } from "../utils/turn-compat.js";

function formatErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const compatibilityKind = classifyTurnCompatibilityError(err);
  if (compatibilityKind) {
    return compatibilityErrorMessage(compatibilityKind);
  }
  const m = /^Error \[([A-Z_]+)\]:\s*(.*)$/.exec(message);
  if (m) {
    const [, code, rest] = m;
    if (code === ErrorCode.INTERNAL) {
      return `Error [${ErrorCode.INTERNAL}]: ${redactPaths(rest)}`;
    }
    return message;
  }
  return `Error [${ErrorCode.INTERNAL}]: ${redactPaths(message)}`;
}

function toStructuredContent(value: unknown): Record<string, unknown> {
  // MCP structuredContent is object-shaped; wrap non-object payloads for compatibility.
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { value };
}

/** The envelope MCP reads: the payload as text, as structured content, and whether it failed. */
function toolEnvelope(result: unknown, isError: boolean) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    structuredContent: toStructuredContent(result),
    isError,
  };
}

/**
 * Run a tool handler and answer in that envelope. A throw becomes the error
 * envelope; `isErrorOf` reads failure out of a payload that reports its own.
 */
export async function runTool(
  run: () => unknown,
  isErrorOf: (result: unknown) => boolean = () => false
) {
  try {
    const result = await run();
    return toolEnvelope(result, isErrorOf(result));
  } catch (err: unknown) {
    const message = formatErrorMessage(err);
    return {
      content: [{ type: "text" as const, text: message }],
      structuredContent: { error: message, isError: true },
      isError: true,
    };
  }
}

/** A payload that carries no `isError` did not fail. */
export function payloadIsError(result: unknown): boolean {
  return typeof (result as { isError?: boolean }).isError === "boolean"
    ? (result as { isError: boolean }).isError
    : false;
}
