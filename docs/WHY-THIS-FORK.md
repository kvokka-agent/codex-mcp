# Why This Fork

Nobody set out to maintain a fork. The owner of this one wanted to hand QA and code review from
Claude Code to Codex, tried the official plugin and every wrapper he could find, and worked out from
first principles what the connector would have to look like. That design already existed — it was
`xihuai18/codex-mcp`. Adopting it meant reading its source, and its source stopped at 2.1.0 while the
package `npm install` gave him was 2.1.7. Closing that gap is what this fork is; see
[Relationship to the upstream project](../README.md#relationship-to-the-upstream-project).

This document covers the part before that: why none of the ready-made paths closed the task.

## What he wanted

Move the heavy, repetitive passes — review a diff, QA a change — off the Claude subscription and onto
Codex, which he pays for separately. Two constraints ruled out running Codex by hand:

- The work arrives from agents. Delegation has to happen inside an agent run, with no person carrying
  a task across.
- Each side stays on its own credentials. No token from one vendor is forwarded into another vendor's
  client.

A review pass runs for tens of minutes. That number is what every candidate below broke on.

## What he tried

**`openai/codex-plugin-cc`, OpenAI's own plugin for Claude Code.** He installed it and ran it.
Claude Code's Bash tool caps one call at 600,000 ms and nothing raises that, so a Codex run past ten
minutes has to go to the background — and keeping a background delegation alive means the calling
subagent emits heartbeats, spending the context the delegation was supposed to save. The plugin
forwards no profile to Codex: model, reasoning effort and sandbox are whatever its broker read when
the broker started. That broker resolves configuration once per process and holds it until the
process dies, so a TypeScript repository and a Python repository with different harnesses get
identical settings. The repository had gone a month without commits.

**`codex mcp-server`.** OpenAI deprecated it in favour of the app server, and said why: the
request/response shape of an MCP tool does not carry streaming diffs, approval workflows, thread
persistence, or requests the server initiates. MCP stays supported for connecting tools *to* Codex;
the app server is how clients connect to Codex. Usable as a stopgap, not as a foundation.

**`codex exec` from a subagent's Bash call.** The plainest path, and the same 600,000 ms ceiling.
`codex exec` also has no way to ask its caller a question mid-run, which blocks any task where the
reviewer needs a decision before it can finish.

**PAL MCP and its `clink` tool.** It is the idea done properly — external CLIs wired in as tools,
role specialisation, fresh context per delegation. He found the project no longer maintained, and
would not put his workflow on an unmaintained bridge.

**Orchestrators standing above both CLIs** — Conductor, Emdash, batty, Vibe Kanban and the rest. This
inverts the hierarchy: the agent is no longer in charge of its own delegation, and the orchestration
protocol takes a large share of every prompt. Several projects in that category had already been
deprecated or handed to community maintenance.

**`raysonmeng/agent-bridge`.** Closest in shape to what he wanted: MCP notifications bridged into the
Codex app server over JSON-RPC. Its daemon accepts exactly one attached Claude Code session and
refuses the second, and inside a session it has no addressing at all — every message carries a
`source` of either `claude` or `codex`, and the bridge never routes back to a source. Two subagents
delegating at once would write into one channel and read each other's answers. The design is two
agents pair-programming under a person's eye, not fan-out delegation.

**`EthanSK/agent-bridge`.** Solves the addressing: personas scope inboxes, `codex bind` attaches to a
thread id, and queued messages wake a task instead of the task polling. He passed on it as a
dependency because it is built for a different pairing, it carries SSH and cross-machine delivery he
does not need, and it rests on Claude Code Channels — a research preview that requires a claude.ai
login and loads custom channels only behind
`--dangerously-load-development-channels`. Channels also push into the session, not into the
subagent, which inverts the context isolation the whole scheme was for.

**`stablyai/orca`.** A free ADE that aims to cover the entire development cycle and delivers strong value for the price. Each agent gets roughly 20k tokens of extra context. However, every sub-agent session launches as a separate process (including its own terminal and agent runtime) and stays open until the user closes it, creating a real risk of OOM. The sub-agents use a flat structure, so a heavy session can easily consume 10–20 GB of RAM and leave a chaotic mess of open resources. This architecture can’t be changed, yet the project still has huge potential.

**Putting a cheaper model under Claude Code** — a router on `ANTHROPIC_BASE_URL`, or a TLS intercept
in front of the client. Anthropic's consumer terms do not allow a subscription OAuth token in another
client, and the server rejects it in practice. He dropped the line.

## What worked

The shape he arrived at, and the shape upstream had already built:

- One MCP server on stdio. The 600,000 ms Bash ceiling does not apply, because the MCP server spawns
  the Codex process, not Claude Code's Bash tool. Claude Code's default MCP tool timeout is measured
  in hours, and stdio servers get a 30-minute idle window — against five minutes for HTTP and SSE,
  plus a separate first-byte timer.
- Progress travels as protocol notifications. They never reach the model, so a long run stays visible
  without spending a token of context.
- Configuration is resolved per call, not per process. `--profile` picks the profile on the call, and
  `cwd` on the call, so one server serves repositories with different harnesses.
- A session id comes back, and a second tool continues that session with `exec resume` after the code
  is fixed — no re-reading the repository from scratch.
- A native subagent wraps the tool. That layer is what makes the delegation render like any other
  subagent and keeps the output out of the main context; it is five lines of markdown, and it is the
  one piece no upstream project supplies, because it belongs to the client.

The server's own version of this — five tools, the poll model, the event buffer, the three-layer
permission model, the app-server backend with an `exec` fallback — is in [DESIGN.md](DESIGN.md) and
the [README](../README.md).

## Limits he took on knowingly

- **No question mid-run.** A reviewer that needs a decision returns `status: blocked` with the
  question rather than prompting; the caller answers through a follow-up turn on the same session.
- **The model cannot intervene mid-call.** Interactivity and context isolation are the same axis:
  anything that reaches the model costs context, and anything that costs nothing never reaches it.
  Visibility here is for the person watching, not for the model.
- **The result still costs tokens to read.** Returning a summary plus a path to the full report keeps
  the bill proportional to what gets acted on.
- **The wrapper subagent spends a few thousand tokens per delegation.** That is the price of the
  native rendering.
- **One Codex process per job.** Cold start is noise against a twenty-minute review, and process
  isolation is worth more than a warm pool.
- **The saving is partial.** Orchestration, writing the brief and reading the answer stay on the
  Claude side. What moves is the heavy pass.

## What the record does not cover

The conversation ends with the decision to spend a week on `xihuai18/codex-mcp`. Finding that its
published source and its published package had drifted, reconstructing 2.1.1 through 2.1.7 from
sourcemaps, and choosing to maintain a fork all happened after it, and none of it is in the
transcript.
