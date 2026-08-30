# RepoArena

RepoArena is a local-first benchmark runner for coding agents. It discovers and
validates repo tasks, runs agents in isolated workspaces, captures deterministic
evidence, and reports comparable results.

## Quick start

```sh
pnpm install
pnpm build
node packages/cli/dist/index.js init --yes
node packages/cli/dist/index.js doctor
```

See `repoarena --help` for task validation, benchmark runs, exports, and local
result inspection. No RepoArena account is required for local use.
