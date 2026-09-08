# RepoArena 1.0.0

RepoArena is CI for AI coding agents. It finds real fixes in your repository
history, replays the bugs in clean workspaces, and shows which agent works best
for your codebase.

## Highlights

- Compare Codex, Claude Code, Gemini CLI, and OpenCode on the same tasks.
- Keep hidden verification and historical reference fixes outside agent-visible workspaces.
- Run locally with your existing agent authentication—no RepoArena account and no RepoArena-managed model billing.
- Generate stable terminal, JSON, HTML, and JUnit evidence from one canonical run.
- Explore tasks, attempts, diffs, readiness, comparison, and cost/time in the loopback-only local UI.
- Search agent/model configurations with the budgeted optimizer.
- Run benchmarks in CI with the bundled, fork-aware GitHub Action.

Install after publication with `npm install --global repoarena`, or follow the
[contributor setup](../CONTRIBUTING.md) from source. Start with the
[five-minute quick start](../README.md#five-minute-quick-start).

RepoArena Cloud, public sharing, billing, and hosted runners are optional. Live
provider smoke tests require explicit credentials and are excluded from the
deterministic release gate.
