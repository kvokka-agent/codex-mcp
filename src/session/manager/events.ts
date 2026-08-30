/** What a session says while it runs: its event log, its activity line, its listeners. */

import type { SessionEventType, SessionInfo } from "../../types.js";
import { ActivityMarkerScanner } from "../activity-marker.js";
import type { EventSink } from "./core.js";

/** Disk mirror per session; a dropped session takes its sink with it. */
const eventSinks = new WeakMap<SessionInfo, EventSink>();

/** Marker scanner per session; a dropped session takes its carry buffer with it. */
const activityScanners = new WeakMap<SessionInfo, ActivityMarkerScanner>();

/**
 * Who to tell when a session says what it is doing now.
 *
 * A caller holding a tool call open on this session subscribes here, so the line
 * reaches the client as a notification the moment it arrives — before the poll
 * that the same line ends returns it.
 */
const activityListeners = new WeakMap<SessionInfo, Set<(activity: string) => void>>();

export function scannerOf(session: SessionInfo): ActivityMarkerScanner {
  let scanner = activityScanners.get(session);
  if (!scanner) {
    scanner = new ActivityMarkerScanner();
    activityScanners.set(session, scanner);
  }
  return scanner;
}

/**
 * Record what the session is doing: overwrite the one line a poll reports, stamp
 * when it arrived, and append one `activity` record to the session's
 * events.jsonl.
 *
 * The caller wakes the long-poll waiters after it — `signalOf` carries the line,
 * so a poll answers with each new heading and the person waiting reads the work
 * as it happens. One line per heading is what travels, not the turn's stream.
 *
 * `fromHook` marks a line a hook wrote rather than one Codex wrote, which is
 * what `markerStands` reads to keep a hook off a marker's place.
 */
export function recordActivity(
  session: SessionInfo,
  activity: string,
  itemId?: string,
  fromHook = false
): void {
  const next = session.progressState ?? { lastEventAt: new Date().toISOString() };
  next.activity = activity;
  next.activityAt = new Date().toISOString();
  next.activityFromHook = fromHook;
  session.progressState = next;
  recordEvent(session, "activity", { activity, turnId: session.activeTurnId, itemId, fromHook });
  notifyActivityListeners(session, activity);
}

/**
 * The turn has written a marker and the line standing is that marker.
 *
 * A hook line fills the silence before the turn says anything of its own; once
 * the turn has spoken, its own words are the standing line for the rest of it.
 */
export function markerStands(session: SessionInfo): boolean {
  const state = session.progressState;
  return state?.activity !== undefined && state.activityFromHook !== true;
}

/** Tell everyone holding a call open on this session one line about it. */
export function notifyActivityListeners(session: SessionInfo, line: string): void {
  for (const listener of activityListeners.get(session) ?? []) {
    try {
      listener(line);
    } catch (err: unknown) {
      // A listener writes to a client this server does not own. Its failure is
      // the caller's to survive, and the turn goes on either way.
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[codex-mcp] Activity listener failed for session '${session.sessionId}': ${message}`
      );
    }
  }
}

export function setEventSink(session: SessionInfo, sink: EventSink): void {
  eventSinks.set(session, sink);
}

/**
 * Write one event of the turn to the session's events.jsonl.
 *
 * The log is read by whoever opens the state directory, never by `codex_check`:
 * the caller is told the state of the session, and Codex's own rollout log under
 * `~/.codex/sessions/` holds the transcript.
 */
export function recordEvent(session: SessionInfo, type: SessionEventType, data: unknown): void {
  eventSinks.get(session)?.(type, data, new Date().toISOString());
}

/**
 * Hear each new activity line of a session for as long as the returned function
 * is not called.
 */
export function addActivityListener(
  session: SessionInfo,
  listener: (activity: string) => void
): () => void {
  let listeners = activityListeners.get(session);
  if (!listeners) {
    listeners = new Set();
    activityListeners.set(session, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
