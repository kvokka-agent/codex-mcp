/**
 * Append-only JSONL event log with tiered flush strategy.
 *
 * - Noisy events (progress/output deltas): batched and flushed every `batchIntervalMs` (default 100ms)
 * - Critical events (permission, result, error, status change): flushed immediately
 * - Shutdown: force flush of all buffered events
 *
 * Each line is `{ seq, ...event }\n` to enable torn-tail detection on recovery.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Event criticality — determines flush strategy */
export type EventCriticality = "normal" | "critical";

interface PendingWrite {
  line: string;
}

export interface EventLogOptions {
  /** Path to the JSONL file */
  filePath: string;
  /** Batch interval for normal events in ms (default: 100) */
  batchIntervalMs?: number;
}

export class EventLog {
  private readonly filePath: string;
  private readonly batchIntervalMs: number;
  private buffer: PendingWrite[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private nextSeq = 0;
  private destroyed = false;

  constructor(opts: EventLogOptions) {
    this.filePath = opts.filePath;
    this.batchIntervalMs = opts.batchIntervalMs ?? 100;
    mkdirSync(dirname(this.filePath), { recursive: true });
  }

  /**
   * Append an event to the log.
   * @param event - Arbitrary JSON-serializable event data
   * @param criticality - "critical" forces immediate flush; "normal" batches
   */
  append(event: unknown, criticality: EventCriticality = "normal"): number {
    if (this.destroyed) return -1;
    const seq = this.nextSeq++;
    const line = JSON.stringify({ seq, ...(event as Record<string, unknown>) }) + "\n";
    this.buffer.push({ line });

    if (criticality === "critical") {
      this.flushSync();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flushSync();
      }, this.batchIntervalMs);
      // Don't block process exit for a timer
      if (this.flushTimer.unref) this.flushTimer.unref();
    }
    return seq;
  }

  /** Set the next sequence number (used during recovery to continue from last known seq). */
  setNextSeq(seq: number): void {
    this.nextSeq = seq;
  }

  /** Synchronously flush all buffered writes to disk. */
  flushSync(): void {
    if (this.buffer.length === 0) return;
    const chunk = this.buffer.map((w) => w.line).join("");
    this.buffer = [];
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    try {
      appendFileSync(this.filePath, chunk, "utf-8");
    } catch (err) {
      // Log but don't throw — persistence is best-effort
      console.error(`[event-log] Failed to flush to ${this.filePath}:`, err);
    }
  }

  /** Destroy the log, flushing any remaining events. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    // A pending timer implies a non-empty buffer, so flushSync has already cleared it.
    this.flushSync();
  }
}
