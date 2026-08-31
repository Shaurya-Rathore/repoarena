# RepoArena 1.0 implementation status

Updated: 2026-08-31. A state of `VERIFIED` means the listed command passed in
this workspace; all other states are deliberately conservative.

**Execution engine: VERIFIED.** Detailed evidence is recorded in
`docs/development/execution-engine-final-audit.md`.

| Subsystem | State | Files / tests | Verification | Current result / remaining work |
| --- | --- | --- | --- | --- |
| Foundation and package boundaries | VERIFIED | `package.json`, `tsconfig.base.json`, `packages/core`; core tests | `pnpm verify` | Strict workspace, canonical JSON/hash and typed errors pass. Add package-boundary enforcement and full error catalog. |
| Configuration and environment | IN_PROGRESS | `packages/config`; atomic round-trip tests | config unit suite and typecheck | Root config parses and safe updates validate before atomic replacement. UI/API integration remains. |
| Git abstraction and fixtures | VERIFIED | `packages/git`; generated-temp Git tests | `pnpm --filter @repoarena/git test:unit && pnpm --filter @repoarena/git typecheck` | NUL-safe history, diffs, paths, remotes and worktree interface tested in temporary repositories. Add fixture catalog and CLI wiring. |
| Task specification and lifecycle | IN_PROGRESS | `packages/task-spec`, CLI task commands; schema/migration/privacy tests | `pnpm --filter @repoarena/task-spec test:unit` | Canonical v1, migration and serialization boundary implemented. Expand malformed-input and CLI integration coverage. |
| Historical task mining and reconstruction | IN_PROGRESS | `packages/task-discovery`, `packages/task-reconstruction`, `packages/leakage` | focused package tests and `repoarena tasks discover --json` | Deterministic static scoring, reconstruction and leakage analysis are implemented. Expand fixture graph and discovery edge-case coverage. |
| Task validation and hidden evaluation | IN_PROGRESS | `packages/task-validation` | `pnpm --filter @repoarena/task-validation typecheck` | Base/reference worktree validation is implemented. Add behavioral fixture coverage and hidden-hook materialization. |
| Runner lifecycle and local state | VERIFIED | runner, benchmark engine, run store, Git, integrity; lifecycle/concurrency/persistence/recovery/cancellation/CLI E2E | focused execution suites; `pnpm verify` | Connected lifecycle, clean repetitions, retries, cancellation, atomic persistence, clean recovery, and deterministic aggregation pass. |
| Sandbox and execution security | VERIFIED | local/Docker sandboxes, redaction, runner, artifacts | focused sandbox/redaction/artifact/security E2E; `pnpm verify` | Local sandbox is wired into the production CLI; process trees, private phases, paths, artifacts, environment, output, and secrets are constrained. Docker is contract-tested; live daemon execution is environment-blocked. |
| Agent adapter SDK and Codex/Claude/Gemini/OpenCode adapters | VERIFIED | adapter SDK, four adapters, production CLI registry | workspace builds/typechecks; CLI adapter-registry E2E; `pnpm verify` | Four production CLI adapters are registered, detectable, noninteractive, and supervised. Paid live invocations remain opt-in. |
| Evaluation, metrics and statistics | VERIFIED | evaluator, statistics, runner/benchmark E2E | evaluator/statistics/benchmark suites; `pnpm verify` | Central behavior decisions, safe private projection, integrity precedence, pass@k, duration distribution, confidence, cost/churn, retry accounting, and adversarial cases pass. |
| Pricing and cost accounting | VERIFIED | pricing, benchmark engine, run store, reporter | pricing and connected historical-cost report-reload suites; `pnpm verify` | Versioned lookup, explicit availability, immutable persisted snapshots, usage propagation, and V1→V2 historical report immutability pass. |
| Reporting | VERIFIED | reporter, benchmark and CLI connected E2E | reporter, security E2E, built CLI E2E; `pnpm verify` | Terminal, JSON, standalone escaped HTML, and JUnit consume one canonical public run and exclude secrets, hidden evaluators, and reference fixes. |
| Repository readiness | IN_PROGRESS | `packages/readiness`; deterministic excellent/adversarial fixtures | readiness unit suite and typecheck | Eight weighted categories emit stable explainable findings across setup, tests, docs, environment, dependencies, fixtures, complexity, and agent guidance. CLI/UI persistence remains. |
| Optimization engine | IN_PROGRESS | `packages/optimizer`; deterministic domain fixtures | optimizer unit suite and typecheck | Capability-constrained grid search, baseline deltas, Pareto set, budgets, provenance cache, cancellation, holdout provenance, and profile export pass. Benchmark/CLI/UI trial integration remains. |
| Local product UI | IN_PROGRESS | CLI `ui`; no browser test | `repoarena ui` | Serves result JSON as HTML. Replace with complete accessible local application. |
| Cloud database and migrations | NOT_STARTED | — | — | Implement PostgreSQL Drizzle schema, SQL migrations, upgrades, constraints and migration tests. |
| Cloud API and API client | NOT_STARTED | — | — | Implement validated REST/SSE APIs, pagination, idempotency, audit and OpenAPI. |
| Authentication, organizations and RBAC | NOT_STARTED | — | — | Implement GitHub OAuth, sessions, memberships and tenant isolation tests. |
| Jobs, worker and schedules | NOT_STARTED | — | — | Implement durable PostgreSQL queue, lease/heartbeat/retry/cron and worker recovery. |
| Runner registration and hosted execution | NOT_STARTED | — | — | Implement registration credentials, remote protocol, provider abstraction and contracts. |
| Object storage and artifacts | IN_PROGRESS | `packages/artifacts`, `packages/runner-core`, `packages/run-store`; artifact containment/integration tests | `pnpm --filter @repoarena/artifacts test:unit && pnpm --filter @repoarena/artifacts typecheck`; runner unit suite | Safe local manifest collection rejects traversal/symlinks and enforces limits; allowlisted manifests now flow through isolated attempts into persisted results. Add persistent object storage and retention. |
| GitHub App and Actions | NOT_STARTED | — | — | Implement verified idempotent webhooks, sync, checks, action and regression workflow. |
| Public publishing, pages, badges and leaderboard | NOT_STARTED | — | — | Implement signed/redacted manifests, aggregation, public routes, badge and cache policy. |
| Billing and entitlements | NOT_STARTED | — | — | Implement Stripe provider, webhooks, checkout/portal, plan limits and mock contracts. |
| Cloud frontend | NOT_STARTED | — | — | Implement Next.js product routes, API integration, accessibility and E2E tests. |
| Observability, security and operations | NOT_STARTED | — | — | Implement logs, traces, health, rate limits, secret handling, threat tests and runbooks. |
| Deployment, CI and release | IN_PROGRESS | Compose only | `pnpm verify` | Local compose exists. Add images, deploy/IaC, CI, release validation, backups and docs. |
| Documentation | IN_PROGRESS | README, governance | `pnpm verify` | Basic quickstart exists. Add complete user, operations and architecture documentation. |

## Environment constraints

Git writes are available on the active feature branch. Docker CLI is installed,
but its daemon is unavailable locally; live Docker integration is consequently
blocked by the environment while provider contract tests remain required.
