/**
 * Simple PID-based lockfile for single-writer STATE_DIR protection.
 *
 * Uses `O_EXCL` for atomic creation. A lock is reclaimed only when the recorded
 * pid is proven gone; anything less leaves the file where it is.
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

/** What `process.kill(pid, 0)` could establish about a pid. */
type Liveness = "alive" | "dead" | "unknown";

/**
 * Probe whether a process with the given pid runs.
 *
 * `process.kill(pid, 0)` raises ESRCH for a pid no process holds and EPERM when
 * the process runs under a user this one may not signal — EPERM is a live
 * process, and a shared STATE_DIR across accounts is exactly where it appears.
 * Any other errno leaves liveness unknown.
 */
function probePid(pid: number): Liveness {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "dead";
    if (code === "EPERM") return "alive";
    return "unknown";
  }
}

/**
 * Read the lock currently at `lockPath`: its content, "none" when no file is
 * there, or "unreadable" when the file cannot be read, does not parse, or
 * carries no usable pid — the last of which a file caught mid-write shows.
 */
function readExistingLock(lockPath: string): LockContent | "none" | "unreadable" {
  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf-8");
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? "none" : "unreadable";
  }
  try {
    const parsed = JSON.parse(raw) as LockContent;
    if (!Number.isInteger(parsed?.pid) || parsed.pid <= 0) return "unreadable";
    return parsed;
  } catch {
    return "unreadable";
  }
}

/**
 * Acquire a lockfile at `lockPath`. Returns a release function.
 * Throws when another process holds the lock, and when the holder's liveness
 * cannot be established: removing a live holder's lock puts two servers in one
 * session directory, where the pruner of each deletes the sessions of the other.
 */
export function acquireLock(lockPath: string): () => void {
  mkdirSync(dirname(lockPath), { recursive: true });

  const existing = readExistingLock(lockPath);
  if (existing === "unreadable") {
    // The file may be mid-write by another process. Do NOT unlink it; let the
    // O_EXCL create below fail naturally instead.
    console.error(
      `[lockfile] Existing lock at ${lockPath} is unreadable — will attempt O_EXCL create`
    );
  } else if (existing !== "none") {
    const liveness = existing.pid === process.pid ? "dead" : probePid(existing.pid);
    if (liveness === "alive") {
      throw new Error(
        `STATE_DIR is locked by another process (pid=${existing.pid}, started=${existing.startedAt}). ` +
          `If this is stale, delete ${lockPath}`
      );
    }
    if (liveness === "unknown") {
      throw new Error(
        `STATE_DIR is locked by pid=${existing.pid} (started=${existing.startedAt}) and its liveness ` +
          `could not be determined — refusing to reclaim the lock. If that process is gone, delete ${lockPath}`
      );
    }
    // The recorded pid is gone, or it is this process reclaiming its own lock.
    try {
      unlinkSync(lockPath);
    } catch {
      // Someone removed it first, or it is not ours to remove — the O_EXCL
      // create below reports whichever it was.
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
