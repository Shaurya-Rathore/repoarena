# Production deployment

The initial topology is intentionally conventional: separate Node.js API,
worker, scheduler, and cloud-product processes; PostgreSQL; S3-compatible object
storage; and optional GitHub, Stripe, and hosted-compute providers. Kubernetes
is not required. Run as an unprivileged service identity behind HTTPS and never
bake secrets into artifacts.

`.env.example` is the configuration inventory. GitHub, billing, S3, and hosted
compute have explicit enable flags; credentials are required only when enabled.
Validate with `pnpm config:validate:production`. Session, OAuth, GitHub,
Stripe, database, S3, and hosted-provider credentials belong in a secret manager.

Upgrade sequence: take database and object backups, pause new workers, run
`pnpm db:migrate` once, verify schema/readiness, deploy API, workers, scheduler,
and frontend, then smoke health endpoints. Advisory locking protects concurrent
migration startup. Roll back only to a schema-compatible application; restore
the coordinated backup for data recovery.

The API and runner control plane require TLS. Configure the reverse proxy to
replace forwarded headers, enforce request limits, and preserve exact raw
Stripe/GitHub webhook bodies. Never expose the local product beyond loopback.
