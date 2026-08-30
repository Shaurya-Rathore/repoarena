---
name: repoarena-database
description: Create or modify RepoArena PostgreSQL schema, migrations, transactional jobs, and data integrity logic.
---

Write a new forward-only SQL migration before application access changes. Use
constraints for tenancy, immutable task/benchmark content, idempotency keys, and
job leases. Test empty-install and upgrade paths and document repair/rollback.
