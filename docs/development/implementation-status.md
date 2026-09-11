# RepoArena 1.0 implementation status

Updated: 2026-09-08. A state of `VERIFIED` means the listed command passed in
this workspace; all other states are deliberately conservative.

Canonical integrated product base: `integration/repoarena-1.0`.
Release candidate branch: `release/repoarena-1.0`.
OSS launch-polish branch: `release/oss-launch`.

- `EXECUTION_ENGINE = VERIFIED`
- `LOCAL_PRODUCT = VERIFIED`
- `CLOUD_CORE = VERIFIED`
- `GITHUB_INTEGRATION = VERIFIED`
- `CLOUD_PRODUCT = VERIFIED`
- `BILLING = VERIFIED`
- `HOSTED_RUNNERS = VERIFIED`
- `RELEASE_ENGINEERING = VERIFIED`
- `OSS_ADOPTION_LAUNCH_POLISH = VERIFIED`
- `CODEX_LIVE_ADAPTER = VERIFIED`

**Execution engine: VERIFIED.** Detailed evidence is recorded in
`docs/development/execution-engine-final-audit.md`.

**Local product: VERIFIED.** Detailed localhost product, readiness, optimizer,
and consistency evidence is recorded in
`docs/development/local-product-final-audit.md`.

**Cloud core: VERIFIED.** Detailed PostgreSQL, API, queue, runner, storage, and
security evidence is recorded in `docs/development/cloud-core-final-audit.md`.

**GitHub integration: VERIFIED.** Detailed App, webhook, Checks, Actions, OIDC,
PostgreSQL, and security evidence is recorded in
`docs/development/github-integration-final-audit.md`.

**Cloud product: VERIFIED.** Authenticated organization workflows, public
publishing, leaderboard/badges, security boundaries, and connected product
evidence are recorded in `docs/development/cloud-product-final-audit.md`.
Canonical subsystem state: `CLOUD_PRODUCT = VERIFIED`.

| Subsystem | State | Files / tests | Verification | Current result / remaining work |
| --- | --- | --- | --- | --- |
| Foundation and package boundaries | VERIFIED | `package.json`, `tsconfig.base.json`, `packages/core`; core tests | `pnpm verify` | Strict workspace, canonical JSON/hash and typed errors pass. Add package-boundary enforcement and full error catalog. |
| Configuration and environment | VERIFIED | `packages/config`, local-product API/UI; atomic round-trip and mutation tests | config/local-product suites; `pnpm verify` | Root config parses and safe updates validate before atomic replacement; the local UI edits only validated non-secret project settings. |
| Git abstraction and fixtures | VERIFIED | `packages/git`; generated-temp Git tests | `pnpm --filter @repoarena/git test:unit && pnpm --filter @repoarena/git typecheck` | NUL-safe history, diffs, paths, remotes and worktree interface tested in temporary repositories. Add fixture catalog and CLI wiring. |
| Task specification and lifecycle | VERIFIED | `packages/task-spec`, CLI task commands; schema/migration/privacy tests | task-spec and packed CLI release E2E | Canonical v1, migration, serialization, creation, import, and public/private boundaries pass. |
| Historical task mining and reconstruction | VERIFIED | `packages/task-discovery`, `packages/task-reconstruction`, `packages/leakage` | focused suites, built CLI and release gate | Deterministic static scoring, reconstruction, leakage analysis, and CLI discovery are release verified. |
| Task validation and hidden evaluation | VERIFIED | `packages/task-validation`, runner/evaluator private phase | focused suites and integrated private-evaluator E2E | Base/reference validation and private hook materialization preserve the agent boundary. |
| Runner lifecycle and local state | VERIFIED | runner, benchmark engine, run store, Git, integrity; lifecycle/concurrency/persistence/recovery/cancellation/CLI E2E | focused execution suites; `pnpm verify` | Connected lifecycle, clean repetitions, retries, cancellation, atomic persistence, clean recovery, and deterministic aggregation pass. |
| Sandbox and execution security | VERIFIED | local/Docker sandboxes, redaction, runner, artifacts | focused sandbox/redaction/artifact/security E2E; `pnpm verify` | Local sandbox is wired into the production CLI; process trees, private phases, paths, artifacts, environment, output, and secrets are constrained. Docker is contract-tested; live daemon execution is environment-blocked. |
| Agent adapter SDK and Codex/Claude/Gemini/OpenCode adapters | VERIFIED | adapter SDK, four adapters, production CLI registry | workspace builds/typechecks; CLI adapter-registry E2E; `pnpm verify` | Four production CLI adapters are registered, detectable, noninteractive, and supervised. Paid live invocations remain opt-in. |
| Evaluation, metrics and statistics | VERIFIED | evaluator, statistics, runner/benchmark E2E | evaluator/statistics/benchmark suites; `pnpm verify` | Central behavior decisions, safe private projection, integrity precedence, pass@k, duration distribution, confidence, cost/churn, retry accounting, and adversarial cases pass. |
| Pricing and cost accounting | VERIFIED | pricing, benchmark engine, run store, reporter | pricing and connected historical-cost report-reload suites; `pnpm verify` | Versioned lookup, explicit availability, immutable persisted snapshots, usage propagation, and V1→V2 historical report immutability pass. |
| Reporting | VERIFIED | reporter, benchmark and CLI connected E2E | reporter, security E2E, built CLI E2E; `pnpm verify` | Terminal, JSON, standalone escaped HTML, and JUnit consume one canonical public run and exclude secrets, hidden evaluators, and reference fixes. |
| Repository readiness | VERIFIED | `packages/readiness`, CLI doctor, local-product history/UI; deterministic excellent/adversarial fixtures | readiness, CLI and local-product suites; `pnpm verify` | Eight weighted categories emit stable explainable findings across setup, tests, docs, environment, dependencies, fixtures, complexity, and agent guidance; atomic CLI/UI history is consistent. |
| Optimization engine | VERIFIED | optimizer, built CLI connected trial fixture, local-product candidate UI | optimizer, CLI and local-product suites; `pnpm verify` | Capability-constrained grid search executes real benchmark trials, persists history, compares baseline/Pareto candidates, enforces budgets/cache/cancellation, retains holdout provenance, and exports profiles. |
| Local product UI | VERIFIED | localhost server/API/assets plus built CLI server E2E | local-product and CLI suites; explicit built-product E2E; `pnpm verify` | `repoarena ui` launches the localhost-only typed API/application with onboarding, tasks, bounded history, run/attempt/diff evidence, comparisons, readiness, optimizer and configuration flows. |
| Cloud database and migrations | VERIFIED | `packages/cloud-db`, migrations 0001–0008, guarded PostgreSQL fixtures | cloud-db unit/integration; backup/restore release drill | PostgreSQL 18 fresh/upgrade migration, compatibility classification, constraints, rollback, advisory locking, and restore pass. |
| Cloud API and API client | VERIFIED | `packages/cloud-api`, `packages/cloud-api-client` | API/client unit, typecheck and real-Postgres E2E | Versioned validated API, safe errors, pagination, CSRF, idempotency, OpenAPI contract and typed client pass. |
| Authentication, organizations and RBAC | VERIFIED | cloud-core sessions, API keys, organizations, memberships, entitlements | cloud-core/API real-Postgres security suites | Opaque hashed tokens, revocation, centralized roles, current entitlements and cross-tenant denial pass. |
| Jobs, worker and schedules | VERIFIED | jobs/schedules schema, `packages/cloud-worker`, cloud-core queue services | concurrent cloud-core PostgreSQL suite | SKIP LOCKED claims, leases, reclaim, retry/dead-letter and occurrence-idempotent scheduling pass. |
| Runner registration and hosted execution | VERIFIED | cloud-core runner protocol and ephemeral job credentials | runner capability/exclusivity/result-replay integration | Registration, revocation, heartbeat, staleness, compatible claim and safe idempotent result submission pass. |
| Object storage and artifacts | VERIFIED | `packages/object-storage`, cloud `ArtifactService`, artifact metadata/retention schema | object-storage contract and cloud-core artifact integration | Server-generated tenant keys, checksum/size finalization, scoped reads and evaluator-private denial pass. |
| GitHub App and Actions | VERIFIED | GitHub provider/integration, cloud API, Action, migration 0003, connected tests | focused GitHub/Action/API suites; real PostgreSQL; `pnpm verify` | App JWT/token lifecycle, tenant-safe installation sync, signed durable webhooks, trigger policy, Checks/comments, bundled Action, OIDC, fork/budget/security boundaries pass. |
| Public publishing, pages, badges and leaderboard | VERIFIED | `packages/public-publishing`, cloud product/API, migrations 0004 and 0006 | publishing unit/PostgreSQL integration; product unit/E2E | Explicit immutable projections, private identity redaction, unpublish, comparability policy, share pages, stable repository profiles and SVG badges pass. |
| Billing and entitlements | VERIFIED | `packages/billing`, `packages/billing-stripe`, migration 0007, cloud API/product | Stripe provider/unit contracts, signed webhook and real-PostgreSQL billing/API E2E; `pnpm verify` | Owner-scoped Checkout/Portal, durable idempotent reconciliation, invoices, lifecycle policies and canonical entitlement synchronization pass while BYOK model costs remain separate. |
| Hosted runners and compute control plane | VERIFIED | `packages/hosted-compute`, migration 0008, cloud API/product, operator scripts | provider unit contracts and real-PostgreSQL lifecycle/capacity/security integration; `pnpm verify` | Optional hosted mode uses the canonical runner protocol with versioned limits, transactional capacity/budgets, ephemeral credentials, immutable metering, timeout/cancellation and conservative orphan cleanup. |
| Cloud frontend | VERIFIED | `packages/cloud-product`, `packages/public-publishing`, cloud API/core extensions | product unit/real-PostgreSQL E2E, explicit built-server smoke, publishing/security suites | Same-origin production application, authenticated management surfaces, explicit public sharing, comparable leaderboard and stable badges are connected. |
| Observability, security and operations | VERIFIED | health/readiness, safe logs/metrics/audit/rate limits, operator scripts and runbooks | cloud integrations, sentinel matrix, `release:verify` | Dependency-aware readiness, correlation, bounded diagnostics, alerts, backup/restore, incident and disaster procedures are release verified. |
| Deployment, CI and release | VERIFIED | production config validator, least-privilege workflows, package/dry-run/clean-checkout tooling | `pnpm release:verify` | Frozen clean checkout, standalone CLI, Action bundle, checksums, supply-chain gates, migrations and production smoke pass without publishing. |
| Documentation | VERIFIED | launch README, product docs, deployment, examples, operations, release notes and audits | command/link review and release gate | User, contributor, operator, recovery, security, and release paths describe tested behavior. |

## Environment constraints

Git writes are available on the active feature branch. Docker CLI is installed,
but its daemon is unavailable locally; live Docker integration is consequently
blocked by the environment while provider contract tests remain required.
