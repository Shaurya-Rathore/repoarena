# RepoArena contributor guide

Read the relevant sections of `docs/spec/IMPLEMENTATION_BIBLE.txt` before a
substantial change. Keep TypeScript strict, add behavior tests with changes,
and run `pnpm verify` before handoff. Treat benchmark agents and repository
code as untrusted: do not expose secrets, hidden evaluators, or reference fixes
to attempt workspaces. Use deterministic canonical hashing for persisted
protocol values. Do not edit released migrations.
