---
name: repoarena-security
description: Review or implement RepoArena trust boundaries, sandboxing, secrets, authorization, and publication redaction.
---

Assume repositories, agents, webhooks, archives, and task evidence are hostile.
Validate paths after resolution, reject symlink escapes, avoid shell
interpolation, redact before storage/publication, and test IDOR, replay, SSRF,
oversized data, secret leaks, and evaluator visibility.
