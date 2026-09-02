# Billing and subscriptions

RepoArena subscriptions pay for RepoArena product capabilities. Coding-model usage remains BYOK and is paid directly to OpenAI, Anthropic, Google, or another provider; it is retained as immutable analytics and is never submitted to Stripe metering.

## Plans and policy

Community requires no Stripe customer. Pro and Team use server-configured monthly or yearly Stripe prices. Enterprise is contractual and has no self-serve Checkout price. Team is fixed-price for RepoArena 1.0; membership limits are enforced by canonical entitlements, without destructive member removal on downgrade.

Verified Stripe states reconcile into provider-independent billing status and then the existing entitlement engine. `TRIALING`, `ACTIVE`, and `PAST_DUE` retain the paid plan; incomplete, paused, unpaid, expired, and cancelled states use Community entitlements. Cancellation at period end retains access until Stripe reports the effective terminal state.

## Configuration

Configure the server-side variables documented in `.env.example`: the secret and publishable keys, webhook signing secret, and Pro/Team monthly/yearly Price IDs. Pinning is handled by `@repoarena/billing-stripe`; clients can request only a RepoArena plan and interval, never an arbitrary Stripe Price or Customer ID.

Create the Stripe webhook endpoint at `/api/v1/billing/stripe/webhooks` and subscribe only to Checkout completion, customer subscription lifecycle, and invoice payment lifecycle events. The endpoint verifies the exact raw body before parsing, stores a safe projection, deduplicates the Stripe event ID, and queues a durable `BILLING_WEBHOOK` job.

Run the API and billing event worker separately:

```sh
pnpm cloud:api
pnpm billing:webhooks
```

For an operator-authorized single-object drift repair:

```sh
pnpm billing:reconcile -- sub_example
```

Provider truth, not the Checkout success URL, activates entitlements. Customer Portal sessions are created server-side for organization owners. Hosted Checkout and Portal keep card numbers and CVC out of RepoArena.

## Development and testing

Normal tests use real PostgreSQL, deterministic provider contracts, and cryptographically signed fixtures. They never contact Stripe or create charges. Optional live validation must be explicitly gated with `REPOARENA_REAL_STRIPE_TESTS=1`, a Stripe test-mode key, and dedicated test objects; it is not part of `pnpm verify`.

Duplicate and out-of-order events are safe, transient provider failures use bounded durable retries, and the eighth failure becomes dead letter. Audit events contain only plans/statuses and identifiers, never keys, webhook secrets, payment methods, or raw provider payloads.
