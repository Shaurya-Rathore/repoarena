# RepoArena local product

RepoArena's local product keeps benchmark data on the developer machine. It
does not require RepoArena Cloud.

## Start a repository

```sh
repoarena init --yes
repoarena doctor
repoarena tasks discover --limit 20 --json
repoarena run --agent codex --runs-per-task 3 --parallel 2 --report terminal,json,html,junit
repoarena ui
```

`repoarena ui` binds to `127.0.0.1:4177` by default. `--host localhost` and
`--port <port>` are supported; non-loopback hosts are rejected. The server
serves a versioned `/api/v1` API and an API-backed application. It never sends
reference patches, private evaluator source, private paths, or credentials to
the browser.

## Product areas

- **Overview** explains fresh-repository, no-task, no-run, no-readiness, and
  no-optimizer states and summarizes the latest canonical results.
- **Tasks** supports bounded search and filtering. Task detail contains the
  agent-visible prompt, policy, validation, and safe historical provenance.
- **Runs** supports bounded status/agent/model/date filtering. Run and attempt
  detail use persisted benchmark truth for outcomes, pass@k, cost, lifecycle,
  retries, diffs, bounded logs, verification, integrity, regressions, and
  public artifact metadata.
- **Compare** displays sample counts and warns when differing task evidence can
  make comparisons misleading.
- **Readiness** displays deterministic category scores, evidence, remediation,
  and local history. The same result is written by `repoarena doctor --json`.
- **Optimizer** runs capability-constrained deterministic trials through the
  benchmark engine, shows baseline/candidate evidence and Pareto-aware
  recommendations, and exports a versioned profile without overwriting config.
- **Configuration** validates the project config before an atomic replacement.

## Readiness

`repoarena doctor` prints a human-oriented score, category totals, evidence,
and remediation. `repoarena doctor --json` emits the canonical
`repoarena.readiness/v1` record. Results are stored under
`.repoarena/state/readiness/` using atomic replacement.

The score is deterministic and covers setup, tests, documentation,
environment, dependencies and services, fixtures, repository complexity, and
agent guidance. Missing evidence is a finding; it is never silently converted
to a perfect score.

## Optimizer

Create a search-space file:

```yaml
schema: repoarena.optimizer-search/v1
dimensions:
  - agent: codex
    models: [gpt-5]
    reasoning: [low, medium, high]
tasks: [fix-parser, fix-cache]
objectives: [correctness, cost, duration]
budget:
  max_trials: 3
  max_attempts: 12
```

Then run:

```sh
repoarena optimize --search-space optimizer.yaml \
  --output .repoarena/optimizer-result.json \
  --profile .repoarena/recommended-profile.yaml
```

Grid enumeration is deterministic. Adapter dimensions exclude invalid
combinations. Budgets constrain trials, attempts, cost, and wall time. Cache
keys include repository commit, tasks, runner version, and the complete
candidate configuration. Recommendations retain their baseline, deltas,
sample count, objectives, Pareto set, and holdout provenance. Tests use gated
fake adapters; paid provider calls are never part of `pnpm verify`.

## Storage, recovery, and troubleshooting

Local state lives under `.repoarena/state/`: benchmark runs in `runs/`,
readiness scans in `readiness/`, optimizer runs in `optimizations/`, and trusted
private evaluator inputs in `private/`. Browser APIs expose only public-safe
projections. Corrupt benchmark records are not fabricated into history.

If the UI reports no data, run `repoarena init --yes`, `repoarena doctor`, and
`repoarena tasks list --json` from the repository root. If an adapter is
unavailable, use `repoarena agents detect` and `repoarena agents inspect
<name>`. Real-agent execution consumes provider resources and remains an
explicit user action.
