---
name: repoarena-database
description: Create or modify RepoArena PostgreSQL schema, migrations, transactional jobs, and data integrity logic.
---

Write a new forward-only SQL migration before application access changes. Use
constraints for tenancy, immutable task/benchmark content, idempotency keys, and
job leases. Test empty-install and upgrade paths and document repair/rollback.

Cloud integration tests derive `repoarena_test` from the canonical
`DATABASE_URL` and must call the guarded reset helper; it refuses non-loopback
hosts and every database name except `repoarena_test`. Claims and scheduler
ticks use PostgreSQL transactions with `FOR UPDATE ... SKIP LOCKED`; use
separate pool connections to test exclusivity and lease reclaim.
