# RepoArena 1.0 implementation status

Updated: 2026-08-30. A state of `VERIFIED` means the listed command passed in
this workspace; all other states are deliberately conservative.

| Subsystem | State | Files / tests | Verification | Current result / remaining work |
| --- | --- | --- | --- | --- |
| Foundation and package boundaries | VERIFIED | `package.json`, `tsconfig.base.json`, `packages/core`; core tests | `pnpm verify` | Strict workspace, canonical JSON/hash and typed errors pass. Add package-boundary enforcement and full error catalog. |
| Configuration and environment | IN_PROGRESS | `packages/config`; no dedicated test | `pnpm --filter @repoarena/config typecheck` | Root config parses. Add precedence, policy overlay, environment validation and migration. |
| Git abstraction and fixtures | VERIFIED | `packages/git`; generated-temp Git tests | `pnpm --filter @repoarena/git test:unit && pnpm --filter @repoarena/git typecheck` | NUL-safe history, diffs, paths, remotes and worktree interface tested in temporary repositories. Add fixture catalog and CLI wiring. |
| Task specification and lifecycle | IN_PROGRESS | `packages/task-spec`, CLI task commands; schema/migration/privacy tests | `pnpm --filter @repoarena/task-spec test:unit` | Canonical v1, migration and serialization boundary implemented. Expand malformed-input and CLI integration coverage. |
| Historical task mining and reconstruction | IN_PROGRESS | `packages/task-discovery`, `packages/task-reconstruction`, `packages/leakage` | focused package tests and `repoarena tasks discover --json` | Deterministic static scoring, reconstruction and leakage analysis are implemented. Expand fixture graph and discovery edge-case coverage. |
| Task validation and hidden evaluation | IN_PROGRESS | `packages/task-validation` | `pnpm --filter @repoarena/task-validation typecheck` | Base/reference worktree validation is implemented. Add behavioral fixture coverage and hidden-hook materialization. |
| Runner lifecycle and local state | IN_PROGRESS | `packages/runner-core`; no dedicated test | `pnpm --filter @repoarena/runner-core typecheck` | Minimal workspace command runner exists. Add state machine, recovery, artifacts, cancellation, cache and SQLite state. |
| Sandbox and execution security | IN_PROGRESS | `packages/sandbox-local`, `packages/sandbox-docker`, `packages/redaction` | focused sandbox/redaction tests | Local bounded process sandbox and restrictive Docker argv provider are tested; Docker daemon is unavailable locally. Wire providers/artifact and evaluator boundaries into runner. |
| Agent adapter SDK and Codex/Claude/Gemini/OpenCode adapters | NOT_STARTED | — | — | Implement common protocol, capability probes, production integrations, fake adapter and conformance suite. |
| Evaluation, metrics and statistics | IN_PROGRESS | `packages/evaluator`; evaluator behavior/privacy tests | `pnpm --filter @repoarena/evaluator test:unit && pnpm --filter @repoarena/evaluator typecheck` | Behavior-based decision table and explicit safe public projection pass. Wire trusted runner evidence, private evaluator lifecycle, regression/integrity engines and aggregation. |
| Pricing and cost accounting | NOT_STARTED | — | — | Implement versioned catalog, usage normalization and cost reports. |
| Reporting | IN_PROGRESS | `packages/reporter`; no dedicated test | `pnpm --filter @repoarena/reporter typecheck` | Safe minimal HTML exists. Add terminal, JUnit, comparison, cost and rank reports. |
| Repository readiness | IN_PROGRESS | `packages/readiness`; no dedicated test | `repoarena doctor --json` | Four dimensions exist. Add all documented evidence dimensions and tests. |
| Optimization engine | NOT_STARTED | — | — | Implement bounded search, holdout, caching, early stop and profile export. |
| Local product UI | IN_PROGRESS | CLI `ui`; no browser test | `repoarena ui` | Serves result JSON as HTML. Replace with complete accessible local application. |
| Cloud database and migrations | NOT_STARTED | — | — | Implement PostgreSQL Drizzle schema, SQL migrations, upgrades, constraints and migration tests. |
| Cloud API and API client | NOT_STARTED | — | — | Implement validated REST/SSE APIs, pagination, idempotency, audit and OpenAPI. |
| Authentication, organizations and RBAC | NOT_STARTED | — | — | Implement GitHub OAuth, sessions, memberships and tenant isolation tests. |
| Jobs, worker and schedules | NOT_STARTED | — | — | Implement durable PostgreSQL queue, lease/heartbeat/retry/cron and worker recovery. |
| Runner registration and hosted execution | NOT_STARTED | — | — | Implement registration credentials, remote protocol, provider abstraction and contracts. |
| Object storage and artifacts | IN_PROGRESS | `packages/artifacts`; artifact containment tests | `pnpm --filter @repoarena/artifacts test:unit && pnpm --filter @repoarena/artifacts typecheck` | Safe local manifest collection rejects traversal/symlinks and enforces limits. Add persistent object storage, retention, and runner integration. |
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
