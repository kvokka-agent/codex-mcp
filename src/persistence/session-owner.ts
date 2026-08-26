/**
 * Who holds a session.
 *
 * One session is driven by one codex-mcp process: the client that started it
 * talks to that process and to no other. The claim is written into the session's
 * own directory as `owner.json`, so two servers sharing a state directory each
 * write their own sessions, read each other's, and neither can act on a session
 * the other holds.
 *
 * The claim carries the owner's start time as well as its pid, because a pid is
 * handed on the moment its process exits: a successor proves a recorded owner is
 * gone before it takes the session, and treats every unproven answer as held.
 */
import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteJson } from "./atomic-writer.js";
import { START_TIME_SLOP_MS, identifyProcess, ownStartedAt, probePid } from "./process-identity.js";

/** The file a session's owner writes into the session directory. */
export const OWNER_FILE = "owner.json";

export interface SessionOwner {
  /** Process id of the codex-mcp server holding the session. */
  pid: number;
  /** The instant that process started, which proves the pid was not reused. */
  startedAt: string;
}

/**
 * What a recorded owner turned out to be.
 *
 * `held` covers both a running owner and one whose fate no source could
 * establish: acting on either would put two servers on one Codex thread.
 */
export type OwnerState =
  | { kind: "unowned" }
  | { kind: "self"; owner: SessionOwner }
  | { kind: "held"; owner: SessionOwner; proven: boolean }
  | { kind: "gone"; owner: SessionOwner };

/** The claim this process writes for a session it drives. */
export function ownClaim(): SessionOwner {
  return { pid: process.pid, startedAt: ownStartedAt() };
}

/** Read the owner recorded for a session directory, or null when none is. */
export function readOwner(sessionDir: string): SessionOwner | null {
  let raw: string;
  try {
    raw = readFileSync(join(sessionDir, OWNER_FILE), "utf-8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as SessionOwner;
    if (!Number.isInteger(parsed?.pid) || parsed.pid <= 0) return null;
    if (typeof parsed.startedAt !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Decide what a recorded owner is, from the pid it names.
 *
 * A pid that is alive and whose start time matches the claim is the owner still
 * running. A pid that is alive with another start time is a number handed on
 * after the owner exited, which is a session free to take. A liveness or a start
 * time no source could read leaves the session held but unproven, and a caller
 * says so rather than taking it.
 */
export function ownerState(owner: SessionOwner | null): OwnerState {
  if (!owner) return { kind: "unowned" };
  if (owner.pid === process.pid) {
    // Our own pid can also be a number handed to us after the previous holder
    // exited, and the start time is what separates the two.
    const drift = Math.abs(
      new Date(owner.startedAt).getTime() - new Date(ownStartedAt()).getTime()
    );
    return drift < START_TIME_SLOP_MS ? { kind: "self", owner } : { kind: "gone", owner };
  }

  const liveness = probePid(owner.pid);
  if (liveness === "dead") return { kind: "gone", owner };
  if (liveness === "unknown") return { kind: "held", owner, proven: false };

  const check = identifyProcess(owner.pid, owner.startedAt);
  if (check.identity === "match") return { kind: "held", owner, proven: true };
  if (check.identity === "mismatch") return { kind: "gone", owner };
  return { kind: "held", owner, proven: false };
}

/** Write this process's claim on a session. */
export function claimSession(sessionDir: string, owner: SessionOwner = ownClaim()): void {
  atomicWriteJson(join(sessionDir, OWNER_FILE), owner);
}

/**
 * Drop the claim on a session.
 *
 * A claim that is already gone, and a session directory a prune removed, are
 * both the state this asks for.
 */
export function releaseSession(sessionDir: string): void {
  try {
    unlinkSync(join(sessionDir, OWNER_FILE));
  } catch {
    // Already released, or the directory went with it.
  }
}

/** Whether a running process holds the session — this one or another. */
export function hasLiveOwner(state: OwnerState): boolean {
  return state.kind === "held" || state.kind === "self";
}

/** How a state a caller may not act on reads on stderr and in an error message. */
export function describeOwner(state: OwnerState): string {
  switch (state.kind) {
    case "self":
      return `held by this server (pid ${state.owner.pid})`;
    case "held":
      return state.proven
        ? `held by a running codex-mcp (pid ${state.owner.pid}, started ${state.owner.startedAt})`
        : `recorded as held by pid ${state.owner.pid} and that process could not be checked`;
    case "gone":
      return `left by pid ${state.owner.pid}, which is gone`;
    case "unowned":
      return "held by no server";
  }
}
