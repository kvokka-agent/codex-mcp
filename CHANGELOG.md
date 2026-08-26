# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.2.0] - 2026-08-26

First release of this fork. It carries the 2.1.1-2.1.7 work published on npm by @leo000001,
reconstructed from the sourcemaps of those packages, and adds the fixes and tests below.

### Fixed

- A server that cannot take the `STATE_DIR` lock runs from memory instead of touching the state directory another server owns. It previously warned and carried on: it recovered the other server's sessions, pruned their directories, and handed their live PIDs to the orphan reaper, which then killed the running codex processes of the first server.
- The orphan reaper confirms process identity by start time before it signals anything. Its `/proc` path compared no times at all and treated every live PID as an orphan when the recorded spawn time was under a day old, so a process that inherited a reused PID was killed. Where no source reports a start time, the process is left alone.
- The orphan reaper reads process creation time through `Get-CimInstance` on Windows, falling back to `wmic`. `wmic` ships disabled on Windows 11 24H2 and is absent from Server 2025, which left identity unverified. The `wmic` path also read its local timestamp as UTC and ignored the offset, so identity never matched off UTC.
- Session events reach `events.jsonl`. `appendEvent()` was called from nowhere, which left the event log dead code and the recovery scanner reading a file that never existed; `ingestRecovered()` also dropped the events it had just read. A recovered session now carries its events back, and its buffer ids continue the sequence written to disk.
- `forkSession()` writes `meta.json` and `pid.json` for the fork. The fork's directory was invisible to recovery and its child process invisible to the reaper.
- Retention measures a session directory in full. `getDirSize()` counted only top-level files, so a session whose bytes sat in subdirectories weighed zero and the disk limit never applied.
- A corrupt line in the middle of `events.jsonl` no longer discards every valid event after it. The count of skipped lines reaches the caller and stderr; a torn last line stays silent, since that is what a power cut leaves.
- `pid.json` records the model under `model`. It was written under `command`, a field no reader used.
- Path redaction applies to `error.message`, not only to a bare string. Real app-server errors always carry the object form, so redaction had never run on them.
- `ExecClient` reports errors in one shape, the `TurnError` object the protocol schema defines. It previously alternated between a bare string and an object, and retryable errors carried in `error.message` were read as terminal.
- `thread/status/changed`, `thread/closed`, `thread/compacted`, `deprecationNotice` and `configWarning` reach the client instead of falling into `default: break`. Session status stays governed by the pending-request map, so a status notification that arrives before its approval request, or after the answer, cannot strand a session.
- `check:stdio` waits 6 s for the server to exit on its own, up from 2 s. The old window killed the child on a cold runner and reported the kill as a runtime failure.
- An event carries one timestamp. `pushEvent` and `appendEvent` each read the clock, so the two disagreed across a millisecond boundary and a restored session handed the client a timestamp it had never polled. `appendEvent` now takes the timestamp and reads no clock of its own.
- A cancelled session answers `CANCELLED`. `replyToSession`, `interruptSession`, `cleanBackgroundTerminals` and `forkSession` looked the client up before they checked the status, and cancelling a session removes its client, so the caller was told `SESSION_NOT_FOUND` — the code for a session that never existed.

### Added

- `codex-schema/` is checked against `src/app-server/protocol.ts` on every test run: method names and parameter shapes are read from the schema bundle and from the TypeScript compiler, so protocol drift fails the build rather than waiting for a reader to notice. Methods absent from either side are listed with a stated reason.
- `AskForApproval` models the object variant with `reject`, `ThreadStartParams` carries `serviceName`, and `thread/name/updated` carries `threadName` — all three present in the schema, none modelled before.
- The `config` resource documents every `CODEX_MCP_*` variable the source reads, with its default; a test scans `src/` and fails when a variable has no line. The `delegation-guide` names all six effort levels, including `none` and `minimal`, and states the level a rejected `minimal` turn is retried at.
- The compat report distinguishes `diskPersistence` from `diskResume`: sessions survive a restart as history, and a recovered session has no codex process behind it.
- CI runs `check:stdio` and `smoke:mcp` across the matrix — the only checks that start the server and exercise the lock, recovery, reaping and stdout cleanliness. A separate job runs `rumdl` over the markdown, which nothing linted before.
- `scripts/mcp-smoke.mjs` checks the `codex_setup` tool and the `codex-mcp:///delegation-guide` resource.
- Tests: 98 to 771, line coverage 60.7% to 98.2%. Modules that arrived in 2.1.1-2.1.7 with no tests at all - persistence primitives, session persistence, orphan reaper, backend detection, exec client, `codex_setup`, executable resolution, foreground execution, turn compatibility, stdin shutdown - are covered, along with the MCP tool surface, the JSON-RPC client and the resource documents.

### Changed

- `docs/DESIGN.md` is in English and describes the server as it is now. `AGENTS.md` and `docs/E2E_LOCAL_TEST_PLAN.md` follow the same state.
- The event buffer evicts in one pass; `EventLog.destroy()` drops a branch that could not be reached.

## [2.1.7] - 2026-04-06

### Added

- **Progress reporting** — `codex`, `codex_reply` and `codex_check` return a `progress` object (`phase`, `lastEventAt`, `pendingActionCount`, token counts) so a client can show what the agent is doing between polls.
- **`codex_session` action `clean`** — bulk-removes sessions filtered by `statuses`, `olderThanMs`, with `dryRun` and `includeDisk` options.
- **`pollOptions.skipDeltas`** — advances the cursor past delta-heavy streaming events without returning them.
- **`pollOptions.finalOnly`** — result-centric polling: omits events, keeps actions, always includes the result.
- **effort/web_search compatibility fallback** (`src/utils/turn-compat.ts`) — a turn rejected because `effort=minimal` is incompatible with the Codex `web_search` tool is retried at a higher effort, and the response carries `compatWarnings`.

## [2.1.6] - 2026-04-06

### Changed

- The codex executable is resolved to a concrete filesystem path at startup instead of being spawned as a bare command name.
- `codex_setup` no longer probes auth/login state for a `codex-internal` executable and no longer blocks setup readiness on it.

## [2.1.5] - 2026-04-05

### Added

- **Disk persistence** — session metadata (`meta.json`), event logs (`events.jsonl`), and results (`result.json`) are now persisted to `~/.codex-mcp/state/` (configurable via `CODEX_MCP_STATE_DIR`). Surviving sessions are recovered on server restart with status `error` (reason: `server_restart`); completed results remain queryable.
- **Graceful shutdown with stdin drain** — when the MCP client disconnects (stdin closes), the server now waits up to 15 s (Windows) / 10 s (Unix) for active sessions to complete before forcing shutdown, matching claude-code-mcp behavior.
- **Orphan process reaper** — on startup, detects and terminates leaked `codex app-server` child processes from previous crashed server runs using PID + spawn-timestamp identity verification (cross-platform: `wmic` on Windows, `ps`/`/proc` on Linux).
- **Long-polling** — `codex_check(action="poll")` now accepts `pollOptions.waitMs` (max 120 s). When set, the server waits for new events/actions/status changes before returning, eliminating the approval-auto-decline race caused by sparse polling. Max 4 concurrent waiters per session.
- **TTL warning events** — sessions approaching idle/running TTL expiry receive a `codex-mcp/ttl_warning` progress event 60 s before cleanup (emitted once per session).
- **STATE_DIR lockfile** — prevents multiple server instances from corrupting the same state directory.
- **Tiered flush strategy** — critical events (approvals, results, errors) are flushed to disk immediately; progress/output events are batched every 100 ms.
- **Three-dimensional retention policy** — old sessions are pruned by age (7 days), count (200), and disk size (500 MB).
- **`codex_setup` tool** — reports codex executable, auth and app-server readiness.
- **Foreground execution** (`src/utils/execution.ts`) — `codex`/`codex_reply` can wait for a result instead of returning immediately.

### Fixed

- A failed approval forward is rolled back: the request returns to `pendingRequests` and the session back to `waiting_approval`, so the client can retry.

## [2.1.4] - 2026-04-03

### Fixed

- Secret redaction only masks POSIX paths with at least two segments, so ordinary strings like `/tmp` are left intact.
- Exec mode synthesizes `turn/completed` when the `codex exec` process exits, so the session leaves `running`.
- Exec mode removes the temporary directories holding generated output schemas on destroy.
- App-server detection force-kills the probe process with `SIGKILL` after a 2 s grace period.

### Changed

- Event buffer eviction runs in a single pass instead of repeated `findIndex` + `splice`.
- An approval is flagged resolved before its response is sent, so a timeout callback cannot answer it a second time.

## [2.1.3] - 2026-04-03

### Added

- **Exec fallback mode** — when the codex binary has no `app-server` subcommand (e.g. `codex-internal`), the server falls back to `codex exec --json`, with multi-turn context via `codex exec resume`. `CODEX_MCP_MODE` forces a mode and `CODEX_MCP_BINARY` names the binary.

## [2.1.1] - 2026-04-02

### Added

- **Codex executable configuration** — `CODEX_MCP_DEFAULT_CODEX_COMMAND` (PATH lookup) and `CODEX_MCP_DEFAULT_CODEX_PATH` (filesystem path) select the executable; the two are mutually exclusive. Without them the server tries `codex`, then `codex-internal`.

## [2.1.0] - 2026-02-27

### Breaking Changes

- `approvalPolicy`, `sandbox`, and `effort` are now **required** parameters in the `codex` tool — callers must explicitly set based on their own permission level and task complexity
- `effort` parameter promoted from `advanced.effort` to top-level parameter in the `codex` tool
- `codex_reply` parameter `sandboxPolicy` renamed to `sandbox`
- `codex_check` parameter `execpolicyAmendment` renamed to `execpolicy_amendment` to match app-server protocol field naming

### Changed

- All MCP-visible text (tool descriptions, parameter descriptions, resource descriptions) streamlined for conciseness
- `effort` description now suggests adjusting based on task complexity
- `replyToSession` now persists successful `model` / `approvalPolicy` / `sandbox` / `cwd` overrides to session metadata
- Process `exit` / `error` paths now emit terminal `result` payloads so `codex_check(action=\"poll\")` always includes a terminal `result` in error states
- `SessionManager` now deduplicates concurrent `cancelSession` calls and prevents terminal sessions from re-entering `waiting_approval` on late server requests
- Approval and user-input timeout timers now call `.unref()` to avoid blocking process exit
- Documentation aligned with implementation details for event eviction and e2e guidance
- Tool input defaults are now defined in schema (`cursor`, `maxEvents`, `includeSensitive`, `advanced.approvalTimeoutMs`) and client-facing text avoids duplicated default descriptions
- `codex_session` adds `clean_background_terminals` action to call `thread/background_terminals/clean`
- Approval action payloads now expose `approvalId` when provided by app-server
- Documentation was de-duplicated by splitting responsibilities between `AGENTS.md` (execution handbook) and `docs/DESIGN.md` (single source upgrade playbook), and a one-shot schema refresh runbook/record was added (`2026-02-21`, no schema diff)
- `src/app-server/protocol.ts` is now aligned to current v2 schema coverage for thread/turn params (`dynamicTools`, `persistExtendedHistory`, `collaborationMode`, richer `SandboxPolicy`, strict `UserInput` union, `turn/steer` params)
- `codex_check` input validation is now action-aware at schema level (`poll` vs `respond_permission` vs `respond_user_input`), including conditional `execpolicy_amendment` rules and forbidden-field checks
- Auth refresh request handling now uses explicit unsupported semantics (`-32000`) instead of `-32601` for `account/chatgptAuthTokens/refresh`
- Compatibility policy is now explicitly strict: removed non-essential alias compatibility (`approval_id`, `network_approval_context`, `questionId`) and documented a single necessary-compatibility whitelist (v1/v2 thread/turn id extraction)
- Command approval context is now surfaced directly in `actions[]` / `approval_request` payloads (`commandActions`, `proposedExecpolicyAmendment`) for richer client-side approval UX
- `turn/started` and `turn/completed` notification handling now only uses canonical `turn.id` shape (plus runtime `activeTurnId` fallback), and corresponding v1 top-level `turnId` compatibility tests were removed
- `compat-report` now correctly advertises `respondApprovalAlias: false` to match strict no-alias behavior
- Upgrade-policy docs were further de-duplicated: `docs/DESIGN.md` remains the single detailed compatibility source, and `AGENTS.md` now stays as a concise execution gate

## [0.1.0] - 2026-02-15

### Added

- Initial release
- 4 MCP tools: `codex`, `codex_reply`, `codex_session`, `codex_check`
- Async non-blocking session management
- Three-layer permission model (approval policy, sandbox, async approval)
- Cursor-based event polling with pin-protected buffer
- Session lifecycle: create, reply, cancel, interrupt, fork
- Command execution and file change approval flow
- User input request handling
- Automatic session cleanup (idle/running/terminal timeouts)
- Zero-config startup via `~/.codex/config.toml` inheritance
