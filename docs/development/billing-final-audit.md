# Billing final audit

Status: **BILLING = VERIFIED**

| Requirement | Production implementation | Tests / verification | Status |
| --- | --- | --- | --- |
| 1–5 branch, architecture, provider and secret/API-version configuration | `packages/billing-stripe`; `.env.example`; branch `feat/billing` | provider unit contracts; workspace build/typecheck | VERIFIED |
| 6–13 customer/subscription domain, plan mapping, canonical status and entitlements | migration `0007_billing.sql`; `packages/billing`; existing cloud entitlement service | billing unit and real-PostgreSQL integration | VERIFIED |
| 14–19 Checkout, redirect/cancel safety and Customer Portal authorization | billing service; cloud API billing routes; product billing view | concurrent/replayed Checkout, no-redirect-grant and RBAC integration | VERIFIED |
| 20–27 raw signed webhook ingestion, durability, idempotency, supported/ignored events and job processing | billing service; versioned cloud API; `scripts/billing-webhooks.mjs` | exact-raw signature unit regression; HTTP webhook PostgreSQL integration | VERIFIED |
| 28–40 reconciliation, payment lifecycle, grace, upgrade/downgrade/cancel, fixed Team pricing and invoices | canonical mapper/reconciler and invoice store; `scripts/billing-reconcile.mjs` | stale-order, retry, past-due, active, cancel, upgrade/downgrade and invoice integration | VERIFIED |
| 41–47 billing/pricing UI, BYOK separation, intervals, Enterprise and provider abstraction | cloud-product pricing/billing surfaces; billing provider interface | product unit/build, built HTTP smoke and real-browser pricing smoke | VERIFIED |
| 48–57 safe webhook storage, durable/provider retry, rate limits, contracts and signed fixtures | billing event safe projection/retry/dead-letter; Stripe typed errors | provider contracts; duplicate, transient retry and raw-body tests | VERIFIED |
| 58–65 tenant/success/customer forgery, sentinel/card safety, audit, usage separation and entitlement limits | CloudService RBAC, server price/customer derivation, safe audit/events | billing/API PostgreSQL RBAC and forbidden-sentinel assertions | VERIFIED |
| 66–77 connected lifecycle, concurrency, webhook/Portal/UI/RBAC/catalog consistency | billing/API/product integration and migration constraints | commands below | VERIFIED |
| 78–81 optional live Stripe test-mode smoke | read-only gated `scripts/stripe-smoke.mjs`; deterministic production-provider contracts | `pnpm billing:stripe-smoke` only with explicitly supplied Stripe test credentials | IMPLEMENTED_AND_CONTRACT_VERIFIED_LIVE_CREDENTIALS_UNAVAILABLE |
| 82–91 observability/health boundary, docs, skill, search, integrated regression, Git and verification | safe job/event/audit diagnostics; `docs/billing.md`; billing skill; this audit | closeout search; PostgreSQL integrations; Action E2E; `pnpm skills:validate`; `pnpm verify` | VERIFIED |

## Verified behavior

- Stripe requests pin `2025-08-27.basil`, use opaque credentials and idempotency headers, and classify authentication, validation, rate-limit, transient and network failures.
- Checkout and Portal are owner-only. Plans and prices are server-selected; reaching a success URL never changes entitlements.
- Exact raw webhook bodies are HMAC verified before parsing. Safe projections, unique event IDs, durable control-plane jobs, bounded backoff, dead letters and provider-truth reconciliation handle duplicates, retries and stale delivery order.
- Community requires no Stripe object. Trialing, active and past-due subscriptions retain paid entitlement; terminal states downgrade without deleting members, runs, artifacts or history. Team is fixed-price in RepoArena 1.0.
- Provider-model usage remains `BYOK / paid directly to provider` and is excluded from Stripe billing.
- Billing control-plane jobs cannot be claimed by execution runners.

## Exact verification commands

```sh
pnpm --filter @repoarena/billing-stripe test:unit
pnpm --filter @repoarena/billing-stripe typecheck
set -a; source .env.local; set +a; pnpm --filter @repoarena/billing test:integration
pnpm --filter @repoarena/billing test:unit
pnpm --filter @repoarena/billing typecheck
set -a; source .env.local; set +a; pnpm --filter @repoarena/cloud-db test:integration
set -a; source .env.local; set +a; pnpm --filter @repoarena/cloud-core test:integration
set -a; source .env.local; set +a; pnpm --filter @repoarena/cloud-api test:integration
set -a; source .env.local; set +a; pnpm --filter @repoarena/cloud-product test:e2e
pnpm --filter @repoarena/cloud-product test:unit
pnpm test:cloud-product-built
pnpm --filter @repoarena/github-action test:e2e
set -a; source .env.local; set +a; pnpm test:integration
pnpm skills:validate
pnpm verify
```

The built pricing surface was additionally started with `node scripts/cloud-product.mjs` on loopback and exercised in Chromium through the Playwright CLI. It rendered the canonical Community, Pro, Team and Enterprise plan content and the explicit BYOK separation.

The optional live Stripe test-mode smoke was not executed because Stripe credentials were not supplied. Production request formation, API versioning, error handling and webhook cryptography are contract verified without network access or charges.
