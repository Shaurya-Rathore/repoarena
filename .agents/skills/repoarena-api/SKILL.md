---
name: repoarena-api
description: Implement or review RepoArena cloud API routes, request contracts, authorization, and public data APIs.
---

Validate every input at runtime and return stable typed errors with request IDs.
Derive DTOs rather than exposing database rows. Authorize organization and
resource ownership before reads/writes; mutations require CSRF or token-only
auth, idempotency for side effects, and audit events.
