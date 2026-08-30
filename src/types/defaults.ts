/** The numbers the server falls back to when a call names none. */

import type { EffortLevel } from "./enums.js";

export const DEFAULT_EFFORT_LEVEL: EffortLevel = "low";
/**
 * Minimum recommended polling interval (ms) when session status is "running".
 * MCP callers should treat this as a floor and can wait longer for larger tasks.
 */
export const DEFAULT_POLL_INTERVAL = 120_000;
/**
 * Polling interval (ms) while waiting for approval/user-input actions.
 * Kept short so callers can unblock pending actions before approval timeout.
 */
export const WAITING_APPROVAL_POLL_INTERVAL = 1000;
/**
 * The longest `codex_check(action="poll")` holds a call, whatever `waitMs` asks
 * for and whatever the client tolerates.
 *
 * The client's own tool-call ceiling is what normally ends a wait — `PollWindow`
 * reads it and cuts the window to fit. This bound is the one the server keeps
 * on its own, so a caller that asks for a day cannot pin a waiter slot of the
 * session for one.
 */
export const MAX_LONG_POLL_WAIT_MS = 3_600_000;
/**
 * How often a held poll tells the client what the turn is doing.
 *
 * Two things need it. A person watching reads the line under the call rather
 * than a spinner, and a client watchdog that ends a call which said nothing —
 * Claude Code 2.1.250 cuts a silent stdio call at 1,800,000ms,
 * `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` — counts a progress notification as the
 * server speaking. `CODEX_MCP_PROGRESS_HEARTBEAT_MS` overrides it; 0 sends
 * heartbeats no more.
 */
export const PROGRESS_HEARTBEAT_MS = 30_000;
export const DEFAULT_APPROVAL_TIMEOUT_MS = 60_000;
export const DEFAULT_IDLE_CLEANUP_MS = 30 * 60 * 1000;
export const DEFAULT_RUNNING_CLEANUP_MS = 4 * 60 * 60 * 1000;
export const DEFAULT_TERMINAL_CLEANUP_MS = 5 * 60 * 1000;
export const CLEANUP_INTERVAL_MS = 60_000;
