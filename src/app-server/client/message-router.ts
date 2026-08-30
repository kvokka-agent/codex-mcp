/**
 * The stdout side of the app-server connection: the JSON-RPC messages the child
 * wrote, each handed to whoever answers it.
 */
import { ErrorCode } from "../../types/index.js";
import { LineReader } from "../child-stdio.js";
import type {
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  RequestId,
} from "../wire/index.js";

export type NotificationHandler = (method: string, params: unknown) => void;
export type ServerRequestHandler = (id: RequestId, method: string, params: unknown) => void;

/** What the router reaches back into the client for. */
export interface MessageRouterHooks {
  /** Settles the request this response answers. */
  response: (resp: JsonRpcResponse) => void;
  /** Refuses a server request no handler was registered for, so the turn stops waiting. */
  refuse: (id: RequestId, method: string) => void;
  /** Reports a line the stream cannot be followed past. */
  parseFailure: (error: Error) => void;
}

/** Turns a child's stdout chunks into messages and routes each by its shape. */
export class MessageRouter {
  private readonly lines: LineReader;
  private notificationHandler: NotificationHandler | null;
  private serverRequestHandler: ServerRequestHandler | null;

  // The fields are set here rather than at their declarations: bun's coverage
  // counts a field initializer as a function it never marks hit.
  constructor(private readonly hooks: MessageRouterHooks) {
    this.lines = new LineReader();
    this.notificationHandler = null;
    this.serverRequestHandler = null;
  }

  /** Register the handler for server notifications. */
  onNotification(handler: NotificationHandler): void {
    this.notificationHandler = handler;
  }

  /** Register the handler for server-initiated requests (approvals, user input, etc.). */
  onServerRequest(handler: ServerRequestHandler): void {
    this.serverRequestHandler = handler;
  }

  /** Route every message the lines this chunk completed carry. */
  take(chunk: Buffer): void {
    for (const trimmed of this.lines.take(chunk)) {
      // Fast path: app-server should emit JSON per line; ignore any non-JSON noise safely.
      if (trimmed[0] !== "{" && trimmed[0] !== "[") {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed) as unknown;
      } catch {
        this.reportParseFailure(trimmed);
        continue;
      }

      // Dispatch outside the parse guard: a throwing handler is not a parse
      // error and must not be reported or acted on as one.
      this.dispatchParsed(parsed);
    }
  }

  /** Report a line this client can no longer follow the stream past. */
  private reportParseFailure(trimmed: string): void {
    const error = new Error(
      `Error [${ErrorCode.PROTOCOL_PARSE_ERROR}]: app-server protocol error: failed to parse JSON line: ${trimmed.slice(0, 200)}`
    );
    console.error(`[app-server] ${error.message}`);
    this.hooks.parseFailure(error);
  }

  private dispatchParsed(parsed: unknown): void {
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (item && typeof item === "object") {
          this.handleMessage(item as JsonRpcMessage);
        }
      }
    } else if (parsed && typeof parsed === "object") {
      this.handleMessage(parsed as JsonRpcMessage);
    }
  }

  private handleMessage(msg: JsonRpcMessage): void {
    // Response to our request
    if ("id" in msg && ("result" in msg || "error" in msg)) {
      this.hooks.response(msg as JsonRpcResponse);
      return;
    }

    // Server-initiated request (has id + method, no result/error)
    if ("id" in msg && "method" in msg) {
      this.dispatchServerRequest(msg as JsonRpcRequest);
      return;
    }

    // Notification (no id)
    if ("method" in msg && !("id" in msg)) {
      this.dispatchNotification(msg as JsonRpcNotification);
      return;
    }
  }

  private dispatchServerRequest(req: JsonRpcRequest): void {
    const handler = this.serverRequestHandler;
    if (handler) {
      this.runHandler(() => handler(req.id, req.method, req.params), req.method);
    } else {
      // No handler — respond with error to avoid hanging
      this.runHandler(() => this.hooks.refuse(req.id, req.method), req.method);
    }
  }

  private dispatchNotification(notif: JsonRpcNotification): void {
    const handler = this.notificationHandler;
    if (handler) {
      this.runHandler(() => handler(notif.method, notif.params), notif.method);
    }
  }

  /**
   * Run a message handler, keeping its failure out of the stdout reader: an
   * exception thrown here would otherwise abort the loop over the remaining
   * lines of the same chunk.
   */
  private runHandler(fn: () => void, method: string): void {
    try {
      fn();
    } catch (err) {
      console.error(
        `[app-server] Handler for ${method} threw: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}
