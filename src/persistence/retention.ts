/**
 * Retention policy — prune old session directories by age, count, and disk size.
 */
import { readdirSync, rmSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";

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

function getDirSize(dirPath: string): number {
  let total = 0;
  try {
    for (const entry of readdirSync(dirPath)) {
      try {
        const st = statSync(join(dirPath, entry));
        total += st.isFile() ? st.size : 0;
      } catch {
        // skip
      }
    }
  } catch {
    // skip
  }
  return total;
}

/**
 * Apply retention policy to `sessionsDir`, removing oldest sessions first.
 * Returns the number of sessions pruned.
 */
export function pruneSessionDirs(sessionsDir: string, policy?: RetentionPolicy): number {
  const maxAgeMs = policy?.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const maxCount = policy?.maxCount ?? DEFAULT_MAX_COUNT;
  const maxDiskBytes = policy?.maxDiskBytes ?? DEFAULT_MAX_DISK_BYTES;

  let entries: string[];
  try {
    entries = readdirSync(sessionsDir);
  } catch {
    return 0;
  }

  // Collect info
  const now = Date.now();
  const dirs: SessionDirInfo[] = [];
  for (const entry of entries) {
    const dirPath = join(sessionsDir, entry);
    try {
      if (!statSync(dirPath).isDirectory()) continue;
    } catch {
      continue;
    }

    let lastActiveAt = 0;
    try {
      const meta = JSON.parse(readFileSync(join(dirPath, "meta.json"), "utf-8"));
      lastActiveAt = new Date(meta.lastActiveAt || meta.createdAt || 0).getTime();
    } catch {
      // Use directory mtime as fallback
      try {
        lastActiveAt = statSync(dirPath).mtimeMs;
      } catch {
        lastActiveAt = 0;
      }
    }

    dirs.push({
      path: dirPath,
      sessionId: entry,
      lastActiveAt,
      diskBytes: getDirSize(dirPath),
    });
  }

  // Sort oldest first
  dirs.sort((a, b) => a.lastActiveAt - b.lastActiveAt);

  const toRemove = new Set<string>();

  // 1. Age-based pruning
  for (const dir of dirs) {
    if (now - dir.lastActiveAt > maxAgeMs) {
      toRemove.add(dir.path);
    }
  }

  // 2. Count-based pruning (remove oldest until count <= maxCount)
  const remaining = dirs.filter((d) => !toRemove.has(d.path));
  if (remaining.length > maxCount) {
    const excess = remaining.length - maxCount;
    for (let i = 0; i < excess; i++) {
      toRemove.add(remaining[i]!.path);
    }
  }

  // 3. Size-based pruning (remove oldest until total size <= maxDiskBytes)
  const afterCountPrune = dirs.filter((d) => !toRemove.has(d.path));
  let totalSize = afterCountPrune.reduce((sum, d) => sum + d.diskBytes, 0);
  for (const dir of afterCountPrune) {
    if (totalSize <= maxDiskBytes) break;
    toRemove.add(dir.path);
    totalSize -= dir.diskBytes;
  }

  // Execute removal
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
