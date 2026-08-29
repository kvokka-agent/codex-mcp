# Contributing to codex-mcp

## The gate

```bash
bun install --frozen-lockfile
bun run check
```

`bun run check` is what CI runs: lint, format, types, build, the tests under
coverage with the fallow static analysis over them, the two runtime scripts, and
the markdown lint. A pull request passes it before it is opened.

[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) sets up the loop that command does
not cover: running your build inside a real Claude Code session, restarting the
server after a rebuild, and reading its logs. [AGENTS.md](AGENTS.md) holds the
code conventions and the implementation patterns this repository keeps.

## Pull requests

1. Branch from `master`.
2. Make the change, and update the documents it makes wrong in the same branch.
3. `bun run check`.
4. Open the pull request against `kvokka/codex-mcp`; a fork only holds the
   branch.

A `release:major`, `release:minor` or `release:patch` label cuts the release
when the pull request merges — [docs/RELEASING.md](docs/RELEASING.md) says what
the merge does with it. A pull request without one merges without releasing.

## Reporting issues

Use [GitHub Issues](https://github.com/kvokka/codex-mcp/issues). Include the
steps to reproduce, what you expected against what happened, and the bun and
Codex CLI versions.
