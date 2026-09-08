# RepoArena

**CI for AI coding agents.**

**Find the best coding agent for your repo by replaying real historical bugs.**

RepoArena turns fixes from your Git history into repeatable benchmarks. It gives
each coding agent a clean checkout, keeps hidden verification out of the agent
workspace, and compares correctness, reliability, time, and cost.

```text
Example benchmark (deterministic demo data)

Agent          Tasks   Solved   pass@1   Median time   Model cost
fake-perfect   1       1        100%     0 ms          unavailable
fake-noop      1       0        0%       0 ms          unavailable

Reports: .repoarena/reports/<run>.json, <run>.html, <run>.xml
Next: repoarena ui
```

No account is required. Local runs use your existing agent CLI authentication,
and RepoArena Cloud is optional.

## Five-minute quick start

RepoArena 1.0 supports Node.js 24. After the npm release:

```sh
npm install --global repoarena

cd your-repository
repoarena init --yes
repoarena doctor
repoarena agents detect
repoarena tasks discover
```

Pick a discovered candidate with `repoarena tasks generate <commit-sha>`, or
author a task with `repoarena tasks new`. Then benchmark and open the local UI:

```sh
repoarena run --agent codex --report terminal,json,html,junit
repoarena ui
```

Until the npm package is published, contributors can use the tested source
install in [Contributing](CONTRIBUTING.md). The exact packaged flow above runs
in the release gate.

Want a zero-cost tour first? From a source checkout, run:

```sh
pnpm install --frozen-lockfile
pnpm demo
```

The demo creates a temporary Git repository with a small historical regression,
runs two deterministic test agents, and writes terminal, JSON, HTML, and JUnit
reports. It never contacts a model provider.

## Supported coding agents

| Agent | Prerequisite | Authentication | Adapter name |
| --- | --- | --- | --- |
| Codex | Install the Codex CLI | Sign in through Codex | `codex` |
| Claude Code | Install Claude Code | Sign in through Claude Code | `claude-code` |
| Gemini CLI | Install Gemini CLI | Sign in through Gemini CLI | `gemini-cli` |
| OpenCode | Install OpenCode | Use its configured provider authentication | `opencode` |

Run `repoarena agents detect` to see what is available. RepoArena normally uses
the agent's existing authentication; it does not ask you to copy provider keys
into RepoArena configuration. See the [agent guide](docs/agents.md) for setup and
troubleshooting.

## How it works

1. **Mine real bugs.** Task discovery finds candidate fixes in repository history.
2. **Reconstruct the task.** RepoArena records the buggy base, public prompt, and verification provenance.
3. **Run clean attempts.** Every agent starts from a disposable workspace under explicit sandbox, network, timeout, and budget policy.
4. **Verify privately.** Agent execution ends before hidden checks or reference material become accessible.
5. **Compare evidence.** Terminal, JSON, HTML, JUnit, and the local UI consume the same canonical run result.

## Local-first and BYOK

- Local CLI and UI work without RepoArena Cloud or an account.
- Model usage is paid directly through your existing provider credentials
  (BYOK); RepoArena does not resell those tokens.
- Local execution is the default, and cloud publication and hosted compute are
  off unless explicitly configured.
- Docker is optional. The five-minute workflow uses the local sandbox.

## Local UI and optimizer

`repoarena ui` starts a loopback-only product for repository readiness, tasks,
runs, attempts, diffs, comparisons, cost/time, and optimizer results. The
optimizer runs bounded searches through the same benchmark engine; it does not
reinterpret results or bypass budgets.

## GitHub Actions without RepoArena Cloud

The bundled Action runs locally in GitHub Actions and publishes reports without
a RepoArena account:

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
      - uses: repoarena/repoarena@v1
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
        with:
          agents: codex
          fail-on-unsolved: "true"
          reports: terminal,json,html,junit
```

Do not expose provider credentials to code from untrusted forks. Use
`workflow_dispatch`, trusted branches, or the fork-safe pattern in the
[GitHub Action guide](docs/github-action-oss.md).

## Security model

Repository code and coding agents are untrusted. Attempts run in disposable
workspaces; private evaluators and historical reference fixes are structurally
excluded from the agent phase and public reports. Local UI traffic is restricted
to loopback. See [Security](SECURITY.md) and the [local product guide](docs/local-product.md).

## Documentation

- [Install and agent setup](docs/agents.md)
- [Local product and UI](docs/local-product.md)
- [GitHub Action for OSS](docs/github-action-oss.md)
- [Example configuration](docs/examples/repoarena.config.yaml)
- [Contributing](CONTRIBUTING.md)
- [1.0 release notes](docs/release-notes-1.0.0.md)

Cloud, GitHub App, billing, and hosted runner documentation remains available
for operators, but none is required for the local OSS workflow.

RepoArena is licensed under [Apache-2.0](LICENSE).
