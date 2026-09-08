# Contributing to RepoArena

Thanks for helping make coding-agent evaluation more useful and trustworthy.
You can work on the CLI, agent adapters, task mining, reporters, local UI, tests,
and docs without any SaaS or provider credentials.

## Setup

Requirements: Git, Node.js 24, and pnpm 9.15.0 through Corepack.

```sh
git clone https://github.com/repoarena/repoarena.git
cd repoarena
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm demo
```

The demo and normal tests use deterministic fake adapters and never call paid
models. Run focused package tests while iterating, then before a pull request:

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm verify
pnpm docs:check
```

PostgreSQL is needed only for cloud integration work. Copy `.env.example` to
`.env.local` and use the loopback-only `repoarena_test` database; destructive
test helpers refuse other database names. Docker and external provider
credentials are optional.

## What to change

- CLI: `packages/cli`
- coding-agent adapters: `packages/adapter-*`
- historical task mining: `packages/task-*`
- benchmark execution/reporting: `packages/benchmark-engine`, `packages/reporter`
- loopback UI: `packages/local-product`
- docs and examples: `docs`, `examples`

Keep TypeScript strict and add behavioral tests. Treat repository code and agents
as untrusted: never expose credentials, hidden evaluators, or reference fixes to
attempt workspaces, logs, fixtures, or reports. Use deterministic canonical
hashing for persisted protocol values. Do not edit released migrations.

Test adapters are deliberately gated behind both `NODE_ENV=test` and
`REPOARENA_TEST_ADAPTERS=1`. Optional live-provider smoke harnesses are bounded,
explicit opt-ins; never enable them in a normal test.

## Pull requests

Keep commits focused. Explain the behavior change, tests run, and documentation
impact. Sanitise logs before attaching them, and never paste provider tokens or
private repository content into an issue or pull request.
