# GitHub integration

RepoArena's GitHub integration has two independent entry points: a GitHub App
drives cloud automation and Checks, while `actions/repoarena` runs the verified
local execution engine inside GitHub Actions. Both remain BYOK by default.

## GitHub App setup

Configure `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, and
`GITHUB_WEBHOOK_SECRET`; the private key may contain literal `\\n` separators.
Set the webhook URL to `POST /api/v1/github/webhooks`. Required permissions are
repository metadata read, contents read, and Checks write. Pull requests read
and issues write are needed only when managed PR summaries are enabled. Subscribe
only to `installation`, `installation_repositories`, `push`, and `pull_request`.

Linking an installation is an authenticated organization-owner operation. A
GitHub numeric installation ID is never accepted as tenant authority. Repository
synchronization keys on GitHub's stable repository ID, so rename and transfer
metadata can change without changing authorization identity. Suspension and
uninstall immediately invalidate cached installation tokens and prevent new
operations while historical runs remain retained.

The API verifies the HMAC over bounded raw bytes before JSON parsing, persists a
unique delivery ID, and queues `GITHUB_WEBHOOK` work. Run
`pnpm cloud:github-webhooks` alongside the cloud API to process it. Transient and
secondary-rate-limit failures use bounded durable retry; permanent failures go
to the job dead-letter state. GitHub installation tokens are opaque, short-lived,
memory-only values and are refreshed without request stampedes.

## Trigger and fork policy

Trigger policies bind a repository to an immutable benchmark version and bound
attempt, cost, and runtime. Policies can enable default-branch pushes, pull
requests, draft handling, branch globs, and path globs. Incomplete GitHub path
evidence is never interpreted as "no relevant changes." Duplicate delivery
processing cannot create another run or Check.

Fork pull requests default to `SKIP`. The optional `UNPRIVILEGED` decision is
recorded in provenance, but callers must still use a secret-free runner profile.
Never pass installation credentials, provider keys, private evaluators, or
organization secrets to fork-controlled code. GitHub summaries receive only the
execution engine's canonical public projection.

Checks follow `queued` → `in_progress` → `completed` and are mapped from the
canonical outcome. RepoArena updates one mapped Check Run and one marked PR
comment, preventing retry and synchronization spam.

## GitHub Action

```yaml
permissions:
  contents: read
  id-token: write # only for OIDC cloud publication
steps:
  - uses: actions/checkout@v4
  - uses: Shaurya-Rathore/repoarena@v1
    with:
      agents: codex
      runs-per-task: "2"
      parallelism: "2"
      fail-on-unsolved: "true"
      max-attempts: "20"
      max-cost-micros: "5000000"
```

For a local/BYOK run, configure provider credentials using that provider's
documented GitHub Secret environment variables. RepoArena does not proxy them.
Set `fail-on-unsolved: false` for informational comparisons. Multi-agent runs use
`agents: codex,claude-code`; task selection uses `tasks: task-a,task-b`.

Cloud publication requires `publish-cloud: true`, `cloud-endpoint`, and a
pre-created canonical `cloud-run-id`. Prefer GitHub OIDC. An organization owner
creates a trust bound to the stable GitHub repository ID, audience, allowed refs,
and optionally a workflow pattern. RepoArena validates issuer, audience,
repository ID, ref, workflow, issue/expiry time, and one-time `jti`, then returns
a short-lived repository/run-scoped credential. A scoped cloud API key is the
fallback via `REPOARENA_CLOUD_API_KEY`; it is never written to Action outputs.

For public repositories, run pull-request benchmarks without secrets or use a
trusted post-merge/workflow-dispatch job. GitHub does not expose normal secrets
to fork workflows, and workflows must not work around that protection. Scheduled
workflows and `workflow_dispatch` use the same Action inputs. Report files are
written under the workspace and can be uploaded with `actions/upload-artifact`.

## Development and operations

Normal tests use signed fixtures, a deterministic GitHub API provider, real
PostgreSQL, and the bundled Action process. They neither call paid models nor
mutate GitHub. A live smoke test is opt-in with
`REPOARENA_REAL_GITHUB_TESTS=1` plus an explicitly designated test installation
and repository; it must never run as part of `pnpm verify`.

Rate-limit errors retain safe categories and retry metadata. Logs and audit
events include delivery/run correlation but never authorization headers, private
keys, webhook secrets, installation tokens, Action credentials, provider keys,
or evaluator-private values.
