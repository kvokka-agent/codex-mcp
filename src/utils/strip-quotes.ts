/**
 * Strip one pair of surrounding double quotes from a token.
 *
 * A Windows PATH entry and a `CODEX_MCP_*` value both reach this process with
 * the quotes the shell that wrote them put on, which are not part of the path.
 */
export function stripSurroundingQuotes(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  return value;
}
