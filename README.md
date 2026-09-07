# RepoArena

**CI for AI coding agents. Find the best coding agent for your repo.**

RepoArena turns real repository tasks into repeatable coding-agent benchmarks.
It runs clean attempts, keeps hidden verification private, and compares
correctness, reliability, time, and immutable cost evidence.

```text
Agent          Solved   pass@1   Median     Cost
codex          18/20    90%      41s        BYOK
claude-code    16/20    80%      38s        BYOK
```

## Quick start

Node.js 24 and pnpm 9 are supported. From a source checkout:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm build
node packages/cli/dist/index.cjs --version
node packages/cli/dist/index.cjs init --yes
node packages/cli/dist/index.cjs doctor
```

The published CLI installs with `npm install --global repoarena`. Run
`repoarena tasks discover`, validate or generate tasks, then use
`repoarena run --agent codex --report terminal,json,html,junit` and
`repoarena ui`. Provider credentials remain yours: normal model usage is BYOK
and is not included in a RepoArena subscription.

## Product surfaces

- Local CLI and loopback-only UI for tasks, runs, diffs, readiness, and optimizer.
- Cloud organizations, durable runners/jobs, schedules, usage, publishing,
  leaderboard, and badges.
- GitHub App Checks plus a bundled GitHub Action in [`actions/repoarena`](actions/repoarena).
- Optional self-hosted and RepoArena-hosted execution with hard capacity and
  spend limits.

Supported adapters are Codex, Claude Code, Gemini CLI, and OpenCode. Attempts
run in contained disposable workspaces; evaluator-private assertions and
reference fixes never enter the agent phase.

## Documentation

- [Local product](docs/local-product.md)
- [Cloud operations](docs/cloud-core.md)
- [GitHub integration](docs/github-integration.md)
- [Billing and BYOK](docs/billing.md)
- [Hosted runners](docs/hosted-runners.md)
- [Production runbook](docs/operations/runbook.md)
- [Disaster recovery](docs/operations/disaster-recovery.md)
- [Contributing](CONTRIBUTING.md) and [security policy](SECURITY.md)

README badges are available only for deliberately published results. Public
views are immutable narrow projections and never expose private evaluator data.

RepoArena is licensed under [Apache-2.0](LICENSE).
