# GitHub Action for local/BYOK benchmarks

The RepoArena Action can benchmark in GitHub Actions without RepoArena Cloud.
It runs the checked-out repository with the selected agent, writes reports, and
sets CI status. `publish-cloud` defaults to `false`.

```yaml
name: RepoArena
on: [workflow_dispatch]
permissions:
  contents: read
jobs:
  benchmark:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11bd71901bbe5b1634ceea73d27597364c9af683
      - uses: Shaurya-Rathore/repoarena@v1
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
        with:
          agents: codex
          fail-on-unsolved: "true"
          reports: terminal,json,html,junit
          max-attempts: "20"
          max-duration-ms: "1800000"
```

Use the secret mechanism expected by your chosen coding-agent CLI. Model charges
are paid to that provider through your credentials, not to RepoArena.

## Fork-safe pull requests

GitHub does not pass normal repository secrets to workflows from forks, and a
workflow running fork-controlled code must never receive provider credentials.
Keep the benchmark job manual or restrict it to same-repository branches:

```yaml
on: pull_request
permissions:
  contents: read
jobs:
  benchmark:
    if: github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11bd71901bbe5b1634ceea73d27597364c9af683
      - uses: Shaurya-Rathore/repoarena@v1
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
        with:
          agents: codex
          max-attempts: "20"
```

Never switch this to `pull_request_target` and then execute untrusted fork code
with secrets. Review and manually run a trusted workflow instead.
