/**
 * The stdin side of the app-server connection: what is written straight through,
 * what is held while the pipe is full, and what a refused write does.
 */
import type { Writable } from "node:stream";
import { ErrorCode } from "../../types.js";

const MAX_WRITE_QUEUE_BYTES = 5 * 1024 * 1024; // 5MB

/** What the queue reaches back into the client for. */
export interface WriteQueueHooks {
  /** The child's stdin as it stands now, or nothing once the child is gone. */
  stdin: () => Writable | null | undefined;
  /** Carries a write this connection lost to everything waiting on it. */
  fail: (error: Error) => void;
  /** Ends the subprocess this queue can no longer reach, naming what happened. */
  terminate: (context: string) => void;
}

/** Writes JSON-RPC payloads to a child's stdin, holding them while it is full. */
export class StdinWriteQueue {
  private backpressure: boolean;
  private queue: string[];
  private queuedBytes: number;

  // The fields are set here rather than at their declarations: bun's coverage
  // counts a field initializer as a function it never marks hit.
  constructor(private readonly hooks: WriteQueueHooks) {
    this.backpressure = false;
    this.queue = [];
    this.queuedBytes = 0;
  }

  /**
   * Write one payload, or hold it behind the ones already waiting.
   *
   * Throws when the write was refused, so the caller learns its message never
   * reached codex.
   */
  write(payload: string): void {
    const stdin = this.hooks.stdin();
    if (!stdin?.writable) throw new Error("app-server stdin not writable");

    if (this.backpressure || this.queue.length > 0) {
      this.hold(payload);
      return;
    }

    try {
      this.writeToStdin(stdin, payload);
    } catch (err) {
      throw this.recordFailure(err);
    }
  }

  /** Write what is held, as far as stdin takes it. The `drain` event calls this. */
  flush(): void {
    const stdin = this.hooks.stdin();
    if (!stdin?.writable) {
      const dropped = this.dropQueued("stdin is not writable while flushing");
      if (dropped) {
        this.hooks.terminate("dropping queued writes");
      }
      return;
    }
    this.backpressure = false;
    while (!this.backpressure) {
      const next = this.queue.shift();
      if (next === undefined) break;
      this.queuedBytes -= next.length;
      try {
        this.writeToStdin(stdin, next);
      } catch (err) {
        this.recordFailure(err);
        this.queue = [];
        this.queuedBytes = 0;
        return;
      }
    }
  }

  /** Hold a payload until stdin drains, up to the queue limit. */
  private hold(payload: string): void {
    if (this.queuedBytes + payload.length > MAX_WRITE_QUEUE_BYTES) {
      const error = new Error(
        `Error [${ErrorCode.WRITE_QUEUE_DROPPED}]: app-server stdin backpressure: write queue exceeded limit`
      );
      this.hooks.fail(error);
      this.queue = [];
      this.queuedBytes = 0;
      this.hooks.terminate("write queue overflow");
      throw error;
    }
    this.queue.push(payload);
    this.queuedBytes += payload.length;
  }

  private writeToStdin(stdin: Writable, payload: string): void {
    const ok = stdin.write(payload);
    if (!ok) this.backpressure = true;
  }

  /** Carry a refused write to every pending request, and hand the error back to the caller. */
  private recordFailure(err: unknown): Error {
    const error = err instanceof Error ? err : new Error(String(err));
    this.hooks.fail(error);
    return error;
  }

  /** Drop what is held, and answer whether there was anything to drop. */
  private dropQueued(reason: string): boolean {
    if (this.queue.length === 0) return false;
    const error = new Error(`Error [${ErrorCode.WRITE_QUEUE_DROPPED}]: ${reason}`);
    console.error(
      `[app-server] Dropping ${this.queue.length} queued writes (${this.queuedBytes} bytes): ${reason}`
    );
    this.hooks.fail(error);
    this.queue = [];
    this.queuedBytes = 0;
    return true;
  }
}
