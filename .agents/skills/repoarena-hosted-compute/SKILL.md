---
name: repoarena-hosted-compute
description: Implement or verify RepoArena hosted runner lifecycle, capacity, metering, budget, reconciliation, and provider safety.
---

# RepoArena hosted compute

Treat hosted compute as an optional provider of runners, never as a replacement
for the durable job queue or runner claim/result protocol.

- Create one durable hosted execution lease per benchmark job. The job ID is the
  provisioning idempotency boundary.
- Reserve capacity and worst-case compute budget under the PostgreSQL hosted
  advisory lock before provisioning. Enforce global and organization limits.
- Use only versioned server resource classes. Persist the resource-class and
  pricing snapshots so historical cost cannot change.
- Bootstrap with one opaque, short-lived runner credential scoped by the exact
  hosted lease capability. Revoke it after completion, cancellation, or timeout.
- Never put source, task text, repository identity, secrets, or evaluator-private
  data in provider names or labels. Cleanup only resources matching managed-by,
  environment, deployment, and lease identities.
- Keep model-provider BYOK usage, RepoArena subscription, and hosted compute
  usage as separate economic categories.
- Exercise capacity races, cancellation, absolute timeout, missing heartbeat,
  provider crash, termination failure, orphan cleanup, foreign-resource safety,
  cost immutability, and credential replay against real PostgreSQL.
- Normal verification uses the deterministic provider. Live provider smoke is
  opt-in, test-environment gated, smallest-class, time bounded, and terminates in
  `finally`.
