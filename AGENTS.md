# Repo agent instructions (codex-mcp)

A TypeScript (ESM) MCP server that wraps the OpenAI Codex CLI. It spawns
`codex app-server` child processes — or falls back to `codex exec --json` for
binaries without an app-server — and exposes their capability as five MCP tools.

## Where the truth lives

- **[docs/DESIGN.md](docs/DESIGN.md)** — architecture, the protocol, persistence,
  the error model. Read it before changing anything under `src/app-server/`,
  `src/session/` or `src/persistence/`.
- **[docs/CODEX-UPGRADE.md](docs/CODEX-UPGRADE.md)** — the procedure for a Codex
  CLI, SDK or zod upgrade, and the audit record of the last one.
- **[docs/TOOLS.md](docs/TOOLS.md)** and **[docs/SESSIONS.md](docs/SESSIONS.md)** —
  the public surface. A change to a tool schema changes these.
- **[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)** — running your build in a real
  client, and what `npm run check` covers.
- **[docs/GLOSSARY.md](docs/GLOSSARY.md)** — the terms. Use them; do not invent
  synonyms.

This file holds what none of those do: the guardrails a change has to keep.

## The principle

Reuse the user's local Codex configuration, and expose the maximum of
`codex app-server` capability through the fewest tools and the least
configuration, while keeping execution non-blocking and permission handling
complete.

| Tool | Responsibility | Blocking |
| --- | --- | --- |
| `codex` | start a session | waits for the thread only, or for `waitForResult` |
| `codex_reply` | continue a session | returns at once, or waits for `waitForResult` |
| `codex_setup` | report executable, auth and backend readiness | sync |
| `codex_session` | list, get, resume, cancel, interrupt, fork, clean, clean background terminals | sync |
| `codex_check` | report status and answer what the session waits for | sync, or long-poll on `waitMs` |

A session is driven by exactly one codex-mcp process, which records itself in
the session's directory as `owner.json`. Several servers share one state
directory; each acts only on what it owns, a session left behind by a dead
server is `abandoned`, and `codex_session(action="resume")` picks it back up.

## Prerequisites

Node.js >= 18, and a `codex` on PATH that answers `codex --version`.

## Commands

`npm run check` is the gate — lint, format, types, tests, build, the two runtime
scripts and the markdown lint. Run it before opening a pull request. `npm run`
lists the rest.

## Layout

```text
src/
├── index.ts            startup, shutdown, the transport
├── server.ts           tool registration and the zod schemas
├── types.ts            shared constants, statuses, defaults
├── app-server/         the two backends and the wire protocol
│   ├── client.ts             app-server JSON-RPC over stdio
│   ├── client-interface.ts   what a backend must implement
│   ├── exec-client.ts        the codex exec --json fallback
│   ├── detect.ts             which backend this binary carries
│   ├── codex-bin.ts          how to spawn it on this platform
│   ├── protocol.ts           method names and message types
│   └── lifecycle.ts
├── persistence/        the state directory
│   ├── index.ts
│   ├── atomic-writer.ts
│   ├── session-owner.ts      owner.json and what a recorded owner is
│   ├── process-identity.ts   pid liveness and start time
│   ├── event-log.ts
│   ├── recovery-scanner.ts
│   ├── retention.ts
│   └── fs-errors.ts
├── session/
│   ├── manager.ts            the state machine
│   ├── persistence.ts        the disk adapter
│   ├── activity-marker.ts
│   └── orphan-reaper.ts
├── tools/              one file per tool
├── utils/
└── resources/register-resources.ts
```

## Conventions

- ESM and TypeScript. Local imports carry the `.js` suffix.
- `unknown` plus narrowing, never `any`.
- Validation lives in the zod schemas of `src/server.ts`.
- Tool responses stay MCP-safe: `{ content, structuredContent?, isError }`.
- Diagnostics go to `console.error`. stdout is the MCP channel and carries
  nothing but JSON-RPC.
- `approvalPolicy` and `sandbox` stay required on `codex`.
- Sensitive fields stay redacted unless the caller passes
  `includeSensitive: true`.

## Guardrails

These are the patterns a change keeps, each of them written after it was broken:

- Register app-server handlers before `client.start()`, or an `error` event
  crashes the process unhandled.
- Wrap approval-timeout callbacks in try/catch — the client may already be
  destroyed.
- Keep `cancelSession` idempotent for an already-cancelled session.
- On `TURN_COMPLETED`, capture `activeTurnId` before clearing it, or
  `lastResult.turnId` comes out empty.
- If `replyToSession` fails during `turnStart`, put the session back to `error`.
- Serialize `-c key=value` by type: primitives through `String()`, objects and
  arrays through `JSON.stringify()`.
- `.unref()` every cleanup, shutdown and force-kill timer, or Node cannot exit.
- Call `notifyWaiters(sessionId)` after any state change, or long-poll callers
  block until their `waitMs` budget expires.
- Verify a pid's recorded spawn time before signalling it; an unverified pid is
  skipped, never killed.
- **Carry through what a dependency answered.** An unreadable directory is not
  an empty one, an `EPERM` from `process.kill(pid, 0)` means the process lives
  under another user, and a turn that produced no recognized event did not
  succeed. A fallback that manufactures a value turns a failure into plausible
  data.
- **Ask a path for the value, not for its existence.** `existsSync` answers
  `false` on `EACCES` too, so the check hides the permission denial.
- **Best-effort covers only what the caller cannot act on** — clearing a timer,
  signalling a dead process, losing a race with a concurrent unlink. Keep every
  persistence call in try/catch so a read-only state directory degrades
  persistence instead of failing the tool call, and log what failed.
- Read the schema before branching on a protocol field.
  `AgentMessageThreadItem` requires `id`, `text` and `type` and carries no
  `status`, so a `status === "completed"` check there matched nothing and
  returned every foreground answer empty.
- A job that calls a reusable workflow declares every permission the called
  workflow's jobs ask the token for. GitHub refuses the whole file at startup
  otherwise — `The nested job 'publish' is requesting 'id-token: write', but is
  only allowed 'id-token: none'` — with no job run and no log to read.
  `actionlint` checks one file at a time and passes it; `tests/workflows.test.ts`
  reads both sides, so `npm run check` catches it before the push.

## Tests

- Vitest, `describe`/`it`, a fresh `SessionManager` in `beforeEach` and
  `manager.destroy()` in `afterEach`.
- Deterministic, no network, the codex child process mocked.
- A test asserts on a value the code under test produced.
- `tests/protocol-schema.test.ts` holds `protocol.ts` against `codex-schema/`
  and fails on drift. A new protocol field gets a check there.
- `tests/server-lifecycle.e2e.test.ts` drives the built server as a child
  process against `tests/helpers/fake-codex.mjs`, and skips itself on Windows —
  the stand-in is a `.mjs` and Windows spawns by extension. What it measures
  carries evidence from Linux and macOS only;
  [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md#run-the-checks) lists it.

## Git and pull requests

- Branches: `feat/<name>`, `fix/<name>`, `refactor/<name>`, `docs/<name>`.
- Conventional Commits.
- Open every pull request against `kvokka/codex-mcp`; a fork such as
  `kvokka-agent/codex-mcp` only holds the branch:
  `gh pr create --repo kvokka/codex-mcp --base master --head <fork-owner>:<branch>`.
- A `release:major`, `release:minor` or `release:patch` label cuts the release
  when the pull request merges — [docs/RELEASING.md](docs/RELEASING.md).
- Never commit `dist/`, `node_modules/` or `.env`.
