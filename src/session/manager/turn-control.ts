/** Acting on the turn a session is running, and on the terminals it left behind. */
import type { ICodexClient } from "../../app-server/client-interface.js";
import { Methods, type TurnSteerResult } from "../../app-server/protocol.js";
import {
  type BackgroundTerminalOutcome,
  type BackgroundTerminalsReport,
  ErrorCode,
  type SessionInfo,
  type SteerResult,
} from "../../types.js";
import type { SessionRuntime } from "./core.js";
import { recordEvent } from "./events.js";
import { messageOf } from "./read.js";
import { getClientOrThrow, getSessionOrThrow, threadTarget } from "./store.js";
import { buildUserInput, steerRefusal } from "./turn-params.js";

/**
 * Pages of `thread/backgroundTerminals/list` one call reads. The cursor is
 * followed to this bound and no further, and the report says `truncated: true`
 * when a cursor was still standing there.
 */
const MAX_BACKGROUND_TERMINAL_PAGES = 20;

/**
 * The session, its client and the turn it is running, or the error saying why not.
 *
 * `words` names the call in the errors the caller reads: `verb` as in "Cannot
 * steer session in idle state", `done` as in "cannot be steered".
 */
function runningTurnTarget(
  runtime: SessionRuntime,
  sessionId: string,
  words: { verb: string; done: string }
): { session: SessionInfo; client: ICodexClient; threadId: string; turnId: string } {
  const session = getSessionOrThrow(runtime, sessionId);

  // Status first: cancelSession drops the client, so a client lookup ahead of this
  // reports a cancelled session as SESSION_NOT_FOUND.
  if (session.status === "cancelled") {
    throw new Error(
      `Error [${ErrorCode.CANCELLED}]: Session '${sessionId}' has been cancelled and cannot be ${words.done}`
    );
  }
  if (session.status !== "running" && session.status !== "waiting_approval") {
    throw new Error(
      `Error [${ErrorCode.SESSION_NOT_RUNNING}]: Cannot ${words.verb} session in ${session.status} state`
    );
  }

  if (!session.threadId || !session.activeTurnId) {
    throw new Error(
      `Error [${ErrorCode.INTERNAL}]: Missing threadId or activeTurnId for ${words.verb}`
    );
  }

  return {
    session,
    client: getClientOrThrow(runtime, sessionId),
    threadId: session.threadId,
    turnId: session.activeTurnId,
  };
}

export async function interruptSession(runtime: SessionRuntime, sessionId: string): Promise<void> {
  const { client, threadId, turnId } = runningTurnTarget(runtime, sessionId, {
    verb: "interrupt",
    done: "interrupted",
  });

  await client.turnInterrupt({ threadId, turnId });
}

/**
 * Add input to the turn already running, so a caller can correct it instead of
 * throwing it away with `interruptSession`.
 *
 * Measured on codex-cli 0.150.1 against a stub holding the model response for
 * 8s, steered at 2s: `turn/steer` answered the running turn's id, sent no
 * `turn/started` and no `turn/completed`, delivered the steered text as a
 * `userMessage` item at +8232ms — the first model round trip after the steer —
 * and made a second upstream request inside the same turn carrying it. So
 * `activeTurnId`, `status` and `signalOf` do not move, and the one
 * `lastResult` of the turn is still written at its end.
 */
export async function steerSession(
  runtime: SessionRuntime,
  sessionId: string,
  prompt: string
): Promise<SteerResult> {
  const { session, client, threadId, turnId } = runningTurnTarget(runtime, sessionId, {
    verb: "steer",
    done: "steered",
  });

  let answer: TurnSteerResult;
  try {
    answer = await client.turnSteer({
      threadId,
      expectedTurnId: turnId,
      input: buildUserInput(prompt),
    });
  } catch (err) {
    throw steerRefusal(sessionId, turnId, err) ?? err;
  }

  session.lastActiveAt = new Date().toISOString();
  // Codex's rollout log holds the `userMessage` item and not who sent it, so
  // `events.jsonl` is the only place recording that this server put text into a
  // turn it did not start, and when.
  recordEvent(session, "progress", {
    method: Methods.TURN_STEER,
    threadId,
    turnId: answer.turnId,
  });
  // No `notifyWaiters`: a steer moves no field `signalOf` reads — the status,
  // the open request ids, the result instant, the activity instant and the
  // warning count all stand — so waking a long poll would hand it the state it
  // already has and spend a round trip of the caller's budget. The steer's own
  // answer is what says it landed.

  return {
    sessionId,
    threadId,
    turnId: answer.turnId,
    status: session.status,
    message:
      `Steered turn ${answer.turnId}, which was already running: no turn started, and this is the id of the turn the steer joined. ` +
      `Codex reads the added text at the turn's next model round trip, and the turn's one result still comes at its end — carry on polling.`,
  };
}

/**
 * Terminate every background terminal of a session's thread and report what
 * happened to each.
 *
 * `thread/backgroundTerminals/clean` answers an empty object, so it cannot say
 * which terminals it left running. The pass lists the thread, terminates each
 * process by id — `thread/backgroundTerminals/terminate` answers `terminated`
 * per process — and lists again, so `gone` is measured rather than assumed. A
 * terminal that started during the pass is in the second listing and in no
 * `terminals` entry: nothing tried to stop it, and the caller sees it standing.
 */
export async function cleanBackgroundTerminals(
  runtime: SessionRuntime,
  sessionId: string
): Promise<BackgroundTerminalsReport> {
  const { session, client, threadId } = backgroundTerminalTarget(runtime, sessionId);

  let listed: { terminals: BackgroundTerminalOutcome[]; truncated: boolean };
  try {
    listed = await listBackgroundTerminals(client, threadId);
  } catch (err: unknown) {
    // A CLI below 0.150.1 serves no thread/backgroundTerminals/list. The sweep
    // still runs, and it reports nothing, so the caller is told exactly that.
    await client.threadBackgroundTerminalsClean({ threadId });
    const report: BackgroundTerminalsReport = {
      threadId,
      terminals: [],
      cleanCalled: true,
      listError: { stage: "before", message: messageOf(err) },
    };
    recordBackgroundTerminals(session, report);
    return report;
  }

  for (const terminal of listed.terminals) {
    try {
      const answer = await client.threadBackgroundTerminalsTerminate({
        threadId,
        processId: terminal.processId,
      });
      terminal.terminated = answer.terminated;
    } catch (err: unknown) {
      terminal.error = messageOf(err);
    }
  }

  const report: BackgroundTerminalsReport = {
    threadId,
    terminals: listed.terminals,
    truncated: listed.truncated,
  };
  try {
    const after = await listBackgroundTerminals(client, threadId);
    report.survivors = after.terminals;
    const standing = new Set(after.terminals.map((terminal) => terminal.processId));
    for (const terminal of listed.terminals) terminal.gone = !standing.has(terminal.processId);
  } catch (err: unknown) {
    report.listError = { stage: "after", message: messageOf(err) };
  }
  recordBackgroundTerminals(session, report);
  return report;
}

/**
 * Terminate one background terminal. `terminated: false` is the answer, not an
 * error: the call reached Codex and the process stayed up.
 */
export async function terminateBackgroundTerminal(
  runtime: SessionRuntime,
  sessionId: string,
  processId: string
): Promise<BackgroundTerminalsReport> {
  const { session, client, threadId } = backgroundTerminalTarget(runtime, sessionId);

  const answer = await client.threadBackgroundTerminalsTerminate({ threadId, processId });
  const report: BackgroundTerminalsReport = {
    threadId,
    terminals: [{ processId, terminated: answer.terminated }],
  };
  recordBackgroundTerminals(session, report);
  return report;
}

/** The session, its client and its thread id, or the error that says why not. */
function backgroundTerminalTarget(
  runtime: SessionRuntime,
  sessionId: string
): { session: SessionInfo; client: ICodexClient; threadId: string } {
  return threadTarget(runtime, sessionId, {
    cancelled: `Session '${sessionId}' has been cancelled and its background terminals cannot be reached`,
    noThread: `Session '${sessionId}' has no threadId, so it has no background terminals to reach`,
  });
}

/** Read the thread's background terminals, following `nextCursor` to the page bound. */
async function listBackgroundTerminals(
  client: ICodexClient,
  threadId: string
): Promise<{ terminals: BackgroundTerminalOutcome[]; truncated: boolean }> {
  const terminals: BackgroundTerminalOutcome[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_BACKGROUND_TERMINAL_PAGES; page++) {
    const answer = await client.threadBackgroundTerminalsList(
      cursor === null ? { threadId } : { threadId, cursor }
    );
    for (const terminal of answer.data) terminals.push({ ...terminal });
    cursor = answer.nextCursor ?? null;
    if (cursor === null) return { terminals, truncated: false };
  }
  return { terminals, truncated: true };
}

function recordBackgroundTerminals(session: SessionInfo, report: BackgroundTerminalsReport): void {
  session.lastActiveAt = new Date().toISOString();
  recordEvent(session, "progress", {
    method: Methods.THREAD_BACKGROUND_TERMINALS_TERMINATE,
    threadId: report.threadId,
    terminals: report.terminals.length,
    gone: report.terminals.filter((terminal) => terminal.gone === true).length,
    surviving: report.survivors?.length,
    truncated: report.truncated,
    cleanCalled: report.cleanCalled,
    listError: report.listError,
  });
}
