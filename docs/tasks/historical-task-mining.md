# Historical task mining

Discover candidates from Git history:

```sh
repoarena tasks discover --limit 20 --json
repoarena tasks generate <commit-sha>
repoarena tasks validate-history <task-id> --json
```

Discovery is a deterministic heuristic: it exposes scores and evidence rather
than claiming a commit is certainly a benchmark task. Generated public task
files contain only agent-visible data. Reference patches, reference revisions,
and evaluator artifacts are stored separately under local state and must never
be given to an agent.

Task documents use `repoarena.task/v1`. Use `tasks inspect`, `format`,
`migrate`, `import`, and `export` to maintain them. Shell-form commands are
explicitly marked; argv commands are preferred.
