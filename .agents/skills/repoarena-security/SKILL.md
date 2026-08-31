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
