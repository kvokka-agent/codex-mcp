/**
 * The JSON-RPC envelope every app-server message travels in, and the handshake
 * that opens the connection.
 *
 * Derived from `codex app-server generate-json-schema`.
 */

// ── JSON-RPC Base ──────────────────────────────────────────────────

export type RequestId = string | number;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: RequestId;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: RequestId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

// ── Initialize ─────────────────────────────────────────────────────

export interface InitializeParams {
  clientInfo: { name: string; version: string; title?: string };
  capabilities?: {
    /** Opt into the experimental API methods and fields. Default false. */
    experimentalApi?: boolean;
    /** Exact notification method names the server suppresses for this connection. */
    optOutNotificationMethods?: string[];
    /** MCP extension settings, keyed by extension name — for example `openai/form`. */
    extensions?: Record<string, unknown> | null;
    /** Legacy opt-in for the `openai/form` MCP extension; `extensions` replaces it. */
    mcpServerOpenaiFormElicitation?: boolean;
    /**
     * Opt into `attestation/generate` requests for the upstream
     * `x-oai-attestation` header. Default false, and left false here: this
     * server has no attestation signer to answer with.
     */
    requestAttestation?: boolean;
  };
}

export interface InitializeResult {
  userAgent: string;
}
