/**
 * What the MCP client is told while a tool call is still being held.
 *
 * A blocking call shows the client nothing until it returns, so a Codex turn
 * that runs for an hour reads as one silent tool call and the caller sees the
 * description it wrote before the work started. A client that put
 * `_meta.progressToken` on the call asked to be told what is happening:
 * `notifications/progress` carries a `message`, and that message is what the
 * client renders under the call while it waits.
 *
 * The activity line Codex writes is what goes in it — the same line
 * `progress.activity` reports — so the caller watches the work rather than the
 * spawn description.
 *
 * A call that arrived with no progress token is reported nothing. The client
 * did not ask, and the MCP specification has no other place to put an
 * unsolicited line.
 */

import type { ProgressInfo } from "../types.js";
import { PROGRESS_HEARTBEAT_MS } from "../types.js";

/** The token the client put on its request, which every notification quotes back. */
export type ProgressToken = string | number;

/** `notifications/progress` as the MCP schema defines it. */
export interface ProgressNotification {
  method: "notifications/progress";
  params: {
    progressToken: ProgressToken;
    progress: number;
    total?: number;
    message?: string;
  };
}

/** `sendNotification` of the request handler this reporter speaks for. */
export type SendProgress = (notification: ProgressNotification) => Promise<void>;

/**
 * Sends one `notifications/progress` per line, in the order the lines arrived.
 *
 * `progress` counts the lines sent. The MCP schema asks for a number that rises
 * with every notification and allows the total to be unknown, which is what a
 * Codex turn is: how many activities are left is not knowable, and a percentage
 * invented here would be a number nobody measured.
 */
export class ProgressReporter {
  private sent = 0;
  private last?: string;

  constructor(
    private readonly token: ProgressToken,
    private readonly send: SendProgress
  ) {}

  /**
   * Report one line, unless it repeats the line before it.
   *
   * The send is not awaited and its failure is swallowed: the notification
   * travels to a client this server does not control, and a turn must not end
   * because a status line could not be delivered.
   */
  report(message: string): void {
    const line = message.trim();
    if (line.length === 0 || line === this.last) return;
    this.last = line;
    this.sent += 1;
    void this.send({
      method: "notifications/progress",
      params: { progressToken: this.token, progress: this.sent, message: line },
    }).catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`[codex-mcp] Progress notification refused by the client: ${detail}`);
    });
  }

  /** How many notifications this reporter has sent. */
  get count(): number {
    return this.sent;
  }
}

/**
 * A reporter for a request that asked for progress, and nothing for one that
 * did not.
 *
 * `_meta.progressToken` is optional in the MCP schema, so its absence is the
 * client saying it does not want notifications.
 */
export function progressReporterFor(
  meta: { progressToken?: ProgressToken } | undefined,
  send: SendProgress | undefined
): ProgressReporter | undefined {
  const token = meta?.progressToken;
  if (token === undefined || send === undefined) return undefined;
  return new ProgressReporter(token, send);
}

/**
 * A duration as a person reads it: seconds under a minute, whole minutes above
 * it, hours and minutes past an hour.
 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

/**
 * The line a held call shows the person waiting: what the turn is doing and how
 * long it has been doing it.
 *
 * Codex writes the first half. Where it has written nothing yet — the turn is
 * starting, or the backend is `codex exec`, which takes no activity instruction
 * — the phase stands in its place, so the line still moves and still says the
 * work is alive.
 */
export function activityLine(progress: ProgressInfo, heldMs: number): string {
  const standing = progress.activityStandingMs ?? heldMs;
  const what = progress.activity ?? progress.phase;
  return `${what} — ${formatDuration(standing)}`;
}

/**
 * How often a held call repeats that line, from
 * `CODEX_MCP_PROGRESS_HEARTBEAT_MS` or the default. Zero, a negative and an
 * unreadable value all mean no heartbeat.
 */
export function heartbeatIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CODEX_MCP_PROGRESS_HEARTBEAT_MS;
  if (raw === undefined) return PROGRESS_HEARTBEAT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return parsed;
}
