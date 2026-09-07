# Hosted runners final audit

Branch: `feat/hosted-runners`  
Base: `integration/repoarena-1.0` at `9274865`

## Verification matrix

| Requirements | Implementation | Tests / verification | Status |
| --- | --- | --- | --- |
| 1–6 | `packages/cloud-db/migrations/0008_hosted_compute.sql`; `packages/hosted-compute/src/index.ts` | hosted build/typecheck; fresh PostgreSQL migration | VERIFIED |
| 7–10 | deterministic and HTTPS provisioner implementations; `scripts/hosted-compute-smoke.mjs` | provider unit contracts, opt-in safety gate | VERIFIED |
| 11–17 | explicit lease states, job uniqueness, runner version/capability and ephemeral hashed runner credential | connected hosted PostgreSQL lifecycle and stale-token tests | VERIFIED |
| 18–26 | opaque bootstrap transport, exact-lease capability, existing sandbox/private phase, opaque provider labels | hosted sentinel/metadata assertions plus existing execution security regression | VERIFIED |
| 27–35 | versioned ceilings, absolute timeout, idempotent cancellation, typed provider failures, ready timeout and crash handling | hosted provider and lifecycle integration tests | VERIFIED |
| 36–39 | deployment-scoped reconciliation and usage finalization | orphan/foreign-resource and lost-runner PostgreSQL tests | VERIFIED |
| 40–45 | advisory-lock capacity reservation, global/org/queue caps and current entitlement checks | separate-client concurrent provisioning and capacity tests | VERIFIED |
| 46–59 | independent compute usage, worst-case estimates, pricing snapshots, hard run/monthly budgets and sponsored ownership preservation | budget, metering, result replay and V1→V2 tests | VERIFIED |
| 60–68 | disabled-by-default setting, emergency stop, org suspension/policy and request-time enforcement | kill-switch, entitlement and abuse-bound tests | VERIFIED |
| 69–77 | hosted API contract/routes, runner/usage product views, safe operator reconciliation and provider error redaction | API typecheck, cloud-product tests/build, provider sentinel tests | VERIFIED |
| 78–104 | canonical runner flow, capacity, cancellation, timeout, crash/loss, orphan safety, concurrent budget/capacity and historical cost | `pnpm --filter @repoarena/hosted-compute test:unit`; real-PostgreSQL `test:integration`; cloud-core/API regression | VERIFIED |
| 105–112 | `docs/hosted-runners.md`, repository skill, closeout/status, full integrated verification | closeout search; `pnpm skills:validate`; `pnpm verify` | VERIFIED |

## Exact commands

```sh
pg_isready
set -a; source .env.local; set +a
pnpm --filter @repoarena/cloud-db test:integration
pnpm --filter @repoarena/hosted-compute test:unit
pnpm --filter @repoarena/hosted-compute test:integration
pnpm --filter @repoarena/cloud-core test:integration
pnpm --filter @repoarena/cloud-api test:integration
pnpm --filter @repoarena/cloud-product test:unit
pnpm --filter @repoarena/cloud-product test:e2e
pnpm --filter @repoarena/billing test:integration
pnpm --filter @repoarena/github-integration test:integration
pnpm --filter @repoarena/github-action test:e2e
pnpm --filter repoarena test:unit
pnpm test:integration
pnpm test:cloud-product-built
pnpm format:check
pnpm lint
pnpm typecheck
pnpm skills:validate
pnpm verify
```

Production hosted provisioning is implemented behind the HTTPS provisioner
contract and normal verification never creates infrastructure. The credential-
gated live smoke was not run:
`IMPLEMENTED_AND_CONTRACT_VERIFIED_LIVE_CREDENTIALS_UNAVAILABLE`.
