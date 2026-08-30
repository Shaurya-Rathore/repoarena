# Intended atomic commits

| Title | Files changed | Reason | Tests passed |
| --- | --- | --- | --- |
| `chore(repo): establish local-first foundation` | root tooling, core/config/task/runner/reporter/readiness/CLI | Initial working baseline | `pnpm verify` |
| `docs(development): add implementation ledger and Codex workflows` | `docs/development`, `.agents/skills`, `scripts/validate-skills.mjs` | Persistent execution status and recurring operating knowledge | `pnpm skills:validate` |
| `feat(git): add deterministic repository boundary` | `packages/git`, lockfile | Safe argv-only Git APIs and temporary repository fixtures | `pnpm --filter @repoarena/git test:unit` |
| `feat(tasks): add historical task mining foundation` | task spec, discovery, reconstruction, leakage, validation, CLI | Canonical task v1 and initial historical task workflow | `pnpm verify` |
| `feat(execution): add sandbox providers and redaction` | sandbox-local, sandbox-docker, redaction | Isolated command execution, Docker contract, secret redaction | focused sandbox/redaction tests |
| `feat(evaluator): add behavior-based result boundary` | `packages/evaluator`, lockfile, implementation ledger | Decide from public/private behavioral evidence and prevent private command evidence from entering public result structures | `pnpm --filter @repoarena/evaluator build && pnpm --filter @repoarena/evaluator test:unit && pnpm --filter @repoarena/evaluator typecheck` |
| `feat(artifacts): add safe manifest collector` | `packages/artifacts`, lockfile, implementation ledger | Constrain agent-declared artifacts to regular files under an attempt root | `pnpm --filter @repoarena/artifacts build && pnpm --filter @repoarena/artifacts test:unit && pnpm --filter @repoarena/artifacts typecheck` |
| `feat(integrity): add deterministic change policy` | `packages/integrity`, lockfile, implementation ledger | Detect protected-path edits, test deletion, and verification tampering from Git metadata | `pnpm --filter @repoarena/integrity build && pnpm --filter @repoarena/integrity test:unit && pnpm --filter @repoarena/integrity typecheck` |
