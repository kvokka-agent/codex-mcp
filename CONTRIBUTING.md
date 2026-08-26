# Contributing to codex-mcp

Thanks for your interest in contributing!

## Getting Started

```bash
git clone https://github.com/kvokka/codex-mcp.git
cd codex-mcp
npm install
npm run build
```

## Development Workflow

```bash
npm run check        # The CI gate: lint, format, types, tests, build, and the two runtime scripts
```

[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) sets up the loop that command does
not cover: running your build inside a real Claude Code session, restarting the
server after a rebuild, and reading its logs.

## Pull Requests

1. Fork the repo and create a branch from `master` (or the repository default branch)
2. Make your changes
3. Ensure `npm run check` passes
4. Submit a PR with a clear description

## Reporting Issues

Use [GitHub Issues](https://github.com/kvokka/codex-mcp/issues). Include:

- Steps to reproduce
- Expected vs actual behavior
- Node.js and Codex CLI versions

## Code Style

- TypeScript strict mode
- ESM modules
- Prefer `as const` tuples for shared constants
- Keep tool handlers thin — delegate to SessionManager
