# RepoArena production runbook

## Deploy and start

Run Node.js 24 processes behind a TLS-terminating reverse proxy that overwrites
forwarded headers. Install with `pnpm install --frozen-lockfile`, build with
`pnpm build`, validate secrets using `pnpm config:validate:production`, back up
PostgreSQL and object storage, then run `pnpm db:migrate`. Start the API with
`pnpm cloud:api`, worker with `pnpm cloud:jobs`, scheduler with
`pnpm cloud:scheduler`, and frontend with `pnpm cloud:product`. Use a process
supervisor, separate service identities, and graceful SIGTERM.

Liveness proves the process is alive; readiness checks PostgreSQL and migration
state. Alert on elevated 5xx/latency, DB pool exhaustion, oldest queued job,
scheduler lag, runner shortage, GitHub or billing webhook failures, hosted
orphans/cleanup failures, and hosted budget anomalies. Correlate request, run,
job, runner, and publication IDs; never log tokens or evaluator data.

## Incidents

- Worker backlog: stop new expensive run creation, inspect `cloud:jobs`, restore
  compatible runners, and let leases expire/reclaim. Do not edit job rows.
- Webhook failure: verify provider status/signature configuration, inspect safe
  durable delivery state, then retry through the durable processor.
- Runner shortage: validate version/capabilities and register a scoped runner.
- Hosted orphan: enable emergency stop with `hosted:control`, run
  `hosted:reconcile`, and terminate only strongly labelled managed resources.
- Billing incident: reconcile verified Stripe state; never grant access from a
  browser success redirect.
- Credential compromise: rotate at provider, update the secret store, restart
  affected services, revoke derived tokens, and review redacted audit events.

Application rollback means deploy the previous schema-compatible build;
released SQL migrations are forward-only. Restore a coordinated pre-migration
database and object backup only during a controlled recovery.
