---
name: repoarena-billing
description: Implement or verify RepoArena subscription billing, Stripe webhooks, and canonical entitlement synchronization.
---

# RepoArena billing

Use the provider-independent billing domain in `packages/billing` and keep Stripe transport in `packages/billing-stripe`. Never authorize product features from raw Stripe statuses or price IDs; reconcile verified provider state into the existing organization plan and entitlement service.

Preserve these invariants:

- RepoArena subscriptions and BYOK model-provider costs are separate. Never send user-owned model usage to Stripe metering.
- Checkout chooses configured prices server-side and grants no entitlement from its success redirect.
- Verify Stripe signatures against the exact bounded raw body before JSON parsing. Persist only the safe event projection.
- Treat provider event IDs and Checkout operations as idempotent. Use provider object retrieval and event timestamps so out-of-order deliveries cannot regress state.
- Keep `PAST_DUE` grace, cancellation, and downgrade policy centralized in the billing domain. Never delete history or members during a downgrade.
- Run migration, transaction, uniqueness, concurrent Checkout, and concurrent webhook tests against the canonical real PostgreSQL test database.
- Billing control-plane jobs are processed by the billing worker; execution runners may claim only benchmark jobs.
- Normal verification uses the deterministic provider and signed fixtures. Live Stripe test-mode checks are explicit opt-in and must never create live-mode charges.

When schema changes are required, add a forward migration; never edit a released migration. Scan API responses, audit events, stored event projections, UI HTML, and errors for billing and provider secret sentinels.
