# Following a Codex CLI release

`codex-mcp` spawns `codex app-server` and speaks its JSON-RPC wire format, so a
Codex CLI upgrade is a protocol upgrade. This document is the procedure for one.
The same procedure covers a change in `@modelcontextprotocol/sdk`, in `zod`, or
in the bun/TypeScript floor that moves a tool interface.

## What decides

1. The vendored schema — `codex-schema/`, `codex-schema/metadata.json`. It
   records what actually arrives on the wire.
2. The implementation — `src/app-server/wire/` and everything reading it.
   It is this repository's model of the schema, and the model is the side that
   drifts.
3. The documents.

On a conflict the schema wins and the code and the documents follow it. The
CHANGELOG helps locate a change; it never stands in for comparing the schema.

`tests/protocol-schema.test.ts` holds the two sides together: it reads method
names and parameter shapes from `codex-schema/*.json` and the types from the
TypeScript compiler, and fails on drift. Methods the schema does not carry are
listed there with their reason. A new protocol field gets a check added to that
file.

## The pass

```bash
codex --version
codex app-server generate-json-schema --experimental --out codex-schema
git diff --name-only -- codex-schema
git diff -- codex-schema/metadata.json
```

No diff: record the run in **Latest run** below and stop.

Diffs: work through the rest of this document and close the code, test and
document loop in the same pull request.

## Classifying a diff

| The schema | What follows |
| --- | --- |
| adds a field | Pass it through, complete the types, state its default and whether it is optional, add a regression test |
| renames a field | Switch to the new name and write no dual-write compatibility. If compatibility is unavoidable, record its scope, its removal version and its test |
| removes a field | Delete the implementation and the documentation of it, state the error the old parameter now raises, and test that misuse |
| changes semantics | Move the state machine, the error model and the checking semantics together, and state the new behaviour in the documents |

Before branching on a field of a protocol message, open its definition in
`codex-schema/` and read whether the field exists and whether `required` lists
it. `AgentMessageThreadItem` requires `id`, `text` and `type` and carries no
`status`, so a `status === "completed"` check there matched nothing and returned
every foreground answer empty.

Public MCP parameter names match the upstream field names exactly: `snake_case`
stays `snake_case`, `camelCase` stays `camelCase`.

## No compatibility layer

The server reads the shapes the vendored schema carries and nothing else. A
`thread/start`, `thread/fork` or `thread/resume` answer that does not put the id
at `thread.id` raises `INTERNAL` rather than being read from an older place: a
session needs a real thread id, so an unreadable answer is a backend this server
cannot drive.

The id is the only field of those three answers that raises. The settings block
beside it — `model`, `modelProvider`, `cwd`, `approvalPolicy`, `sandbox`,
`reasoningEffort` — degrades instead: a session runs without knowing what it
runs with, so a field the answer does not carry in the shape the schema gives it
leaves the session keeping what the caller asked for and reporting the effective
value as unknown. Nothing is invented to fill the gap, and nothing is read from
another place. The `snake_case` aliases `approval_id` and
`network_approval_context` are refused, and so is the user-input question-id
alias `questionId` — the schema field `id` is the only accepted name.

A compatibility layer that becomes unavoidable records its scope, its removal
version and its test in the same pull request that adds it.

Deprecated methods the schema still carries — `applyPatchApproval`,
`execCommandApproval` — are protocol coverage, not compatibility: the server
answers them because a CLI still sends them.

## Closing a field change

An interface change touches every one of these, or states why it does not:

- `src/server.ts` — the tool input and output schemas
- `src/tools/*.ts`
- `src/session/manager/`
- `src/app-server/wire/`, `src/types.ts`
- `docs/TOOLS.md`, `docs/SESSIONS.md`, `docs/DESIGN.md`
- `docs/E2E_LOCAL_TEST_PLAN.md`
- `CHANGELOG.md`, under `## [Unreleased]`
- the matching `tests/*.test.ts`

Then `bun run check`.

## Latest run

- Date: `2026-08-29`, local environment
- `codex` version: `codex-cli 0.150.1`
- Command: `codex app-server generate-json-schema --experimental --out codex-schema`
- Result: a diff across the whole bundle. Client request methods went from 52 to
  153, server notifications from 41 to 79 and server-to-client requests from 7
  to 11; the `v1/` conversation API is down to `InitializeParams` and
  `InitializeResponse`, and `EventMsg.json` — the schema of the
  `codex exec --json` event stream — is gone. `src/app-server/wire/`, the
  tests and the documents followed in the same pull request.

Each pass overwrites this section.
