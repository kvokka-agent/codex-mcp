/**
 * Errno predicates shared by the persistence primitives.
 */

/**
 * True when the failure says the path is not there: a concurrent prune removed it, or a
 * component of it is a file. Every other errno means the path exists and could not be
 * read, which is not the same answer.
 */
export function isMissing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}
