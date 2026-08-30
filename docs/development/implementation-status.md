# RepoArena 1.0 implementation status

Updated: 2026-08-30. A state of `VERIFIED` means the listed command passed in
this workspace; all other states are deliberately conservative.

| Subsystem | State | Files / tests | Verification | Current result / remaining work |
| --- | --- | --- | --- | --- |
| Foundation and package boundaries | VERIFIED | `package.json`, `tsconfig.base.json`, `packages/core`; core tests | `pnpm verify` | Strict workspace, canonical JSON/hash and typed errors pass. Add package-boundary enforcement and full error catalog. |
| Configuration and environment | IN_PROGRESS | `packages/config`; no dedicated test | `pnpm --filter @repoarena/config typecheck` | Root config parses. Add precedence, policy overlay, environment validation and migration. |
| Git abstraction and fixtures | VERIFIED | `packages/git`; generated-temp Git tests | `pnpm --filter @repoarena/git test:unit && pnpm --filter @repoarena/git typecheck` | NUL-safe history, diffs, paths, remotes and worktree interface tested in temporary repositories. Add fixture catalog and CLI wiring. |
| Task specification and lifecycle | IN_PROGRESS | `packages/task-spec`, CLI task commands; schema test | `pnpm --filter @repoarena/task-spec test:unit` | Basic schema/defaults parse. Implement full v1 contract, format/migrate/import/export/inspect and validation engine. |
| Historical task mining and reconstruction | NOT_STARTED | — | — | Implement candidate discovery, ranking, source sanitization, reconstruction and leakage scanning. |
| Task validation and hidden evaluation | NOT_STARTED | — | — | Implement isolated baseline/reference/hidden evaluator pipeline and security tests. |
| Runner lifecycle and local state | IN_PROGRESS | `packages/runner-core`; no dedicated test | `pnpm --filter @repoarena/runner-core typecheck` | Minimal workspace command runner exists. Add state machine, recovery, artifacts, cancellation, cache and SQLite state. |
| Sandbox and execution security | NOT_STARTED | — | — | Implement Docker/local backends, environment filtering, resource limits, archive/path defenses and regression tests. |
| Agent adapter SDK and Codex/Claude/Gemini/OpenCode adapters | NOT_STARTED | — | — | Implement common protocol, capability probes, production integrations, fake adapter and conformance suite. |
| Evaluation, metrics and statistics | NOT_STARTED | — | — | Implement evaluator, normalized outcomes, pass@k, confidence, reliability and evidence. |
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
| Object storage and artifacts | NOT_STARTED | — | — | Implement signed upload/download, checksums, retention and redaction. |
| GitHub App and Actions | NOT_STARTED | — | — | Implement verified idempotent webhooks, sync, checks, action and regression workflow. |
| Public publishing, pages, badges and leaderboard | NOT_STARTED | — | — | Implement signed/redacted manifests, aggregation, public routes, badge and cache policy. |
| Billing and entitlements | NOT_STARTED | — | — | Implement Stripe provider, webhooks, checkout/portal, plan limits and mock contracts. |
| Cloud frontend | NOT_STARTED | — | — | Implement Next.js product routes, API integration, accessibility and E2E tests. |
| Observability, security and operations | NOT_STARTED | — | — | Implement logs, traces, health, rate limits, secret handling, threat tests and runbooks. |
| Deployment, CI and release | IN_PROGRESS | Compose only | `pnpm verify` | Local compose exists. Add images, deploy/IaC, CI, release validation, backups and docs. |
| Documentation | IN_PROGRESS | README, governance | `pnpm verify` | Basic quickstart exists. Add complete user, operations and architecture documentation. |

## Environment constraints

The sandbox allows reading `.git` but rejects creation/writes to it. Git
behavior will be implemented and tested through injectable process fixtures;
atomic intended commits are recorded in `commit-plan.md` until the restriction
changes.
