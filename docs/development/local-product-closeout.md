# Local product closeout

Updated: 2026-08-31.

| Area | Status | Evidence |
| --- | --- | --- |
| Local server, loopback binding, typed API, CSRF and safe errors | VERIFIED | `packages/local-product/src/index.ts`, local-product API tests, built CLI server E2E |
| Overview, onboarding, navigation and repository identity | VERIFIED | `packages/local-product/src/assets.ts`, shell/onboarding tests |
| Task list/detail and public/private boundary | VERIFIED | local-product task API and forbidden-sentinel tests |
| Run history/detail, attempts, diffs, logs and artifacts | VERIFIED | local-product and connected CLI fixtures |
| Agent/model comparison and accessible metric charts | VERIFIED | comparison route and semantic shell tests |
| Deterministic readiness, findings, scoring, CLI and UI | VERIFIED | readiness fixtures, CLI doctor tests, readiness API/UI tests |
| Optimizer model, grid, objectives, baseline and budgets | VERIFIED | optimizer unit tests |
| Optimizer cache, cancellation, holdout provenance and profile export | VERIFIED | optimizer unit tests and connected CLI optimizer trial |
| Optimizer UI and local history | VERIFIED | local-product optimizer API/UI tests |
| Configuration validation and atomic editing | VERIFIED | config round-trip tests and local configuration API/UI tests |
| Pagination, bounded details and responsive/accessibility states | VERIFIED | local-product API/UI tests |
| Local API/frontend security | VERIFIED | CSRF, loopback, private-data and escaping tests |
| Built local product startup and CLI/domain consistency | VERIFIED | `packages/cli/src/local-product.e2e.test.ts`, CLI connected suites |
| Documentation and repository skills | VERIFIED | `docs/local-product.md`, local-product ADR, updated skills |
