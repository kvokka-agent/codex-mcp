/**
 * The requests this client is waiting on, keyed by the JSON-RPC id it sent each
 * under.
 */
import type { JsonRpcResponse, RequestId } from "../wire/index.js";

interface PendingRpcRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** The open requests of one connection, and the ids the next one takes. */
export class PendingRequests {
  private nextId: number;
  private readonly requests: Map<RequestId, PendingRpcRequest>;

  // The fields are set here rather than at their declarations: bun's coverage
  // counts a field initializer as a function it never marks hit.
  constructor() {
    this.nextId = 1;
    this.requests = new Map();
  }

  /**
   * Open a slot for one request and let `send` write it under the id the slot
   * took. A throw from `send` rejects with that error and drops the slot, so a
   * refused write leaves nothing waiting for an answer that cannot come.
   */
  open<T>(method: string, timeoutMs: number, send: (id: RequestId) => void): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.requests.delete(id);
        reject(new Error(`Request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      if (timer.unref) timer.unref();

      this.requests.set(id, {
        resolve: resolve as (result: unknown) => void,
        reject,
        timer,
      });

      try {
        send(id);
      } catch (err) {
        const pending = this.requests.get(id);
        if (pending) {
          this.requests.delete(id);
          clearTimeout(pending.timer);
        }
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Settle the request this response answers. A response to no open id is ignored. */
  settle(resp: JsonRpcResponse): void {
    const pending = this.requests.get(resp.id);
    if (pending) {
      this.requests.delete(resp.id);
      clearTimeout(pending.timer);
      if (resp.error) {
        pending.reject(new Error(`RPC error ${resp.error.code}: ${resp.error.message}`));
      } else {
        pending.resolve(resp.result);
      }
    }
  }

  /** Reject every open request: the connection they were sent on is gone. */
  failAll(error: Error): void {
    if (this.requests.size === 0) return;
    const entries = Array.from(this.requests.entries());
    this.requests.clear();
    for (const [, pending] of entries) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }
}
