# Intended atomic commits

| Title | Files changed | Reason | Tests passed |
| --- | --- | --- | --- |
| `chore(repo): establish local-first foundation` | root tooling, core/config/task/runner/reporter/readiness/CLI | Initial working baseline | `pnpm verify` |
| `docs(development): add implementation ledger and Codex workflows` | `docs/development`, `.agents/skills`, `scripts/validate-skills.mjs` | Persistent execution status and recurring operating knowledge | `pnpm skills:validate` |
| `feat(git): add deterministic repository boundary` | `packages/git`, lockfile | Safe argv-only Git APIs and temporary repository fixtures | `pnpm --filter @repoarena/git test:unit` |
| `feat(tasks): add historical task mining foundation` | task spec, discovery, reconstruction, leakage, validation, CLI | Canonical task v1 and initial historical task workflow | `pnpm verify` |
| `feat(execution): add sandbox providers and redaction` | sandbox-local, sandbox-docker, redaction | Isolated command execution, Docker contract, secret redaction | focused sandbox/redaction tests |
