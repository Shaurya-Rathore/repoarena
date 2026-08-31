---
name: repoarena-testing
description: Add or run RepoArena behavioral, integration, security, and end-to-end tests.
---

Prefer deterministic generated Git fixtures and fake external providers.
Exercise public interfaces as well as pure functions. Fakes must assert the
production client's request, signature, error, and idempotency behavior. Do not
weaken an invariant to make a test pass.

Execution closeout tests invoke the built CLI as a child process. Deterministic
CLI adapters are available only when both `NODE_ENV=test` and
`REPOARENA_TEST_ADAPTERS=1`; production adapter names are never replaced. Use
synchronized barriers for concurrency assertions and forbidden-sentinel scans
across persisted runs and every public reporter.
