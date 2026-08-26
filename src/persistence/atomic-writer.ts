/**
 * Atomic JSON file writer — write to .tmp then rename to avoid torn writes.
 */
import { writeFileSync, renameSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Atomically write a JSON-serializable value to `filePath`.
 * Writes to a sibling `.tmp` file first, then renames.
 * On crash between write and rename, only the .tmp is left (caller can ignore/clean).
 */
export function atomicWriteJson(filePath: string, data: unknown): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = join(dir, `.tmp-${randomBytes(6).toString("hex")}`);
  try {
    writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
    renameSync(tmpPath, filePath);
  } catch (err) {
    // Best-effort cleanup of the temp file
    try {
      unlinkSync(tmpPath);
    } catch {
      // ignore
    }
    throw err;
  }
}
