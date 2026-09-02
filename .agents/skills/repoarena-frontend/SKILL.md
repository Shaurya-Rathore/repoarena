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

The cloud product in `packages/cloud-product` is a same-origin security gateway
over the typed cloud API. Authenticated HTML and API responses are private and
`no-store`; public share, leaderboard, sitemap, and badge routes consume only
`@repoarena/public-publishing` projections. Preserve organization identity when
switching workspaces and test that server-side caches never cross sessions.
