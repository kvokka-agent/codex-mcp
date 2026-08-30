/**
 * How long `codex_check(action="poll")` may hold a call before the MCP client
 * cuts it.
 *
 * The client owns that ceiling, and a call it cuts is worse than a call that
 * returned: the caller gets an error instead of a status, the round trip is
 * spent anyway, and the turn's answer has to be held back so the cut response
 * does not carry it away. So the server holds the call for as long as the
 * client allows and returns just inside that.
 *
 * Three things say where the ceiling is, in falling order of authority:
 *
 * 1. A cut this server watched. `notifications/cancelled` names its reason, so
 *    a client timeout is told apart from a person pressing Escape, and the
 *    shortest timeout measured is the ceiling from then on.
 * 2. `MCP_TOOL_TIMEOUT` in the environment. A client spawns its stdio servers
 *    as children and hands its own environment down, so the value an operator
 *    set for the client arrives here unchanged. Measured against Claude Code
 *    2.1.247: `MCP_TOOL_TIMEOUT=30000` reached `process.env` of the spawned
 *    server, and the call was cut 30.0s after it started.
 * 3. Nothing, for a client that declared nothing. Claude Code 2.1.247 held a
 *    tool call open for 1500s with no `MCP_TOOL_TIMEOUT` set and cut nothing,
 *    so no ceiling under `MAX_LONG_POLL_WAIT_MS` is claimed for it and the
 *    first cut, if one ever comes, supplies the real number. Every other client
 *    is held to the MCP TypeScript SDK's `DEFAULT_REQUEST_TIMEOUT_MSEC`, which
 *    it applies to a `tools/call` nobody configured.
 */
import { MAX_LONG_POLL_WAIT_MS } from "../types/index.js";

/**
 * `DEFAULT_REQUEST_TIMEOUT_MSEC` of the MCP TypeScript SDK, which every client
 * built on it applies to a `tools/call` it did not configure.
 */
export const SDK_DEFAULT_TOOL_TIMEOUT_MS = 60_000;

/**
 * Subtracted from the ceiling so the answer is on the wire before the cut.
 *
 * It covers the read of the session, the JSON encoding of the payload and the
 * write down the pipe — under 5ms in the measured runs. The rest is headroom
 * for a client whose clock started before the request reached this process.
 */
export const POLL_WINDOW_MARGIN_MS = 5_000;

/**
 * The shortest window worth holding a call open for. Below it the round trip
 * costs more than the wait saves, so the poll answers at once instead.
 */
export const MIN_POLL_WINDOW_MS = 1_000;

/** A client that names one of these cut the call on its own clock. */
function isTimeoutReason(reason: unknown): boolean {
  return typeof reason === "string" && /tim(ed|e)\s?out/i.test(reason);
}

/** The ceiling `MCP_TOOL_TIMEOUT` declares, or undefined when it says nothing usable. */
function declaredCeilingMs(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env.MCP_TOOL_TIMEOUT;
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
}

/**
 * The ceiling the client applies when nothing configured one, or undefined for
 * a client measured not to apply one.
 */
function clientDefaultCeilingMs(env: NodeJS.ProcessEnv): number | undefined {
  return env.CLAUDECODE === "1" ? undefined : SDK_DEFAULT_TOOL_TIMEOUT_MS;
}

/** Where the ceiling in force came from. */
export type PollWindowSource = "measured" | "declared" | "client-default" | "none";

/**
 * The long-poll budget of one MCP connection, and what the connection taught it.
 *
 * One instance per server: the ceiling belongs to the client on the other end
 * of the pipe, and every session of that client shares it.
 */
export class PollWindow {
  readonly #declaredMs: number | undefined;
  readonly #clientDefaultMs: number | undefined;
  #observedMs: number | undefined;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.#declaredMs = declaredCeilingMs(env);
    this.#clientDefaultMs = clientDefaultCeilingMs(env);
  }

  /** The ceiling in force, or undefined while no source names one. */
  ceilingMs(): number | undefined {
    return this.#observedMs ?? this.#declaredMs ?? this.#clientDefaultMs;
  }

  /**
   * The longest a poll may hold the call and still answer it: the ceiling less
   * the margin, this server's own bound when no ceiling is known, and zero when
   * the ceiling leaves no window worth holding.
   */
  budgetMs(): number {
    const ceiling = this.ceilingMs();
    if (ceiling === undefined) return MAX_LONG_POLL_WAIT_MS;
    const usable = ceiling - POLL_WINDOW_MARGIN_MS;
    return usable >= MIN_POLL_WINDOW_MS ? usable : 0;
  }

  /**
   * Take in a call the client cut, so the next one returns inside the cut.
   *
   * Only a timeout teaches anything. A person pressing Escape and a client
   * shutting down abort the same signal, and neither says where the ceiling is.
   */
  recordCut(heldMs: number, reason: unknown): void {
    if (!isTimeoutReason(reason)) return;
    if (!Number.isFinite(heldMs) || heldMs <= 0) return;
    if (this.#observedMs === undefined || heldMs < this.#observedMs) {
      this.#observedMs = heldMs;
    }
  }

  /** What the budget rests on, for the logs and for `codex-mcp:///config`. */
  describe(): { ceilingMs: number | undefined; budgetMs: number; source: PollWindowSource } {
    const source: PollWindowSource =
      this.#observedMs !== undefined
        ? "measured"
        : this.#declaredMs !== undefined
          ? "declared"
          : this.#clientDefaultMs !== undefined
            ? "client-default"
            : "none";
    return { ceilingMs: this.ceilingMs(), budgetMs: this.budgetMs(), source };
  }
}
