/**
 * Simple PID-based lockfile for single-writer STATE_DIR protection.
 *
 * Uses `O_EXCL` for atomic creation. Stale locks (dead PID) are automatically reclaimed.
 */
import {
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
  constants,
} from "node:fs";
import { dirname } from "node:path";

interface LockContent {
  pid: number;
  startedAt: string;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Acquire a lockfile at `lockPath`. Returns a release function.
 * Throws if another live process holds the lock.
 */
export function acquireLock(lockPath: string): () => void {
  mkdirSync(dirname(lockPath), { recursive: true });

  // Check for existing lock
  try {
    const raw = readFileSync(lockPath, "utf-8");
    const existing: LockContent = JSON.parse(raw);
    if (isPidAlive(existing.pid) && existing.pid !== process.pid) {
      throw new Error(
        `STATE_DIR is locked by another process (pid=${existing.pid}, started=${existing.startedAt}). ` +
          `If this is stale, delete ${lockPath}`
      );
    }
    // Stale lock from a dead process — reclaim it
    unlinkSync(lockPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      if ((err as Error).message?.includes("STATE_DIR is locked")) throw err;
      // Parse error — the file may be mid-write by another process.
      // Do NOT blindly unlink (could delete a valid lock being written).
      // Instead, warn and let O_EXCL below fail naturally if the file exists.
      console.error(
        `[lockfile] Existing lock at ${lockPath} is unreadable — will attempt O_EXCL create`
      );
    }
  }

  // Write our lock
  const content: LockContent = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  let fd: number | undefined;
  try {
    fd = openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
    writeFileSync(fd, JSON.stringify(content) + "\n", "utf-8");
    closeSync(fd);
    fd = undefined;
  } catch (err) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      // Another process owns this lockfile — do NOT delete it
      throw new Error(
        `Failed to acquire STATE_DIR lock at ${lockPath} — race with another process`
      );
    }
    // We may have partially created the file — clean up
    try {
      unlinkSync(lockPath);
    } catch {
      /* ignore */
    }
    throw err;
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      unlinkSync(lockPath);
    } catch {
      // ignore — may already be gone
    }
  };
}
