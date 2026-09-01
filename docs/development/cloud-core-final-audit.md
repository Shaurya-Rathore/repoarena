# Cloud core final audit

Date: 2026-09-01. Branch: `feat/cloud-core`. Database verification used local
PostgreSQL 18.6 and the guarded `repoarena_test` database derived from the
canonical `DATABASE_URL`.

| Requirement | Production implementation | Tests / command | Status |
| --- | --- | --- | --- |
| 1–4 architecture, PostgreSQL pool, transactions, migrations and opaque IDs | `packages/cloud-db/src/index.ts`, migrations 0001–0002 | cloud-db unit/integration; `pnpm db:migrate` | VERIFIED |
| 5–8 users, organizations, memberships, roles and IDOR-safe authorization | `packages/cloud-core/src/index.ts` | cloud-core integration organization-isolation/ownership matrix | VERIFIED |
| 9–15 repositories, benchmark/task versions, runs and private/public result boundary | cloud-db schema, cloud-core projections and `assertPublicResult` | cloud-core/API connected flow and private-field unit test | VERIFIED |
| 16–19 artifact metadata, object abstraction, opaque keys and authorization | `packages/object-storage`, `ArtifactService` | object-storage unit and cloud-core artifact integration | VERIFIED |
| 20–22 OAuth/session/CSRF foundation | `GitHubOAuthProvider`, sessions and cloud API | cloud-api OAuth/CSRF integration | VERIFIED |
| 23–25 API keys, scopes, hashing, expiry/revocation and audit events | `CloudService` token/audit services | cloud-core real-Postgres auth integration | VERIFIED |
| 26–36 versioned API, errors, tenant APIs, pagination, idempotency and rate limiting | `packages/cloud-api`, `packages/cloud-api-client` | API unit/integration and client unit suites | VERIFIED |
| 37–43 durable jobs, explicit states, SKIP LOCKED, leases, retries and dead letter | jobs schema, `claimJob`, `extendLease`, `failJob` | concurrent cloud-core PostgreSQL tests | VERIFIED |
| 44–46 schedules, transactional tick and occurrence idempotency | schedules schema and `schedulerTick` | concurrent scheduler-instance integration | VERIFIED |
| 47–53 runner registration/token/heartbeat/staleness/capability matching/job credentials | cloud-core runner services | runner exclusivity, capability, expiry and revocation integration | VERIFIED |
| 54–56 result/artifact upload authorization and replay idempotency | `submitResult`, `ArtifactService` | identical/conflicting replay, wrong-runner and checksum tests | VERIFIED |
| 57–59 usage, immutable cost snapshots, BYOK ownership and persisted budgets | usage schema, `recordUsage`, `createRun` | cloud-core usage/idempotency integration | VERIFIED |
| 60–63 plan entitlement foundation and security audit trail | plans/overrides, service authorization/audit | Community/PRO/TEAM and ownership integration | VERIFIED |
| 64–67 structured logging, liveness/readiness, metrics and safe diagnostics | cloud API logger/health, metric events | cloud-api integration | VERIFIED |
| 68–76 local operations, migration serialization, constraints, archival/retention hooks, API contract/client | scripts, migration schema, OpenAPI contract/client | build, database and API client suites | VERIFIED |
| 77 security matrix: unauthenticated, IDOR, CSRF, replay, malformed/oversized input, private leakage | cloud API/core/storage boundaries | API/core/object connected tests | VERIFIED |
| 78–82 real database, storage, job/scheduler/runner concurrency | PostgreSQL services and filesystem provider | `pnpm test:postgres`; cloud-core integration | VERIFIED |
| 83 cloud flow A: auth → org → repo → task → benchmark → run → claim → result → query | cloud API and all services | cloud-api real-Postgres E2E | VERIFIED |
| 84 cloud flow B: schedule → concurrent tick → one run/job | scheduler service | cloud-core scheduler integration | VERIFIED |
| 85 cloud flow C: cross-organization resource denial | centralized authorization | cloud-core tenant integration | VERIFIED |
| 86 cloud flow D: Community denial → plan change → allowed | live entitlement lookup | cloud-core entitlement integration | VERIFIED |
| 87 cloud flow E: lease expiry → second runner reclaim → one completion | durable job lease services | cloud-core claim/reclaim/replay integration | VERIFIED |
| 88–94 operator commands, fixtures, package skills and documentation | `scripts/cloud-*`, `docs/cloud-core.md`, repository skills | build; `pnpm skills:validate` | VERIFIED |
| 95–98 closeout, unfinished-code search and full verification | this audit, closeout and implementation ledger | search; `pnpm verify`; integration commands below | VERIFIED |
| Live GitHub OAuth exchange with external credentials | production `GitHubOAuthProvider`; deterministic provider contract | cloud-api unit/integration | IMPLEMENTED_AND_CONTRACT_VERIFIED_LIVE_CREDENTIALS_UNAVAILABLE |
| Live external S3/MinIO credentials | production `S3ObjectStorage`; deterministic object provider | object-storage contract suite | IMPLEMENTED_AND_CONTRACT_VERIFIED_LIVE_CREDENTIALS_UNAVAILABLE |

## Exact database closeout commands

```sh
pg_isready
psql --version
psql postgresql://repoarena:repoarena@localhost:5432/repoarena -Atc 'select current_database(), current_user'
psql postgresql://repoarena:repoarena@localhost:5432/repoarena_test -Atc 'select current_database(), current_user'
DATABASE_URL=postgresql://repoarena:repoarena@localhost:5432/repoarena pnpm --filter @repoarena/cloud-db test:integration
DATABASE_URL=postgresql://repoarena:repoarena@localhost:5432/repoarena pnpm --filter @repoarena/cloud-core test:integration
DATABASE_URL=postgresql://repoarena:repoarena@localhost:5432/repoarena pnpm --filter @repoarena/cloud-api test:integration
pnpm db:migrate
pnpm db:seed
pnpm test:integration
pnpm skills:validate
pnpm verify
```

The cloud-db integration suite performs the guarded clean reset, migrates from
zero, verifies schema and constraints, constructs a supported 0001 database,
migrates it through 0002 while preserving data, and exercises advisory migration
locking. It refuses destructive work unless the host is loopback and the target
database name is exactly `repoarena_test`.
