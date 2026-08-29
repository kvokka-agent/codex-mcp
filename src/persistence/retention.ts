/**
 * Retention policy — prune old session directories by age, count, and disk size.
 */
import { readdirSync, rmSync, statSync, readFileSync, type Dirent } from "node:fs";
import { join } from "node:path";

import { isMissing } from "./fs-errors.js";
import { hasLiveOwner, ownerState, readOwner } from "./session-owner.js";

export interface RetentionPolicy {
  /** Maximum age in milliseconds (default: 7 days) */
  maxAgeMs?: number;
  /** Maximum number of retained sessions (default: 200) */
  maxCount?: number;
  /** Maximum total disk size in bytes (default: 500 MB) */
  maxDiskBytes?: number;
}

const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEFAULT_MAX_COUNT = 200;
const DEFAULT_MAX_DISK_BYTES = 500 * 1024 * 1024; // 500 MB

interface SessionDirInfo {
  path: string;
  sessionId: string;
  lastActiveAt: number; // epoch ms
  diskBytes: number;
}

/**
 * Total size in bytes of every file under `dirPath`, recursing into subdirectories.
 *
 * A path that has vanished mid-walk is a race with a concurrent prune, not a failure:
 * its subtree contributes nothing and the walk goes on. Any other read failure is
 * reported on stderr, so a subtree that could not be measured is not silently zero.
 * Symlinks are left uncounted — the target is counted where it lives.
 */
export function getDirSize(dirPath: string): number {
  let entries: Dirent[];
  try {
    entries = readdirSync(dirPath, { withFileTypes: true });
  } catch (err) {
    if (!isMissing(err)) console.error(`[retention] Failed to size ${dirPath}:`, err);
    return 0;
  }

  let total = 0;
  for (const entry of entries) {
    const child = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      total += getDirSize(child);
    } else if (entry.isFile()) {
      // throwIfNoEntry: false — a file removed between readdir and stat is the same race.
      total += statSync(child, { throwIfNoEntry: false })?.size ?? 0;
    }
  }
  return total;
}

/**
 * When the session last did something, as its own meta.json records it.
 *
 * A session directory whose meta.json is unusable is dated by its own mtime.
 */
function readLastActiveAt(dirPath: string, mtimeMs: number): number {
  try {
    const meta = JSON.parse(readFileSync(join(dirPath, "meta.json"), "utf-8"));
    return new Date(meta.lastActiveAt || meta.createdAt || 0).getTime();
  } catch {
    return mtimeMs;
  }
}

/**
 * The session directories retention may act on: every entry that is a directory
 * and that no running server holds.
 */
function collectSessionDirs(sessionsDir: string, entries: string[]): SessionDirInfo[] {
  const dirs: SessionDirInfo[] = [];
  for (const entry of entries) {
    const dirPath = join(sessionsDir, entry);
    // throwIfNoEntry: false — an entry removed between the listing and this call, and a
    // dangling symlink, are both nothing to prune. Any other stat failure throws.
    const stat = statSync(dirPath, { throwIfNoEntry: false });
    if (!stat?.isDirectory()) continue;
    if (hasLiveOwner(ownerState(readOwner(dirPath)))) continue;

    dirs.push({
      path: dirPath,
      sessionId: entry,
      lastActiveAt: readLastActiveAt(dirPath, stat.mtimeMs),
      diskBytes: getDirSize(dirPath),
    });
  }
  return dirs;
}

/** Take every session that has been idle for longer than `maxAgeMs`. */
function addExpiredDirs(
  dirs: SessionDirInfo[],
  now: number,
  maxAgeMs: number,
  toRemove: Set<string>
): void {
  for (const dir of dirs) {
    if (now - dir.lastActiveAt > maxAgeMs) {
      toRemove.add(dir.path);
    }
  }
}

/** Take the oldest of what is left until at most `maxCount` sessions remain. */
function addExcessDirs(dirs: SessionDirInfo[], maxCount: number, toRemove: Set<string>): void {
  const remaining = dirs.filter((d) => !toRemove.has(d.path));
  if (remaining.length > maxCount) {
    const excess = remaining.length - maxCount;
    for (let i = 0; i < excess; i++) {
      toRemove.add(remaining[i]!.path);
    }
  }
}

/** Take the oldest of what is left until the total holds at most `maxDiskBytes`. */
function addOversizeDirs(
  dirs: SessionDirInfo[],
  maxDiskBytes: number,
  toRemove: Set<string>
): void {
  const remaining = dirs.filter((d) => !toRemove.has(d.path));
  let totalSize = remaining.reduce((sum, d) => sum + d.diskBytes, 0);
  for (const dir of remaining) {
    if (totalSize <= maxDiskBytes) break;
    toRemove.add(dir.path);
    totalSize -= dir.diskBytes;
  }
}

/** The directories the policy takes, oldest first. */
function selectDirsToRemove(
  dirs: SessionDirInfo[],
  now: number,
  maxAgeMs: number,
  maxCount: number,
  maxDiskBytes: number
): Set<string> {
  const toRemove = new Set<string>();
  addExpiredDirs(dirs, now, maxAgeMs, toRemove);
  addExcessDirs(dirs, maxCount, toRemove);
  addOversizeDirs(dirs, maxDiskBytes, toRemove);
  return toRemove;
}

/** Remove each directory, reporting the ones that could not go. Returns how many went. */
function removeSessionDirs(toRemove: Set<string>): number {
  let pruned = 0;
  for (const dirPath of toRemove) {
    try {
      rmSync(dirPath, { recursive: true, force: true });
      pruned++;
    } catch (err) {
      console.error(`[retention] Failed to remove ${dirPath}:`, err);
    }
  }
  return pruned;
}

/**
 * Apply retention policy to `sessionsDir`, removing oldest sessions first.
 * Returns the number of sessions pruned.
 *
 * A session a running server holds is left where it is, whatever its age: that
 * server is writing into the directory, and removing it would take the event log
 * out from under a live turn.
 *
 * A directory that is not there has nothing to prune. A directory that is there and
 * cannot be listed throws: reporting zero removals would tell the caller retention ran
 * over an empty directory while the sessions in it keep the disk they hold.
 */
export function pruneSessionDirs(sessionsDir: string, policy?: RetentionPolicy): number {
  const maxAgeMs = policy?.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const maxCount = policy?.maxCount ?? DEFAULT_MAX_COUNT;
  const maxDiskBytes = policy?.maxDiskBytes ?? DEFAULT_MAX_DISK_BYTES;

  // throwIfNoEntry: false — a state directory the previous run never created has nothing
  // to prune. existsSync cannot stand here: it answers false for a directory it may not
  // stat, which is the very case that must not read as "nothing to prune".
  if (!statSync(sessionsDir, { throwIfNoEntry: false })) return 0;
  const entries = readdirSync(sessionsDir);

  const now = Date.now();
  const dirs = collectSessionDirs(sessionsDir, entries);

  // Sort oldest first
  dirs.sort((a, b) => a.lastActiveAt - b.lastActiveAt);

  return removeSessionDirs(selectDirsToRemove(dirs, now, maxAgeMs, maxCount, maxDiskBytes));
}
