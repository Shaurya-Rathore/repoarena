# Cloud core

RepoArena Cloud Core is the PostgreSQL control plane behind future GitHub,
billing, and cloud-frontend integrations. It persists tenant/versioned domain
records, creates durable run jobs, leases compatible work to authenticated
runners, accepts public-safe results, and stores artifact metadata separately
from object bytes.

## Local development

Copy `.env.example` to `.env.local` and keep `DATABASE_URL` on the canonical
development database. Then run:

```sh
pnpm build
pnpm db:migrate
pnpm db:seed
pnpm cloud:api
```

The API binds to `127.0.0.1` by default. `pnpm cloud:scheduler` performs one
transactional scheduler tick; `pnpm cloud:jobs` prints safe queue counts. The
development object provider stores opaque server-generated keys beneath
`REPOARENA_OBJECT_ROOT`. Setting `S3_BUCKET` selects the production
S3-compatible provider.

## Security model

Browser mutations require an opaque server session, same-origin request, and
CSRF token. API and runner tokens are high entropy and stored only as hashes.
RBAC and live entitlements are evaluated in the service layer on every access.
Runner claims use PostgreSQL leases and issue short-lived credentials scoped to
one job. Public result ingestion rejects evaluator-private fields, and ordinary
task/run/artifact APIs never query private evaluator payloads.

Artifacts use server-generated tenant keys, checksum/size verification, and an
authorization check before a bounded signed-read URL is issued. Audit and
metric records contain safe identifiers and classifications, never tokens or
private evaluator contents.

## Operations and recovery

Migrations are forward-only and serialized with a PostgreSQL advisory lock.
Never edit a released migration. Jobs recover after lease expiry and transition
through explicit queued, leased, succeeded, cancelled, and dead-letter states.
Retry backoff is persisted. Scheduled occurrence uniqueness prevents duplicate
runs across concurrent scheduler processes. Liveness does not depend on
external services; readiness checks PostgreSQL and migration state.

For destructive tests, the database helper accepts only a loopback URL whose
database name is exactly `repoarena_test`. Fresh and upgrade migrations,
constraints, rollback, tenant isolation, concurrent claiming, lease recovery,
scheduler concurrency, and result idempotency run against real PostgreSQL.

GitHub OAuth and S3 provider implementations are production paths but their
live external credential checks are intentionally separate from deterministic
cloud-core verification. GitHub repository integration and Stripe billing are
later product clusters.
