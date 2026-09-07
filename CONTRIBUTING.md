# Contributing

Use Node.js 24 and pnpm 9.15.0 (`corepack enable`), then run
`pnpm install --frozen-lockfile`. PostgreSQL integration uses the loopback-only
`repoarena_test` database derived from `DATABASE_URL`; destructive helpers
refuse every other database name. Copy `.env.example` to `.env.local`, build,
and run `pnpm verify` plus `pnpm test:integration` before submitting changes.

Use deterministic generated Git fixtures and fake adapters. Test adapters are
enabled only with `NODE_ENV=test REPOARENA_TEST_ADAPTERS=1`. Live provider
checks are explicit opt-ins and never run in normal CI. Never add credentials,
private source, evaluator assertions, or reference fixes. Keep commits atomic
and add behavioral tests. Release candidates use `pnpm release:verify`.
