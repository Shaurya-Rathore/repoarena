---
name: repoarena-api
description: Implement or review RepoArena cloud API routes, request contracts, authorization, and public data APIs.
---

Validate every input at runtime and return stable typed errors with request IDs.
Derive DTOs rather than exposing database rows. Authorize organization and
resource ownership before reads/writes; mutations require CSRF or token-only
auth, idempotency for side effects, and audit events.

Runner control uses a long-lived registration token only for heartbeat and job
claim. A claim returns a short-lived, job-bound credential for result/artifact
writes. Public result ingestion rejects evaluator-private keys before hashing
or persistence. Keep the exported OpenAPI contract and typed client aligned
with `/api/v1` routes.
