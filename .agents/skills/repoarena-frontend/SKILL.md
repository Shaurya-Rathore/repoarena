---
name: repoarena-frontend
description: Build or verify RepoArena local/cloud web product pages and their accessible API-integrated states.
---

Every async route needs loading, empty, forbidden, infrastructure-error,
partial, and completed states. Render unknown metrics as unknown, never zero.
Escape Markdown/diffs/logs, separate public/private metadata, and verify
responsive keyboard-accessible flows in browser tests.

The local product is a loopback-only server in `packages/local-product` with a
versioned `/api/v1` boundary. Browser assets consume bounded public summaries;
detail routes load canonical persisted records lazily. Never read `.repoarena`
files directly from browser code or recalculate benchmark/readiness/optimizer
truth in a view.
