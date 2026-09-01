---
name: repoarena-github
description: Implement or test RepoArena GitHub App, webhook, Actions, and repository metadata integrations.
---

Verify webhook signatures before business parsing and deduplicate every
delivery. Never run untrusted fork code with cloud secrets. Use narrow clients
with timeouts, ETag-aware reads, and idempotent checks/status updates; test
realistic signed webhook fixtures.

Use `@repoarena/github-provider` for App JWTs, memory-only installation tokens,
REST version headers, Checks, and managed comments. Use
`@repoarena/github-integration` for installation tenancy, durable deliveries,
trigger policy, run provenance, OIDC trust, and public-result publication. Do
not place raw GitHub calls in cloud routes.

The webhook boundary is raw bytes → bounded HMAC verification → validated
headers/schema → unique delivery persistence → durable job. Retry GitHub API
rate limits through the durable queue and keep permanent failures dead-lettered.
Checks are mapped by persisted ID and transition queued/in-progress/completed.

The Action must remain a bundled Node entrypoint and execute the real built CLI.
Test adapters require both `NODE_ENV=test` and `REPOARENA_TEST_ADAPTERS=1`.
Cloud publication prefers repository-ID-bound GitHub OIDC with issuer, audience,
ref/workflow, expiry, and replay checks; API keys are only a scoped fallback.
Scan Action outputs, Checks, comments, jobs, audit events, and public result
records for private-key, webhook, installation-token, provider, and evaluator
sentinels.
