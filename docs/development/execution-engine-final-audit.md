# Execution-engine final audit

Audit date: 2026-08-31. Public evidence is deterministic and offline. The
implementation specification index intentionally keeps evaluator-private
material out of repository documentation.

| Requirement | Production implementation | Behavioral evidence | Verification command | Status |
| --- | --- | --- | --- | --- |
| Attempt state machine and audited transitions | `packages/runner-core/src/index.ts` | runner lifecycle and illegal-transition tests | `pnpm --filter @repoarena/runner-core test:unit` | VERIFIED |
| Clean attempt workspace and base isolation | runner, Git abstraction | repetitions and connected benchmark fixtures | `pnpm --filter @repoarena/benchmark-engine test:unit` | VERIFIED |
| Bounded argv process supervision | runner and local sandbox | injection, timeout, cancellation, huge-output tests | focused runner, sandbox, benchmark suites | VERIFIED |
| Process-tree cancellation | runner and local sandbox process groups | active cancellation heartbeat E2E | benchmark cancellation E2E | VERIFIED |
| Sandbox provider routing | runner factory, benchmark engine, CLI | built CLI default-local execution | `pnpm --filter repoarena test:unit` | VERIFIED |
| Local sandbox environment boundary | `packages/sandbox-local` | host credential, output, cancellation tests | `pnpm --filter @repoarena/sandbox-local test:unit` | VERIFIED |
| Docker restrictive provider contract | `packages/sandbox-docker` | argv contract, network-off, no secret-in-argv assertions | `pnpm --filter @repoarena/sandbox-docker test:unit` | VERIFIED |
| Live Docker container lifecycle | Docker provider | daemon capability probe documents unavailable daemon | capability-gated integration | LIVE_DOCKER_INTEGRATION_BLOCKED_BY_ENVIRONMENT |
| Agent adapter SDK and four production adapters | adapter SDK and Codex, Claude Code, Gemini CLI, OpenCode packages | workspace strict builds and production registry inspection | `pnpm typecheck`; CLI adapter registry E2E | VERIFIED |
| Agent/private evaluator phase exclusion | runner phase coordinator and benchmark singleton | synchronized two-agent phase-gate E2E | benchmark cancellation E2E | VERIFIED |
| Separate private evaluator workspace | runner | patch-before-private and hidden sentinel tests | runner and security E2E suites | VERIFIED |
| Reference solution privacy | task private boundary, runner, public schemas | recursive report/persistence sentinel scan | benchmark security E2E | VERIFIED |
| Public verification | runner sandbox execution | multiple argv verification and evidence tests | runner and benchmark suites | VERIFIED |
| Safe hidden summary | evaluator public projection, run-store schema | private assertion serializer tests and report scans | evaluator and security suites | VERIFIED |
| Central behavior decision matrix | evaluator | solved, public/private failure, regression, integrity, crash, timeout, infrastructure, cancellation table | `pnpm --filter @repoarena/evaluator test:unit` | VERIFIED |
| Integrity and anti-cheating | integrity package and runner wiring | test deletion and verification tampering connected cases | integrity, runner, benchmark suites | VERIFIED |
| Regression result domain | evaluator and persisted attempt schema | hidden/public failure and typed regression decision tests | evaluator and benchmark suites | VERIFIED |
| NUL-safe patch/change capture | Git abstraction and runner | untracked plus space, tab, newline, Unicode, leading-dash filenames | Git, runner, security suites | VERIFIED |
| Safe artifact manifests | artifacts and runner | traversal, absolute escape, symlink, limits, secret-safe hash tests | `pnpm --filter @repoarena/artifacts test:unit`; security E2E | VERIFIED |
| Secret scoping and redaction | redaction, runner, artifact sanitizer | stdout/stderr, patch, artifact hash, persistence and reporter scans | redaction, runner, security suites | VERIFIED |
| Repetitions and multiple agents | benchmark engine | clean repetitions, two agents, built CLI test registry | benchmark and CLI E2E | VERIFIED |
| Bounded concurrency and deterministic order | benchmark worker pool | overlap/barrier, maximum concurrency and canonical ordering | benchmark and CLI E2E | VERIFIED |
| Provider/infrastructure retry semantics | benchmark engine and run-store retry events | separate budgets/backoff and one-logical-attempt assertion | benchmark retry suite | VERIFIED |
| Cancellation semantics | evaluator, runner, benchmark, run-store | active process cancellation and atomic persisted cancelled run | benchmark cancellation E2E | VERIFIED |
| Atomic run persistence | run store | write/replace/corrupt tests and concurrent snapshots | `pnpm --filter @repoarena/run-store test:unit` | VERIFIED |
| Interrupted/corrupt recovery inspection | run store | completed-attempt preservation and clean-restart connected tests | run-store and benchmark recovery suites | VERIFIED |
| Pass@k and statistics | statistics and benchmark aggregation | edge fixtures and real-attempt aggregation | `pnpm --filter @repoarena/statistics test:unit`; benchmark suite | VERIFIED |
| Usage normalization | adapter SDK, pricing, benchmark engine | available/partial/unavailable usage tests and propagation | pricing and benchmark suites | VERIFIED |
| Versioned cost snapshots | pricing and run-store | persisted pricing identity and usage snapshot | pricing and benchmark suites | VERIFIED |
| Historical cost immutability | pricing, benchmark, run store, reporter | V1 persist/reload/report then V2 new-run test | benchmark historical-cost test | VERIFIED |
| Terminal report | reporter | connected public run and forbidden-sentinel checks | reporter and security suites | VERIFIED |
| JSON report | reporter | schema/provenance and recursive sentinel checks | reporter and security suites | VERIFIED |
| Standalone HTML report | reporter | connected report and script/markup escaping | reporter and security suites | VERIFIED |
| JUnit report | reporter | solved/failure/infrastructure mappings and privacy checks | reporter and benchmark suites | VERIFIED |
| Cross-report canonical consistency | reporter consumes `PersistedRun` | historical-cost reload and public surface scan | reporter and benchmark suites | VERIFIED |
| Production `repoarena run` path | CLI, benchmark engine, runner, sandbox, evaluator, reporter | external-process solved and unsolved runs | `pnpm --filter repoarena test:unit` | VERIFIED |
| CLI exit semantics and safe output paths | CLI | informational unsolved, `--ci`, invalid agent/sandbox and traversal tests | CLI external-process E2E | VERIFIED |
| CLI adapter inspection | CLI production registry | list/detect/inspect safety test | CLI registry E2E | VERIFIED |
| Deterministic adversarial matrix | benchmark security fixtures | perfect, wrong, no-op, partial, test deletion, hidden search, secret leak, timeout, crash, huge output and tampering | benchmark E2E suites | VERIFIED |
| Built CLI multi-agent/repetition E2E | CLI double-gated deterministic adapters | four logical attempts, parallel execution, stable ordering | CLI external-process E2E | VERIFIED |
| Paid-call exclusion | deterministic fake/command adapters | workspace verification contains no paid provider invocation | `pnpm verify` | VERIFIED |
| Repository-local execution skills | runner, security, testing skills | skill schema validation | `pnpm skills:validate` | VERIFIED |
| Unfinished-code scan | execution packages and closeout docs | required unfinished-marker scan | repository `rg` closeout command | VERIFIED |
| Full workspace gate | all workspace packages | format, lint, builds, strict typecheck, unit and connected E2E | `pnpm verify` | VERIFIED |

## Explicit built CLI evidence

The built `packages/cli/dist/index.js` executable is invoked as a child process
by `packages/cli/src/index.test.ts` and `packages/cli/src/run.e2e.test.ts`.
Closeout also executes a generated temporary Git fixture directly with
`node packages/cli/dist/index.js run --agent fake-perfect --report
terminal,json,html,junit --output reports --json` under the doubly gated,
deterministic test registry.
