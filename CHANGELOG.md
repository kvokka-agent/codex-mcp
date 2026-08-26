# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.2.0] - 2026-08-26

First release of this fork. It carries the 2.1.1-2.1.7 work published on npm by @leo000001,
reconstructed from the sourcemaps of those packages, and adds the fixes and tests below.

### Fixed

- An answer a caller marked secret stays out of the log. `ToolRequestUserInputQuestion.isSecret` marks a question whose answer is a secret, and `resolveUserInput()` put the answers straight into the event buffer and `events.jsonl`. The answer reaches codex as given; the log records `<secret>`.
- The client asks for the `experimentalApi` capability. It sent `clientInfo` alone, so the connection ran with the schema default of `false` — and the schema marks `item/tool/requestUserInput` and `item/plan/delta` as experimental. The whole user-input path in the manager served requests the backend never sent.
- An `exec` turn keeps the answer the CLI gave it. `EventMsg.json` carries the reply in `agent_message`, which the event table did not map at all, and in `task_complete.last_agent_message`, which nothing read — so a legacy stream, the very reason exec mode exists, finished a turn with an empty answer.
- Command output is visible in exec mode. `ExecCommandOutputDeltaEventMsg` names the payload `chunk` while the app-server notification names it `delta`, so the noise filter, the delta coalescing and the compact response found nothing. The exec client now hands over the shape the app-server schema declares, and renames it only when the CLI sent a string, since the schema types those bytes as possibly not UTF-8. `agent_message_content_delta`, `plan_delta`, both reasoning deltas and `agent_reasoning_section_break` carried the same snake_case mismatch.
- An interrupted `exec` turn reports `interrupted`, a status `TurnStatus` defines; it reported `cancelled`, which the protocol does not carry.
- `context_compacted` and `deprecation_notice` reach the client from exec mode. Both exist in `EventMsg.json` and both have handlers, but the event table dropped them as unknown. Four keys of that table named events the schema does not define at all.
- `thread/started` reports the thread status. `Thread.status` is an object union, and the code read it as a string, so the field was empty every time.
- `progress.percent` is gone. Nothing in the bundle carries a per-turn percentage — the only percent is the account rate-limit window — so the field was promised to clients and never filled. The tests that covered it emitted payload shapes the schema does not define; they now emit what the schema says arrives.
- The token counters of a finished turn no longer outrank a later `thread/tokenUsage/updated`.
- `rawResponseItem/completed` is parsed as the `ResponseItem` it carries. It was matched against `agentMessage` and `text`, which belong to the `ThreadItem` hierarchy, so the branch was false in both modes.
- `extractThreadId()` and `extractTurnId()` no longer accept a top-level `threadId` or `turnId`. No response in the bundle carries either — v1 answers `conversationId`, v2 answers `thread` and `turn` — and a test pinned the shape that never existed.
- An answer to an approval request now fails when it could not be written. `AppServerClient.respondToServer()` swallowed the write error and returned, so the rollback in `resolveApproval()` was unreachable: a `decline` lost to backpressure was reported to the caller as delivered, the request left the pending map, the session went back to `running`, and codex waited for an answer that never came until its TTL expired.
- A lock held by a live process of another user is no longer reclaimed. `isPidAlive()` read every `process.kill(pid, 0)` failure as death, but the kernel raises `EPERM` for a process that is alive and owned by someone else, so a second server on a shared `STATE_DIR` deleted the first server's lock and both wrote to the same session directory. A lockfile that carries no readable pid is left alone as well.
- A recovered session keeps the timestamps it was stored with. `ingestRecovered()` stamped `lastActiveAt` with the current clock and wrote it back to disk, and retention selects directories by that field — so a session cut off mid-run grew younger at every restart and was never pruned by age. It no longer invents `cwd` either, and a status it cannot read now carries the reason.
- The orphan reaper terminates the process group, as ordinary cleanup does. Both clients spawn codex detached and signal `-pid` when they shut down, but the reaper signalled the leader alone and `taskkill` without `/T`, so commands and background terminals outlived a reap that reported success. The group is signalled only when the recorded pid leads its own group, read from the same snapshot as the start time.
- `ReapSummary.reaped` counts confirmed exits. It counted attempts: a process that ignored `SIGTERM` where no source could answer for its identity was reported as reaped. Signalled processes whose exit could not be confirmed are counted separately, and the startup log names them.
- A failed filesystem read reaches the caller instead of passing for an empty directory. `scanRecoverableSessions()` and `pruneSessionDirs()` answered `[]` and `0` when they could not list the state directory; `existsSync()` reports `false` on `EACCES` too, so the check itself hid the refusal. A session whose `meta.json` cannot be parsed is now recovered from what the directory itself states rather than dropped, which keeps its `pid.json` reachable for the reaper.
- `codex_reply` reports the overrides that did not take effect. `codex exec resume` accepts no `-s`, `-C` or `--output-schema`, and the request answered with plain success: narrowing a session to `read-only` on a later turn left codex writing under `workspace-write`. The unapplied overrides now reach the caller through `compatWarnings`, and a dropped `outputSchema` also clears the schema-constrained mark.
- An `exec` turn no longer reports success it cannot back. A process that exited zero without a single recognised event, or one that lost a JSONL line and would otherwise hand back the previous turn's text as final, completes as `failed` and says how many records were lost. A schema that could not be written now fails the turn instead of starting it without `--output-schema`, and `threadBackgroundTerminalsClean()` refuses in exec mode instead of answering `{}` to a caller told the terminals were cleaned.
- A probe that never answered is no longer read as "this CLI has no app-server". A five-second timeout and a spawn failure both meant `exec` for the life of the process — approvals gone, `fork` and `resume` refused — and a restart made it go away without explaining anything. The timeout is retried once with a longer budget, and each outcome says which one it was.
- An aborted foreground wait no longer spins. `waitForChange()` resolves at once for an aborted signal and the loop did not check, so the caller burned the event loop until its deadline — up to 300 s. A wait refused for lack of waiter slots is reported as `wait_refused` instead of `wait_for_result_timeout`, which had the caller believe the turn was still running.
- The compat report states whether disk persistence is actually on. It was hardcoded to `true`, so a server running from memory told clients their sessions would survive a restart. `serverInfo` no longer assumes `app-server` for the backend either, and `codexCliVersion` reports nothing rather than the first word of an error message.
- `codex_setup` answers `ready: false` for an auth state it could not classify; it treated anything other than an outright `unauthenticated` as good enough.
- Restored events keep the timestamps from the log; a line without one is dropped and counted rather than stamped with the time of the restart.
- Persistence failures are visible. Writes of session metadata, results and `pid.json`, and the removal of a session directory, each failed in silence: a lost `pid.json` left a codex process nothing would reap, and `codex_session action=clean` reported a removal that had not happened.
- A server whose state directory cannot be created starts without persistence instead of exiting. The `SessionPersistence` constructor throws from `mkdirSync` before the fallback could apply.
- Recovery no longer returns sessions that pruning has already deleted.
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

- The documents the server hands its clients are checked against the schema bundle on every test run: a field path a resource names must resolve in a tool schema or in `codex-schema/`, so a promise the backend does not back fails the build. `initialize` is checked the same way — the capabilities the client actually writes to stdin are read back and matched against `InitializeParams`.
- `codex-schema/` is checked against `src/app-server/protocol.ts` on every test run: method names and parameter shapes are read from the schema bundle and from the TypeScript compiler, so protocol drift fails the build rather than waiting for a reader to notice. Methods absent from either side are listed with a stated reason.
- `AskForApproval` models the object variant with `reject`, `ThreadStartParams` carries `serviceName`, and `thread/name/updated` carries `threadName` — all three present in the schema, none modelled before.
- The `config` resource documents every `CODEX_MCP_*` variable the source reads, with its default; a test scans `src/` and fails when a variable has no line. The `delegation-guide` names all six effort levels, including `none` and `minimal`, and states the level a rejected `minimal` turn is retried at.
- The compat report distinguishes `diskPersistence` from `diskResume`: sessions survive a restart as history, and a recovered session has no codex process behind it.
- CI runs `check:stdio` and `smoke:mcp` across the matrix — the only checks that start the server and exercise the lock, recovery, reaping and stdout cleanliness. A separate job runs `rumdl` over the markdown, which nothing linted before.
- `scripts/mcp-smoke.mjs` checks the `codex_setup` tool and the `codex-mcp:///delegation-guide` resource.
- Tests: 98 to 907, line coverage 60.7% to 98.5%. Modules that arrived in 2.1.1-2.1.7 with no tests at all - persistence primitives, session persistence, orphan reaper, backend detection, exec client, `codex_setup`, executable resolution, foreground execution, turn compatibility, stdin shutdown - are covered, along with the MCP tool surface, the JSON-RPC client and the resource documents.

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
