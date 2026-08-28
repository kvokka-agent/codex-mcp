---
name: codex
description: Run work on Codex and show the person what it is doing while it runs. Use whenever work is handed to Codex — a patch, a question, a review, several tasks at once — and whenever a Codex session is still open.
---

# codex

Codex does the work. You start it, follow it round by round, and carry back what
it answered — word for word, never an account of it.

## Start

Call `codex` with the prompt verbatim. Where the caller named none, use
`model: gpt-5.6-luna`, `effort: high`, `approvalPolicy: never`,
`sandbox: workspace-write`, `advanced.approvalTimeoutMs: 900000`.

It returns at once with a `sessionId`, and the turn runs on. Start every session
the task asks for before you poll any of them: several Codex agents run at the
same time, one session each.

Where the caller hands you a `sessionId`, read it with
`codex_session(action="get", sessionId)` first. On `abandoned` the server that
held it is gone: `codex_session(action="resume", sessionId)` restores the thread,
then `codex_reply` carries it on. On any other status call `codex_reply` straight
away.

## Follow

```text
codex_check(action="poll", sessionId, waitMs: 300000)
```

Repeat it until `status` is `idle`, `error` or `cancelled`. Every other status —
`running`, `waiting_approval` — says the turn is going, and the answer to it is
the same call again. Poll every running session in one message: the calls run
together, and the round ends when the last of them answers.

The call comes back the moment Codex says it is working on something new, an
action arrives, the status changes or the turn ends — and at the end of the five
minutes otherwise. Every answer carries the whole state — `status`, `progress`,
`actions[]`, `interactionState`, `recommendedNextAction` — so repeat the same
call with nothing carried between rounds. The terminal answer carries `result`,
and so does every later check while the session stays terminal: a lost answer is
read back, never reconstructed.

## Write each round out

After every round that came back with the turn still running, write one line —
one per session, named where more than one is going:

```text
codex: <progress.activity>
codex: <progress.activity> — 15 min
```

`progress.activityStandingMs` is how long the session has been on that line;
write it in whole minutes once it passes one, and leave it off a line you are
writing for the first time. Where `progress.activity` is absent — the turn has
not said anything yet, or the backend is `codex exec`, which takes no activity
instruction — write `progress.phase` in its place and time it by `waitedMs`.

That line is the whole of what the person waiting sees, so it goes in the thread
they are reading. A poll made inside a subagent shows them nothing: the server's
`notifications/progress` reach the MCP client and are rendered under the call
that asked for them, and nobody is watching a subagent's calls. Drive the loop
yourself rather than handing it to one.

Report nothing else between rounds. "Still working" is a state of the poll, not
an answer, and a guess at what Codex is about to conclude is worse than either.

## Answer what it waits for

Every entry of `actions[]`:

- Approval — follow the standing decision the caller named. Otherwise accept what
  stays inside `cwd` and decline the rest.
- User input — answer it from the caller's prompt. Where that prompt holds no
  answer, stop and report `blocked`.

Where `recommendedNextAction` names a call, make that call.

## Close and report

Call `codex_session(action="cancel", sessionId)` once you hold the result, unless
you are reporting `blocked` or the caller asked for the session to stay open. The
close rewrites `status` to `cancelled` and leaves `lastTurn` alone, so read the
outcome, the model and the last activity from `codex_session(action="get")` after
it: a finished turn reads `status: cancelled` with `lastTurn.outcome: completed`.

Report one block per session:

```text
outcome: completed | error | cancelled | blocked
sessionId: <id>
model: <what codex_session answered, or unknown>
activity: <the last line the session said it was doing, or none>
session: closed | open: <reason>
declined: <what you declined, or none>
question: <what has to be decided, on blocked, else none>
result:
<what Codex answered, verbatim and whole>
```

`result` is last and runs to the end of the block: copy `result.text` character
for character, its own line breaks included. Where you hold no result, the whole
of `result` is `unavailable — <what the tools answered>` — not a summary, and not
a reconstruction from the lines you watched go past.

Where the session will not start, run `codex_setup`, put its answer in `result`
and report `outcome: error`.
