# Integrated RepoArena 1.0 product audit

Date: 2026-09-03
Canonical branch: `integration/repoarena-1.0`

## Ancestry and integration strategy

The subsystem branches are fully stacked. Each command below returned success:

```text
git merge-base --is-ancestor feat/execution-engine feat/local-product
git merge-base --is-ancestor feat/local-product feat/cloud-core
git merge-base --is-ancestor feat/cloud-core feat/github-integration
git merge-base --is-ancestor feat/github-integration feat/cloud-product
```

The verified tips at integration time were:

| Branch | Tip | Incorporated by |
| --- | --- | --- |
| `feat/execution-engine` | `baa53f9` | ancestor of local product |
| `feat/local-product` | `5c7384c` | ancestor of cloud core |
| `feat/cloud-core` | `ce88bb6` | ancestor of GitHub integration |
| `feat/github-integration` | `c689293` | ancestor of cloud product |
| `feat/cloud-product` | `be0c1bb` | direct integration branch base |

Because the chain is complete, the canonical branch was created directly from
`feat/cloud-product`. No redundant merge or history rewrite was performed. The
integration commit `9aa668b` adds the connected product proof and fixes the one
integration-discovered compatibility defect: GitHub Checks now consume the
canonical `solved_count`/`attempt_count` statistics while retaining compatibility
with already persisted legacy results.

## Preserved subsystem audits

All historical audit files remain present and unchanged:

- `docs/development/execution-engine-final-audit.md`
- `docs/development/local-product-final-audit.md`
- `docs/development/cloud-core-final-audit.md`
- `docs/development/github-integration-final-audit.md`
- `docs/development/cloud-product-final-audit.md`

## Verification matrix

| Requirement | Production implementation | Integration evidence | Command | Status |
| --- | --- | --- | --- | --- |
| Branch ancestry and minimal integration | Git history through `feat/cloud-product` | ancestry checks and preserved atomic history above | `git merge-base --is-ancestor ...` | VERIFIED |
| Package graph and build order | workspace manifests, TypeScript project graph, `pnpm-lock.yaml` | all 40 buildable workspace projects build in dependency order | `pnpm build && pnpm typecheck` | VERIFIED |
| Migration continuity | `packages/cloud-db/migrations/0001_cloud_core.sql` through `0007_billing.sql` | empty-install, upgrade, constraints, advisory locking, rollback | `pnpm db:migrate`; `pnpm --filter @repoarena/cloud-db test:integration` | VERIFIED |
| PostgreSQL cloud integration | cloud DB/core/API packages | real PostgreSQL 18.6 transactions, tenancy, queue/lease, API | cloud DB/core/API integration commands below | VERIFIED |
| Canonical cross-subsystem flow | benchmark engine, cloud core, GitHub integration, publishing, cloud product | `packages/cloud-product/src/integrated-product.e2e.test.ts` | `pnpm --filter @repoarena/cloud-product test:e2e` with `DATABASE_URL` | VERIFIED |
| Runner/job/GitHub provenance | cloud core and GitHub integration | signed push creates one canonical run/job; authenticated runner claims and submits | cloud-product integrated E2E; GitHub integration suite | VERIFIED |
| GitHub Check consistency | `packages/github-integration/src/index.ts` | canonical solved/attempt counts produce the same successful conclusion and summary | GitHub unit/integration; cloud-product integrated E2E | VERIFIED |
| Explicit public publication | public-publishing, cloud API/product | cross-org publish denied; authorized immutable projection succeeds | public-publishing integration; cloud-product integrated E2E | VERIFIED |
| Leaderboard/share/badge | public-publishing and cloud product | one eligible 2/2 run appears consistently on all three HTTP surfaces | cloud-product integrated E2E and built smoke | VERIFIED |
| CLI/report/local consistency | benchmark engine, reporter, run store, local product, CLI | one canonical run drives terminal/JSON/HTML/JUnit and local API/UI without result recomputation | benchmark, reporter, local-product and built CLI suites | VERIFIED |
| Readiness consistency | readiness, CLI, local/cloud product | canonical versioned readiness record is persisted and rendered by CLI/local/cloud APIs | readiness, CLI, local-product, cloud-product suites | VERIFIED |
| Optimizer consistency | optimizer, CLI, local/cloud product | canonical optimization result, recommendation, history, and profile export remain shared | optimizer, CLI, local-product, cloud-product suites | VERIFIED |
| Immutable historical cost | pricing, benchmark engine, reporter, local/cloud/public consumers | stored V1 price survives V2 catalog replacement and report reload; cloud/public surfaces consume stored statistics | benchmark historical-cost test; integrated E2E | VERIFIED |
| Private-data boundary | runner/redaction, cloud core/API, GitHub, publishing | evaluator, provider, webhook, API/runner/token and object-key sentinels remain absent from public/persisted surfaces | benchmark security E2E; GitHub integration; cloud-product integrated E2E; full verify | VERIFIED |
| GitHub Action bundle | `actions/repoarena` | built Action invokes built CLI, emits bounded outputs/reports, and preserves CI semantics | `pnpm --filter @repoarena/github-action test:e2e` | VERIFIED |
| Built local product | CLI and local-product | compiled CLI launches loopback UI, health/API/onboarding respond, process exits cleanly | `pnpm --filter repoarena test:unit` | VERIFIED |
| Built cloud product | cloud-product and production launcher | compiled server serves landing, leaderboard, and auth redirect | `pnpm test:cloud-product-built` | VERIFIED |
| Docker boundary | sandbox-docker | production provider remains contract-tested; integration uses LocalSandboxProvider | `pnpm --filter @repoarena/sandbox-docker test:unit` | VERIFIED |

## Verified billing integration

`integration/repoarena-1.0` at `7f39f9b` was confirmed as an ancestor of
`feat/billing` at `a4bad99`. The canonical branch was updated by `git merge
--ff-only feat/billing`, preserving the verified billing commits `c6a0ae1`,
`a870389`, and `a4bad99` without a merge rewrite or cherry-pick.

Migration `0007_billing.sql` follows the existing `0001`–`0006` sequence. The
real PostgreSQL suite passed empty-database migration, supported upgrade,
constraints, transaction/locking behavior, cloud-core integration, billing
integration, and cloud API integration.

The connected cloud API flow begins with Community entitlements, creates an
owner-authorized deterministic Checkout, proves the browser success path grants
nothing, ingests an exact-raw-body signed Stripe event, reconciles provider truth
to the paid canonical entitlement, and then continues through GitHub provenance,
benchmark job claim, result persistence, and cloud retrieval. The integrated
cloud-product E2E continues canonical results through explicit publishing,
leaderboard, share, and badge surfaces.

BYOK model usage remains immutable execution analytics paid directly to the
model provider. The Stripe provider contract receives only RepoArena customer,
plan/price, subscription, Checkout, and Portal operations; no model-token usage
or execution-cost record enters Stripe request formation. Product pricing and
billing surfaces display this separation explicitly.

Billing, execution, GitHub, cloud, publication, and product tests scan safe
event projections, audit metadata, stored results, reports, checks, API/UI, and
public surfaces for provider, evaluator, installation, webhook, API-key, runner,
Stripe-key, and Stripe-webhook sentinels. The integrated regression remained
secret-free.

## Exact closeout commands

The canonical database variables are loaded from `.env.local` for PostgreSQL
commands. The test helper derives and safety-checks the loopback-only
`repoarena_test` database before destructive setup.

```sh
pg_isready
psql --version
set -a; source .env.local; set +a; pnpm db:migrate
set -a; source .env.local; set +a; pnpm --filter @repoarena/cloud-db test:integration
set -a; source .env.local; set +a; pnpm --filter @repoarena/cloud-core test:integration
set -a; source .env.local; set +a; pnpm --filter @repoarena/billing test:integration
set -a; source .env.local; set +a; pnpm --filter @repoarena/cloud-api test:integration
set -a; source .env.local; set +a; pnpm --filter @repoarena/github-integration test:integration
set -a; source .env.local; set +a; pnpm --filter @repoarena/public-publishing test:integration
set -a; source .env.local; set +a; pnpm --filter @repoarena/cloud-product test:e2e
pnpm --filter repoarena test:unit
pnpm --filter @repoarena/github-action test:e2e
pnpm test:cloud-product-built
set -a; source .env.local; set +a; pnpm test:integration
node packages/cli/dist/index.js doctor --json
node packages/cli/dist/index.js tasks list --json
pnpm format:check
pnpm lint
pnpm typecheck
pnpm skills:validate
pnpm verify
```

## Canonical continuation point

All remaining RepoArena 1.0 branches, including hosted-runner work, must branch
from the verified tip of `integration/repoarena-1.0`, not from an individual
subsystem branch.
