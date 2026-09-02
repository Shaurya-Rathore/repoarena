---
name: repoarena-security
description: Review or implement RepoArena trust boundaries, sandboxing, secrets, authorization, and publication redaction.
---

Assume repositories, agents, webhooks, archives, and task evidence are hostile.
Validate paths after resolution, reject symlink escapes, avoid shell
interpolation, redact before storage/publication, and test IDOR, replay, SSRF,
oversized data, secret leaks, and evaluator visibility.

Hash public text artifacts only after applying the same secret redaction used
for logs and patches. Canonicalize report output paths against the repository
root, including existing symlinks. No evaluator workspace may be created while
an agent lease is active, even when attempts run concurrently.

Cloud tenant authorization belongs in `CloudService`, not only HTTP handlers.
Opaque sessions, API keys, runner tokens, and job credentials are stored only
as SHA-256 lookup hashes, never included in audit metadata, and tested for
revocation, cross-organization IDOR, scoped replay, and private-result rejection.

Public publishing is an explicit RBAC-protected transition. Persist a narrow,
immutable projection and serve that projection directly; never reconstruct a
public response later from the private canonical run. Redact private repository
identity, exclude non-public artifacts, use opaque publication IDs, rate-limit
anonymous endpoints, and make unpublish immediately remove public access.
