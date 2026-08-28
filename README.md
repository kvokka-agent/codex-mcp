# codex-mcp

[![npm version](https://img.shields.io/npm/v/@kvokka/codex-mcp.svg)](https://www.npmjs.com/package/@kvokka/codex-mcp)
[![license](https://img.shields.io/npm/l/@kvokka/codex-mcp.svg)](https://github.com/kvokka/codex-mcp/blob/master/LICENSE)
[![node](https://img.shields.io/node/v/@kvokka/codex-mcp.svg)](https://nodejs.org)

Use [OpenAI Codex](https://github.com/openai/codex) as a native Claude agent with
your subscription.

TL;DR

[docs/COMPARISON.md](docs/COMPARISON.md)

## Features

- Support multiple agents on 1 repo/worktree in parallel
- Async execution
- Long sessions support
- Bi-directional communication
- Progress execution updates
- No agent execution time limit
- Session resume
- RAM, context and tokens efficient
- Codex config support + various customisations
- Use codex app-server
- Auto cleanup for finished and abandoned agents
- Follow Anthropic ToS

Almost like Caude native agent

## Install

- [bun](https://bun.com) >= 1.4
- [Codex CLI](https://github.com/openai/codex) installed and logged in.

### Claude Code

```text
/plugin marketplace add kvokka/codex-mcp
/plugin install codex-mcp@codex-mcp
```

The plugin installs the server, a `codex` subagent that proxies one prompt to
Codex and reports the turn's progress and answer, and a hook that keeps the Codex
tools inside that subagent.
[plugins/codex-mcp/README.md](plugins/codex-mcp/README.md) says what each piece
does.

### Any other MCP client

```json
{
  "mcpServers": {
    "codex-mcp": {
      "command": "bunx",
      "args": ["@kvokka/codex-mcp"]
    }
  }
}
```

[docs/INSTALL.md](docs/INSTALL.md) covers the global install, the Windows
wrapper, picking the codex binary, and every environment variable.

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
