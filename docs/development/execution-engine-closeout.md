# Execution-engine closeout

This is the authoritative closeout checklist for the local execution engine.

| Requirement | Evidence | Status |
| --- | --- | --- |
| Connected attempt lifecycle and ordered state history | `packages/runner-core/src/index.test.ts`, `packages/benchmark-engine/src/index.test.ts` | VERIFIED |
| Clean workspaces, bounded concurrency, repetitions, deterministic ordering | benchmark and cancellation E2E suites | VERIFIED |
| Public verification and argv-safe execution | runner and security E2E suites | VERIFIED |
| Agent termination before evaluator-private materialization | runner implementation and phase-gate E2E | VERIFIED |
| Cross-attempt agent/private phase exclusion | `LocalAttemptPhaseCoordinator`, connected two-agent test | VERIFIED |
| Behavior evaluation and centralized decision matrix | evaluator suite | VERIFIED |
| Integrity and anti-tampering decisions | runner and connected adversarial matrix | VERIFIED |
| Patch capture, odd filenames, artifacts, traversal and symlink containment | Git, artifact, runner, and security E2E suites | VERIFIED |
| Secret redaction across patches, verification, artifact hashes, persistence, and reports | redaction, artifact, runner, and security E2E suites | VERIFIED |
| Local sandbox provider in the production CLI path | built-process CLI E2E with default `--sandbox local` | VERIFIED |
| Docker production provider and restrictive argv contract | Docker provider contract suite | VERIFIED |
| Live Docker daemon execution | Docker CLI is present but the daemon is unavailable | LIVE_DOCKER_INTEGRATION_BLOCKED_BY_ENVIRONMENT |
| Provider/infrastructure retries and logical-attempt accounting | benchmark retry suite | VERIFIED |
| Atomic persistence and interrupted/corrupt recovery inspection | run-store and connected recovery suites | VERIFIED |
| Cancellation, timeout, crash, and process-tree cleanup | sandbox, runner, and cancellation E2E suites | VERIFIED |
| Usage, immutable pricing snapshots, statistics, and pass@k aggregation | pricing, statistics, and historical-cost reload suites | VERIFIED |
| Terminal, JSON, standalone HTML, and JUnit reports | reporter and connected report safety suites | VERIFIED |
| Built CLI solved/unsolved/CI/multi-agent/repetition execution | CLI external-process E2E suites | VERIFIED |
| Public forbidden-sentinel and HTML injection checks | security E2E and reporter suites | VERIFIED |
| Offline deterministic verification without paid provider calls | workspace and CLI E2E suites | VERIFIED |
