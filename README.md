# codex-mcp

[![npm version](https://img.shields.io/npm/v/@kvokka/codex-mcp.svg)](https://www.npmjs.com/package/@kvokka/codex-mcp)
[![license](https://img.shields.io/npm/l/@kvokka/codex-mcp.svg)](https://github.com/kvokka/codex-mcp/blob/master/LICENSE)
[![node](https://img.shields.io/node/v/@kvokka/codex-mcp.svg)](https://nodejs.org)

An MCP server that runs [OpenAI Codex](https://github.com/openai/codex) as a
background agent. Start a session, get an id back, check on it: five tools, any
MCP client, one Codex process per session.

## What it is for

Handing a long pass — review this diff, QA this change, fix this suite — to
Codex from inside an agent run, and getting the answer back without the run
paying for the transcript.

- **A turn is not bounded by a tool call.** `codex` returns as soon as the
  session starts; `codex_check` waits for the next thing the caller must act on.
  A turn that thinks for twenty minutes is checked, not killed.
- **The caller reads status, not events.** Where the session stands, what it
  waits for, one line in Codex's own words saying what it is doing, and the
  result when the turn ends. Codex's own rollout log keeps the transcript.
- **Sessions run at once.** One child process per session and no lock above
  them.
- **A session outlives the process driving it.** When the server goes away
  mid-turn the session comes back as `abandoned`, and
  `codex_session(action="resume")` picks the thread up where Codex left it.
- **Codex asks before it acts.** Approval requests arrive as `actions[]` and the
  turn waits for an answer.
- **Your Codex configuration is the configuration.** Model, profile and sandbox
  defaults come from `~/.codex/config.toml`; a call overrides what it needs.

## Install

Node.js >= 18, and the [Codex CLI](https://github.com/openai/codex) installed and
logged in.

### Claude Code

```text
/plugin marketplace add kvokka/codex-mcp
/plugin install codex-mcp@codex-mcp
```

The plugin installs the server, a `codex` subagent that drives one turn to its
result, and a hook that keeps the Codex tools inside that subagent.
[plugins/codex-mcp/README.md](plugins/codex-mcp/README.md) says what each piece
does.

### Any other MCP client

```json
{
  "mcpServers": {
    "codex-mcp": {
      "command": "npx",
      "args": ["-y", "@kvokka/codex-mcp"]
    }
  }
}
```

[docs/INSTALL.md](docs/INSTALL.md) covers the global install, the Windows
wrapper, picking the codex binary, and every environment variable.

## How it compares

Against `openai/codex-plugin-cc`, the closest alternative: codex-mcp serves any
MCP client rather than Claude Code alone, runs sessions concurrently rather than
one turn at a time behind a single-flight broker, carries a turn past any Bash
ceiling, keeps a session alive when the client dies, and makes Codex ask before
it writes. `codex-plugin-cc` reaches further where the client does: hooks, slash
commands, skills, and asking the person a question mid-flow.

[docs/COMPARISON.md](docs/COMPARISON.md) puts each of those against the source
that proves it, marks the measurements and their conditions, and lists what
codex-mcp does not do.

## Documentation

| Document | What it holds |
| --- | --- |
| [docs/GLOSSARY.md](docs/GLOSSARY.md) | Every term the other documents use |
| [docs/INSTALL.md](docs/INSTALL.md) | Installing, client configuration, environment variables |
| [docs/TOOLS.md](docs/TOOLS.md) | The five tools and the read-only resources, input by input |
| [docs/SESSIONS.md](docs/SESSIONS.md) | Running a session: checking, approvals, activity, resume, cleanup |
| [docs/COMPARISON.md](docs/COMPARISON.md) | codex-mcp against the alternatives, and its own limits |
| [docs/DESIGN.md](docs/DESIGN.md) | Architecture, the app-server protocol, persistence, error model |
| [docs/CODEX-UPGRADE.md](docs/CODEX-UPGRADE.md) | Following a Codex CLI release through the vendored schema |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | Running your build in a real client, the checks, debugging |
| [docs/RELEASING.md](docs/RELEASING.md) | The release label and what the merge does with it |
| [docs/E2E_LOCAL_TEST_PLAN.md](docs/E2E_LOCAL_TEST_PLAN.md) | The end-to-end plan an MCP client's model executes |
| [AGENTS.md](AGENTS.md) | The handbook for a coding agent working on this repository |

## Project policies

- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)

## License

[MIT](LICENSE)
